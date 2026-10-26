'use strict';
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { createRecordStore, checkCommitReceipt } = require('./user-storage/recordStore');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { sessionValue, checkHash, IDLE_MS } = require('./user-storage/adminSessionStore');
const { content, fingerprint } = require('./userMigrationRehearsal');
const fail = code => Object.assign(new Error('관리자 세션의 저장 버전과 영수증을 확인해 주세요.'), { code });
const clone = value => decodeValue(encodeValue(value));
function checkSessionKey(key) {
  if (typeof key !== 'string' || !key.startsWith('session/')) throw fail('SESSION_WRITER_INVALID_KEY');
  const hash = key.slice(8); checkHash(hash); return hash;
}
function checkSessionCommand(op) {
  if (op.changes?.length !== 1 || op.details?.kind !== 'session' || !['set', 'touch', 'remove'].includes(op.details.action)) throw fail('SESSION_WRITER_INVALID_COMMAND');
  const entry = op.changes[0]; checkSessionKey(entry.key);
  if (entry.exists !== (op.details.action !== 'remove')) throw fail('SESSION_WRITER_INVALID_COMMAND');
  if (entry.exists) sessionValue(entry.value);
  if (op.details.action === 'touch' && (!Number.isSafeInteger(op.details.at) || op.details.at < 0 || typeof op.details.uid !== 'string')) throw fail('SESSION_WRITER_INVALID_COMMAND');
  return entry;
}
function inactive(op, current, now) {
  if (op.details?.action !== 'touch') return false;
  const value = current.value, at = Math.max(op.details.at, now());
  return !current.exists || value.uid !== op.details.uid || value.expiresAt <= at || at - value.lastActivity >= IDLE_MS;
}
function createSessionWriterAdapters({ db, database, timeoutMs = 10000, onAmbiguousWrite, now = Date.now }) {
  if (!db?.collection || !db?.runTransaction || typeof now !== 'function') throw fail('SESSION_WRITER_INVALID_DEPENDENCIES');
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const absent = key => ({ key, exists: false, token: '0' });
  const legacy = (() => {
    const bodies = db.collection('AdminWebSessions'), metadata = db.collection('adminSessionWriterMetadata'), receipts = db.collection('adminSessionWriterReceipts');
    const refs = key => { const hash = checkSessionKey(key); return { body: bodies.doc(hash), meta: metadata.doc(hash) }; };
    function observed(key, body, marker) {
      const meta = marker.data();
      if (meta && (meta.format !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 1
          || !Number.isSafeInteger(meta.generation) || meta.generation < 0 || meta.generation > meta.revision
          || typeof meta.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(meta.digest))) throw fail('SESSION_WRITER_INVALID_METADATA');
      const entry = body.exists ? { key, exists: true, token: `u:${body.updateTime.seconds}:${body.updateTime.nanoseconds}`, value: sessionValue(body.data()) } : absent(key);
      if (meta) {
        if (meta.exists !== entry.exists || meta.digest !== content(entry)) throw fail('SESSION_WRITER_UNTRACKED_CHANGE');
        entry.token = `m:${meta.revision}:${meta.generation}`;
      }
      return { entry, generation: meta?.generation || 0, revision: meta?.revision || 0 };
    }
    async function inspect(key) { access.ensureUsable(); const ref = refs(key);
      return access.guarded(db.runTransaction(async tx => observed(key, await tx.get(ref.body), await tx.get(ref.meta))), false); }
    function proof(raw, id, digest) {
      if (!raw || raw.id !== id || raw.digest !== digest || !['write', 'projection', 'cancelled'].includes(raw.kind)) throw fail('SESSION_WRITER_RECEIPT_CONFLICT');
      return raw;
    }
    async function write(id, digest, entry, expected, op, fenced = false) {
      access.ensureUsable(); const ref = refs(entry.key), receipt = receipts.doc(id);
      await access.guarded(db.runTransaction(async tx => {
        access.ensureUsable(); const previous = await tx.get(receipt);
        if (previous.exists) { proof(previous.data(), id, digest); return; }
        if (fenced) { tx.create(receipt, { id, digest, kind: 'cancelled', reason: 'fenced' }); return; }
        const current = observed(entry.key, await tx.get(ref.body), await tx.get(ref.meta));
        const conflict = current.entry.token !== expected.token || expected.exists !== undefined && content(current.entry) !== content(expected);
        const expired = op && inactive(op, current.entry, now);
        if (conflict || expired) {
          if (!op) throw fail('SESSION_WRITER_TARGET_CONFLICT');
          tx.create(receipt, { id, digest, kind: 'cancelled', reason: expired ? 'inactive' : 'conflict' }); return;
        }
        const revision = current.revision + 1, generation = current.generation + (entry.exists ? 0 : 1);
        if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
        if (entry.exists) tx.set(ref.body, sessionValue(entry.value)); else tx.delete(ref.body);
        tx.set(ref.meta, { format: 1, revision, generation, exists: entry.exists, digest: content(entry) });
        tx.create(receipt, { id, digest, kind: op ? 'write' : 'projection', changes: encodeValue([{ ...entry, token: `m:${revision}:${generation}` }]), result: encodeValue(op?.result ?? null) });
      }), true);
      return proof((await access.guarded(receipt.get(), false)).data(), id, digest);
    }
    const decode = raw => raw.kind === 'cancelled' ? { id: raw.id, digest: raw.digest, outcome: 'cancelled' }
      : { id: raw.id, digest: raw.digest, changes: decodeValue(raw.changes), result: decodeValue(raw.result) };
    return { inspect, read: async key => (await inspect(key)).entry,
      async snapshot() {
        const keys = new Set();
        for (const collection of [bodies, metadata]) {
          let last;
          while (true) { let query = collection.orderBy('__name__').limit(25); if (last) query = query.startAfter(last);
            const page = await access.guarded(query.get(), false); for (const doc of page.docs) keys.add(`session/${doc.id}`);
            if (page.size < 25) break; last = page.docs.at(-1); }
        }
        return Promise.all([...keys].sort().map(key => this.read(key)));
      },
      async commit(op, onConfirmedReceipt) { const entry = checkSessionCommand(op);
        const confirmed = await write(op.id, op.digest, entry, { token: entry.token }, op);
        onConfirmedReceipt?.(decode(confirmed)); },
      async receipt(op) { const raw = (await access.guarded(receipts.doc(op.id).get(), false)).data(); return raw ? decode(proof(raw, op.id, op.digest)) : null; },
      async cancellationReason(op) { const raw = (await access.guarded(receipts.doc(op.id).get(), false)).data(); return raw ? proof(raw, op.id, op.digest).reason : undefined; },
      async fence(op) { const entry = checkSessionCommand(op); return decode(await write(op.id, op.digest, entry, null, op, true)); },
      async apply(id, entry, expected) { checkSessionKey(entry.key); if (entry.exists) sessionValue(entry.value);
        const raw = await write(id, fingerprint({ entry, expected }), entry, expected); if (raw.kind !== 'projection') throw fail('SESSION_WRITER_RECEIPT_CONFLICT'); return decode(raw).changes[0]; },
    };
  })();
  const rtdb = (() => {
    const archive = createRecordStore({ database, path: 'adminSessionWriterReceipts', timeoutMs, onAmbiguousWrite });
    const receiptId = (hash, id) => `${hash}:${id}`;
    async function archiveReceipt(hash, header) {
      const key = receiptId(hash, header.id);
      // 불변 영수증의 최초 생성은 사전 GET을 생략한다. 충돌은 fresh 원문을 대조하고
      // ACK 미확정은 성공으로 취급하지 않아 기존 복구 경계에 남긴다.
      try { await archive.createIfAbsent(key, header); }
      catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
        const prior = await archive.read(key);
        if (!prior.exists || fingerprint(prior.value) !== fingerprint(header)) throw fail('SESSION_WRITER_RECEIPT_CONFLICT');
      }
    }
    const records = createRecordStore({ database, path: 'adminSessions', timeoutMs, onAmbiguousWrite,
      payloadCodec: { encode: (value, context) => encodeValue(sessionValue(value), context), decode: (value, context) => sessionValue(decodeValue(value, context)) },
      archiveReceipt,
    });
    const convert = (key, record) => ({ key, exists: record.exists, token: record.revision ? `${record.revision}:${record.generation}` : '0', ...(record.exists ? { value: record.value } : {}) });
    async function inspect(key) { const record = await records.read(checkSessionKey(key)); return { entry: convert(key, record), revision: record.revision, generation: record.generation }; }
    // 같은 fresh snapshot으로 영수증과 현재 세션을 함께 대조한다. 요청 간 캐시는 없다.
    async function receiptFromRecord(key, record, id, digest, planned) {
      const hash = checkSessionKey(key);
      const found = record.commitReceipt?.id === id ? record.commitReceipt : (await archive.read(receiptId(hash, id))).value;
      if (!found) return null;
      if (found.id !== id || found.digest !== digest || !checkCommitReceipt(found, found.revision, found.generation)) throw fail('SESSION_WRITER_RECEIPT_CONFLICT');
      if (planned && found.outcome === 'committed' && record.commitReceipt?.id === id && record.revision === found.revision
          && content(convert(key, record)) !== content(planned)) throw fail('SESSION_WRITER_UNTRACKED_CHANGE');
      return found;
    }
    async function header(key, id, digest, planned) {
      return receiptFromRecord(key, await records.read(checkSessionKey(key)), id, digest, planned);
    }
    function decode(op, found) {
      if (!found) return null;
      if (found.outcome === 'cancelled') return { id: op.id, digest: op.digest, outcome: 'cancelled' };
      return { id: op.id, digest: op.digest, changes: [{ ...clone(op.changes[0]), token: `${found.revision}:${found.generation}` }], result: clone(op.result) };
    }
    async function fence(op, reason = 'fenced') {
      const entry = checkSessionCommand(op), hash = checkSessionKey(entry.key);
      for (let i = 0; i < 10; i++) {
        const found = await header(entry.key, op.id, op.digest); if (found) return decode(op, found);
        const current = await records.read(hash);
        try { await records.fence(hash, current.revision, { operationId: op.id, operationDigest: op.digest, cancellationReason: reason }); return decode(op, await header(entry.key, op.id, op.digest)); }
        catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT' || i === 9) throw error; }
      }
    }
    async function write(id, digest, entry, expected, op) {
      const hash = checkSessionKey(entry.key), observed = await records.read(hash);
      const found = await receiptFromRecord(entry.key, observed, id, digest, entry); if (found) return found;
      const current = { entry: convert(entry.key, observed), revision: observed.revision };
      const conflict = current.entry.token !== expected.token || expected.exists !== undefined && content(current.entry) !== content(expected);
      const expired = op && inactive(op, current.entry, now);
      if (conflict || expired) {
        if (!op) throw fail('SESSION_WRITER_TARGET_CONFLICT'); await fence(op, expired ? 'inactive' : 'conflict'); return header(entry.key, id, digest);
      }
      try {
        const committed = await records[entry.exists ? 'compareAndSet' : 'delete'](hash, current.revision, ...(entry.exists ? [entry.value] : []), {
          operationId: id, operationDigest: digest,
          ...(op ? { validateCurrent: record => { if (inactive(op, convert(entry.key, record), now)) throw fail('SESSION_WRITER_INACTIVE'); } } : {}),
        });
        // 서버 CAS ACK의 snapshot만 사용한다. 충돌·미확정·복구는 아래 fresh 경로를 유지한다.
        const confirmed = await receiptFromRecord(entry.key, committed, id, digest, entry);
        if (!confirmed) throw fail('SESSION_WRITER_RECEIPT_CONFLICT');
        return confirmed;
      } catch (error) {
        if (!op || !['USER_STORAGE_CONFLICT', 'SESSION_WRITER_INACTIVE'].includes(error.code)) throw error;
        await fence(op, error.code === 'SESSION_WRITER_INACTIVE' ? 'inactive' : 'conflict');
      }
      return header(entry.key, id, digest, entry);
    }
    return { inspect, read: async key => (await inspect(key)).entry,
      // 최초 서버 get과 구독 준비를 겹치되 판정은 fresh get/서버 CAS로 한다.
      // 요청 종료 시 두 저장소의 listener를 성공·실패와 무관하게 해제한다.
      withSession: action => records.withSession(() => archive.withSession(action)),
      async snapshot() {
        const entries = []; let last;
        while (true) { let query = database.ref('adminSessions').orderByKey().limitToFirst(25); if (last) query = query.startAfter(last);
          const page = await access.guarded(query.get(), false); const keys = []; let count = 0;
          page.forEach(child => { count++; last = child.key; keys.push(`session/${decodeKey(child.key)}`); });
          for (const key of keys) entries.push(await this.read(key)); if (count < 25) break;
        }
        return entries.sort((a, b) => a.key.localeCompare(b.key));
      },
      async commit(op, onConfirmedReceipt) { const entry = checkSessionCommand(op);
        const confirmed = await write(op.id, op.digest, entry, { token: entry.token }, op);
        onConfirmedReceipt?.(decode(op, confirmed)); },
      async receipt(op) { const entry = checkSessionCommand(op); return decode(op, await header(entry.key, op.id, op.digest, entry)); },
      cancellationReason: async op => (await header(op.changes[0].key, op.id, op.digest))?.reason, fence,
      async apply(id, entry, expected) { checkSessionKey(entry.key); if (entry.exists) sessionValue(entry.value);
        const digest = fingerprint({ entry, expected }), found = await write(id, digest, entry, expected);
        if (found.outcome !== 'committed') throw fail('SESSION_WRITER_RECEIPT_CONFLICT'); return convert(entry.key, { exists: entry.exists, value: entry.value, revision: found.revision, generation: found.generation }); },
    };
  })();
  return { legacy, rtdb };
}
module.exports = { createSessionWriterAdapters, checkSessionKey, checkSessionCommand };
