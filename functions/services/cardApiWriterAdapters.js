'use strict';
const { decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { createRecordStore, checkCommitReceipt } = require('./user-storage/recordStore');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { checkApiKey, apiValue, checkApiCommand, inactive } = require('./cardApiWriterContract');
const { createHash } = require('node:crypto');
const originHash = origin => createHash('sha256').update(origin).digest('hex');
const { content, fingerprint } = require('./userMigrationRehearsal');
const fail = code => Object.assign(new Error('API 접근 자료의 저장 버전과 영수증을 확인해 주세요.'), { code });
const clone = value => decodeValue(encodeValue(value));
function createApiWriterAdapters({ db, database, timeoutMs = 10000, onAmbiguousWrite, now = Date.now }) {
  if (!db?.collection || !db?.runTransaction || typeof now !== 'function') throw fail('API_WRITER_INVALID_DEPENDENCIES');
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const absent = key => ({ key, exists: false, token: '0' });
  const legacy = (() => {
    const bodies = db.collection('cardApiKeys'), metadata = db.collection('apiAccessWriterMetadata'), receipts = db.collection('apiAccessWriterReceipts');
    const usages = db.collection('cardApiUsage'), corsRef = db.collection('cardApiConfig').doc('cors');
    const refs = key => { const hash = checkApiKey(key); return { body: bodies.doc(hash), usage: usages.doc(hash), meta: metadata.doc(hash) }; };
    function corsValue(doc) {
      const value = doc.exists ? doc.data() : { keyOrigins: {} };
      if (!value || Object.keys(value).join(',') !== 'keyOrigins' || !value.keyOrigins || typeof value.keyOrigins !== 'object' || Array.isArray(value.keyOrigins)) throw fail('API_WRITER_MIGRATION_REQUIRED');
      for (const [id, origins] of Object.entries(value.keyOrigins)) { checkApiKey(`apiKey/${id}`); if (!Array.isArray(origins) || !origins.every(require('./cardApiAccess').validOrigin)) throw fail('API_WRITER_MIGRATION_REQUIRED'); }
      return value;
    }
    function observed(key, body, usage, cors, marker) {
      const meta = marker.data();
      if (meta && (meta.format !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 1
          || !Number.isSafeInteger(meta.generation) || meta.generation < 0 || meta.generation > meta.revision
          || typeof meta.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(meta.digest))) throw fail('API_WRITER_INVALID_METADATA');
      const id = checkApiKey(key), config = corsValue(cors), corsOrigins = Object.hasOwn(config.keyOrigins, id) ? config.keyOrigins[id] : null;
      if (!body.exists && (usage.exists || corsOrigins !== null)) throw fail('API_WRITER_MIGRATION_REQUIRED');
      const stamp = doc => doc.exists ? [doc.updateTime.seconds, doc.updateTime.nanoseconds] : null;
      const entry = body.exists ? { key, exists: true, token: `u:${fingerprint({ policy: stamp(body), usage: stamp(usage), corsOrigins })}`,
        value: apiValue({ policy: body.data(), usage: usage.exists ? usage.data() : null, corsOrigins }) } : absent(key);
      if (meta) {
        if (meta.exists !== entry.exists || meta.digest !== content(entry)) throw fail('API_WRITER_UNTRACKED_CHANGE');
        entry.token = `m:${meta.revision}:${meta.generation}`;
      }
      return { entry, generation: meta?.generation || 0, revision: meta?.revision || 0 };
    }
    async function inspect(key) { access.ensureUsable(); const ref = refs(key);
      return access.guarded(db.runTransaction(async tx => observed(key, await tx.get(ref.body), await tx.get(ref.usage), await tx.get(corsRef), await tx.get(ref.meta))), false); }
    function proof(raw, id, digest) {
      if (!raw || raw.id !== id || raw.digest !== digest || !['write', 'projection', 'cancelled'].includes(raw.kind)) throw fail('API_WRITER_RECEIPT_CONFLICT');
      return raw;
    }
    async function write(id, digest, entry, expected, op, fenced = false) {
      access.ensureUsable(); const ref = refs(entry.key), receipt = receipts.doc(id);
      await access.guarded(db.runTransaction(async tx => {
        access.ensureUsable(); const previous = await tx.get(receipt);
        if (previous.exists) { proof(previous.data(), id, digest); return; }
        if (fenced) { tx.create(receipt, { id, digest, kind: 'cancelled', reason: 'fenced' }); return; }
        const corsDoc = await tx.get(corsRef);
        const current = observed(entry.key, await tx.get(ref.body), await tx.get(ref.usage), corsDoc, await tx.get(ref.meta));
        const conflict = current.entry.token !== expected.token || expected.exists !== undefined && content(current.entry) !== content(expected);
        const expired = op && inactive(op, current.entry, now);
        if (conflict || expired) {
          if (!op) throw fail('API_WRITER_TARGET_CONFLICT');
          tx.create(receipt, { id, digest, kind: 'cancelled', reason: expired ? 'inactive' : 'conflict' }); return;
        }
        const revision = current.revision + 1, generation = current.generation + (entry.exists ? 0 : 1);
        if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
        const config = corsValue(corsDoc), keyId = checkApiKey(entry.key), nextOrigins = entry.exists ? apiValue(entry.value).corsOrigins : null;
        if (entry.exists) {
          if (!current.entry.exists || fingerprint(current.entry.value.policy) !== fingerprint(entry.value.policy)) tx.set(ref.body, entry.value.policy);
          if (!current.entry.exists || fingerprint(current.entry.value.usage) !== fingerprint(entry.value.usage)) {
            if (entry.value.usage === null) tx.delete(ref.usage); else tx.set(ref.usage, entry.value.usage);
          }
        }
        else { tx.delete(ref.body); tx.delete(ref.usage); }
        if (fingerprint(current.entry.value?.corsOrigins ?? null) !== fingerprint(nextOrigins)) {
          const keyOrigins = { ...config.keyOrigins }; if (nextOrigins === null) delete keyOrigins[keyId]; else keyOrigins[keyId] = nextOrigins;
          tx.set(corsRef, { keyOrigins });
        }
        tx.set(ref.meta, { format: 1, revision, generation, exists: entry.exists, digest: content(entry) });
        tx.create(receipt, { id, digest, kind: op ? 'write' : 'projection', changes: encodeValue([{ ...entry, token: `m:${revision}:${generation}` }]), result: encodeValue(op?.result ?? null) });
      }), true);
      return proof((await access.guarded(receipt.get(), false)).data(), id, digest);
    }
    const decode = raw => raw.kind === 'cancelled' ? { id: raw.id, digest: raw.digest, outcome: 'cancelled' }
      : { id: raw.id, digest: raw.digest, changes: decodeValue(raw.changes), result: decodeValue(raw.result) };
    return { inspect, read: async key => (await inspect(key)).entry,
      async allowsPreflight(origin) { const config = corsValue(await access.guarded(corsRef.get(), false));
        for (const id of Object.keys(config.keyOrigins)) { const record = await this.read(`apiKey/${id}`); if (record.exists && record.value.corsOrigins?.includes(origin)) return true; } return false; },
      async snapshot() {
        const keys = new Set();
        const configDocs = await access.guarded(db.collection('cardApiConfig').get(), false);
        if (configDocs.docs.some(doc => doc.id !== 'cors')) throw fail('API_WRITER_MIGRATION_REQUIRED');
        for (const collection of [bodies, usages, metadata]) {
          let last;
          while (true) { let query = collection.orderBy('__name__').limit(25); if (last) query = query.startAfter(last);
            const page = await access.guarded(query.get(), false); for (const doc of page.docs) keys.add(`apiKey/${doc.id}`);
            if (page.size < 25) break; last = page.docs.at(-1); }
        }
        const cors = corsValue(await access.guarded(corsRef.get(), false)); for (const id of Object.keys(cors.keyOrigins)) keys.add(`apiKey/${id}`);
        return Promise.all([...keys].sort().map(key => this.read(key)));
      },
      async commit(op, onConfirmedReceipt) { const entry = checkApiCommand(op);
        const confirmed = await write(op.id, op.digest, entry, { token: entry.token }, op);
        onConfirmedReceipt?.(decode(confirmed)); },
      async receipt(op) { const raw = (await access.guarded(receipts.doc(op.id).get(), false)).data(); return raw ? decode(proof(raw, op.id, op.digest)) : null; },
      async cancellationReason(op) { const raw = (await access.guarded(receipts.doc(op.id).get(), false)).data(); return raw ? proof(raw, op.id, op.digest).reason : undefined; },
      async fence(op) { const entry = checkApiCommand(op); return decode(await write(op.id, op.digest, entry, null, op, true)); },
      async apply(id, entry, expected) { checkApiKey(entry.key); if (entry.exists) apiValue(entry.value);
        const raw = await write(id, fingerprint({ entry, expected }), entry, expected); if (raw.kind !== 'projection') throw fail('API_WRITER_RECEIPT_CONFLICT'); return decode(raw).changes[0]; },
    };
  })();
  const rtdb = (() => {
    const archive = createRecordStore({ database, path: 'apiAccessWriterReceipts', timeoutMs, onAmbiguousWrite });
    const receiptId = (hash, id) => `${hash}:${id}`;
    const normalize = value => apiValue(Object.hasOwn(value, 'corsOrigins') ? value : { ...value, corsOrigins: value.policy.enabled && value.policy.scope === 'getCardInfo' ? value.policy.origins : null });
    const records = createRecordStore({ database, path: 'apiAccess/keys', timeoutMs, onAmbiguousWrite,
      payloadCodec: { encode: (value, context) => encodeValue(apiValue(value), context), decode: (value, context) => normalize(decodeValue(value, context)) },
      archiveReceipt: async (hash, header) => archive.update(receiptId(hash, header.id), prior => {
        if (prior && fingerprint(prior) !== fingerprint(header)) throw fail('API_WRITER_RECEIPT_CONFLICT'); return { value: header };
      }),
    });
    const convert = (key, record) => ({ key, exists: record.exists, token: record.revision ? `${record.revision}:${record.generation}` : '0', ...(record.exists ? { value: record.value } : {}) });
    async function inspect(key) { const id = checkApiKey(key), record = await records.read(id);
      if (record.exists) for (const origin of record.value.corsOrigins || []) {
        const candidate = await access.guarded(database.ref(`apiAccess/origins/${originHash(origin)}/${id}`).get(), false);
        if (candidate.val() !== true) throw fail('API_WRITER_MIGRATION_REQUIRED');
      }
      return { entry: convert(key, record), revision: record.revision, generation: record.generation }; }
    async function stageOrigins(entry) { if (entry.exists) for (const origin of entry.value.corsOrigins || [])
      await access.guarded(database.ref(`apiAccess/origins/${originHash(origin)}/${checkApiKey(entry.key)}`).set(true), true); }

    async function header(key, id, digest, planned) {
      const hash = checkApiKey(key), record = await records.read(hash);
      const found = record.commitReceipt?.id === id ? record.commitReceipt : (await archive.read(receiptId(hash, id))).value;
      if (!found) return null;
      if (found.id !== id || found.digest !== digest || !checkCommitReceipt(found, found.revision, found.generation)) throw fail('API_WRITER_RECEIPT_CONFLICT');
      if (planned && found.outcome === 'committed' && record.commitReceipt?.id === id && record.revision === found.revision
          && content(convert(key, record)) !== content(planned)) throw fail('API_WRITER_UNTRACKED_CHANGE');
      return found;
    }
    function decode(op, found) {
      if (!found) return null;
      if (found.outcome === 'cancelled') return { id: op.id, digest: op.digest, outcome: 'cancelled' };
      return { id: op.id, digest: op.digest, changes: [{ ...clone(op.changes[0]), token: `${found.revision}:${found.generation}` }], result: clone(op.result) };
    }
    async function fence(op, reason = 'fenced') {
      const entry = checkApiCommand(op), hash = checkApiKey(entry.key);
      for (let i = 0; i < 10; i++) {
        const found = await header(entry.key, op.id, op.digest); if (found) return decode(op, found);
        const current = await records.read(hash);
        try { await records.fence(hash, current.revision, { operationId: op.id, operationDigest: op.digest, cancellationReason: reason }); return decode(op, await header(entry.key, op.id, op.digest)); }
        catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT' || i === 9) throw error; }
      }
    }
    async function write(id, digest, entry, expected, op) {
      const found = await header(entry.key, id, digest, entry); if (found) return found;
      const hash = checkApiKey(entry.key), current = await inspect(entry.key);
      const conflict = current.entry.token !== expected.token || expected.exists !== undefined && content(current.entry) !== content(expected);
      const expired = op && inactive(op, current.entry, now);
      if (conflict || expired) {
        if (!op) throw fail('API_WRITER_TARGET_CONFLICT'); await fence(op, expired ? 'inactive' : 'conflict'); return header(entry.key, id, digest);
      }
      if (fingerprint(current.entry.value?.corsOrigins ?? null) !== fingerprint(entry.value?.corsOrigins ?? null)) await stageOrigins(entry);
      try {
        await records[entry.exists ? 'compareAndSet' : 'delete'](hash, current.revision, ...(entry.exists ? [entry.value] : []), {
          operationId: id, operationDigest: digest,
          ...(op ? { validateCurrent: record => { if (inactive(op, convert(entry.key, record), now)) throw fail('API_WRITER_INACTIVE'); } } : {}),
        });
      } catch (error) {
        if (!op || !['USER_STORAGE_CONFLICT', 'API_WRITER_INACTIVE'].includes(error.code)) throw error;
        await fence(op, error.code === 'API_WRITER_INACTIVE' ? 'inactive' : 'conflict');
      }
      return header(entry.key, id, digest, entry);
    }
    return { inspect, read: async key => (await inspect(key)).entry,
      async snapshot() {
        const entries = []; let last;
        while (true) { let query = database.ref('apiAccess/keys').orderByKey().limitToFirst(25); if (last) query = query.startAfter(last);
          const page = await access.guarded(query.get(), false); const keys = []; let count = 0;
          page.forEach(child => { count++; last = child.key; keys.push(`apiKey/${decodeKey(child.key)}`); });
          for (const key of keys) entries.push(await this.read(key)); if (count < 25) break;
        }
        return entries.sort((a, b) => a.key.localeCompare(b.key));
      },
      async commit(op, onConfirmedReceipt) { const entry = checkApiCommand(op);
        const confirmed = await write(op.id, op.digest, entry, { token: entry.token }, op);
        onConfirmedReceipt?.(decode(op, confirmed)); },
      async receipt(op) { const entry = checkApiCommand(op); return decode(op, await header(entry.key, op.id, op.digest, entry)); },
      cancellationReason: async op => (await header(op.changes[0].key, op.id, op.digest))?.reason, fence,
      async apply(id, entry, expected) { checkApiKey(entry.key); if (entry.exists) apiValue(entry.value);
        const digest = fingerprint({ entry, expected }), found = await write(id, digest, entry, expected);
        if (found.outcome !== 'committed') throw fail('API_WRITER_RECEIPT_CONFLICT'); return convert(entry.key, { exists: entry.exists, value: entry.value, revision: found.revision, generation: found.generation }); },
    };
  })();
  rtdb.allowsPreflight = async origin => { const raw = (await access.guarded(database.ref(`apiAccess/origins/${originHash(origin)}`).get(), false)).val() ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw) || Object.entries(raw).some(([id, yes]) => !/^[a-f0-9]{24}$/.test(id) || yes !== true)) throw fail('API_WRITER_MIGRATION_REQUIRED');
    for (const id of Object.keys(raw)) { const record = await rtdb.read(`apiKey/${id}`); if (record.exists && record.value.corsOrigins?.includes(origin)) return true; } return false; };
  return { legacy, rtdb };
}
module.exports = { createApiWriterAdapters, checkApiKey, checkApiCommand };
