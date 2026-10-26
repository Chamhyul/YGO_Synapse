'use strict';
const { measureRtdbGet } = require('./rtdbReadDiagnostics');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { createProfilePayloadCodec, serverTimestampPaths } = require('./user-storage/profileCodec');
const { decodeRecord } = require('./user-storage/recordStore');
const { createStorageAccess, validateStoragePath } = require('./user-storage/storageAccess');
const { fingerprint, content } = require('./userMigrationRehearsal');
const clone = value => decodeValue(encodeValue(value));
const fail = code => Object.assign(new Error('프로필 writer의 저장 영수증과 원본 버전을 대조해야 합니다.'), { code });
const empty = key => ({ key, exists: false, token: '0' });
const sorted = entries => entries.sort((a, b) => a.key.localeCompare(b.key));
function checkProfileKey(key) {
  if (typeof key !== 'string' || !key.startsWith('fs/users/')) throw fail('PROFILE_WRITER_INVALID_KEY');
  const uid = key.slice(9);
  if (!uid || uid.length > 128 || /[/\u0000-\u001f\u007f]/.test(uid) || Buffer.from(uid).toString() !== uid) throw fail('PROFILE_WRITER_INVALID_KEY');
  encodeKey(uid); return uid;
}
function timePaths(op) {
  if (!op.details || op.details.kind !== 'profile' || Object.keys(op.details).length !== 2
      || op.changes.length !== 1) throw fail('PROFILE_WRITER_INVALID_COMMAND');
  checkProfileKey(op.changes[0].key);
  if (!op.changes[0].exists) {
    if (!Array.isArray(op.details.serverTimestampPaths) || op.details.serverTimestampPaths.length) throw fail('PROFILE_WRITER_INVALID_COMMAND');
    return [];
  }
  return serverTimestampPaths(op.changes[0].value, op.details.serverTimestampPaths);
}
function setAt(value, path, replacement) { let node = value; for (const key of path.slice(0, -1)) node = node[key]; node[path.at(-1)] = replacement; }
function profileReceiptMatches(op, actual, planned) {
  if (!op.details) return content(actual) === content(planned);
  const paths = timePaths(op), normalized = clone(actual);
  for (const path of paths) {
    let value = actual.value; for (const key of path) value = value?.[key];
    if (!(value instanceof Timestamp)) return false;
    setAt(normalized.value, path, null);
  }
  return content(normalized) === content(planned);
}
function reserveProfileChange(op, entry) {
  if (!op.details) return entry;
  const value = clone(entry);
  for (const path of timePaths(op)) setAt(value.value, path, new Timestamp(253402300799, 999999999));
  return value;
}
const tokenAt = timestamp => {
  if (!(timestamp instanceof Timestamp)) throw fail('PROFILE_WRITER_INVALID_RECEIPT');
  return `${timestamp.seconds}:${timestamp.nanoseconds}`;
};
const recordEntry = (key, record) => ({ key, exists: record.exists,
  token: record.revision ? `${record.revision}:${record.generation}` : '0', ...(record.exists ? { value: record.value } : {}) });
function proof(id, digest, kind, entry, result) {
  return { id, digest, kind, ...(entry ? { entry } : {}), ...(kind === 'write' ? { result: encodeValue(result) } : {}) };
}
function savedProof(raw, id, digest) {
  if (!raw || raw.id !== id || raw.digest !== digest || !['write', 'projection', 'cancelled'].includes(raw.kind)) throw fail('PROFILE_WRITER_RECEIPT_CONFLICT');
  return raw;
}
function createFirestoreProfileWriter({ db, FieldValue, access }) {
  const users = db.collection('users'), metadata = db.collection('userProfileWriterMetadata'), receipts = db.collection('userProfileWriterReceipts');
  const refs = key => ({ user: users.doc(checkProfileKey(key)), meta: metadata.doc(encodeKey(checkProfileKey(key))) });
  function metadataValue(marker) {
    if (!marker.exists) return undefined;
    const raw = marker.data();
    const value = { ...raw, serverTimestampPaths: decodeValue(raw.serverTimestampPaths) };
    if (value.format !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
        || typeof value.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.digest)
        || !Array.isArray(value.serverTimestampPaths) || !(value.at instanceof Timestamp)) throw fail('PROFILE_WRITER_INVALID_METADATA');
    serverTimestampPaths({ createdAt: null, updatedAt: null, registration: { consent: { acceptedAt: null } } }, value.serverTimestampPaths);
    return value;
  }
  function observed(key, document, marker) {
    const meta = metadataValue(marker);
    if (!document.exists) {
      if (!meta) return empty(key);
      if (meta.exists !== false || meta.digest !== content(empty(key)) || meta.serverTimestampPaths.length) throw fail('PROFILE_WRITER_UNTRACKED_DELETE');
      return { key, exists: false, token: `m:${meta.revision}` };
    }
    const current = { key, exists: true, token: `u:${tokenAt(document.updateTime)}`, value: document.data() };
    if (meta?.exists) {
      const normalized = clone(current); let matches = true;
      for (const path of meta.serverTimestampPaths) {
        if (!Array.isArray(path) || !path.length) throw fail('PROFILE_WRITER_INVALID_METADATA');
        let value = current.value; for (const key of path) value = value?.[key];
        if (!(value instanceof Timestamp) || !value.isEqual(meta.at)) { matches = false; break; }
        setAt(normalized.value, path, null);
      }
      if (matches) {
        serverTimestampPaths(normalized.value, meta.serverTimestampPaths);
        if (content(normalized) === meta.digest) current.token = `m:${meta.revision}`;
      }
    }
    return current;
  }
  async function read(key) {
    access.ensureUsable(); const ref = refs(key);
    return access.guarded(db.runTransaction(async tx => observed(key, await tx.get(ref.user), await tx.get(ref.meta))), false);
  }
  function decodeProof(raw, id, digest) {
    savedProof(raw, id, digest);
    if (raw.kind === 'cancelled') return { id, digest, outcome: 'cancelled' };
    if (!raw.entry || typeof raw.entry.exists !== 'boolean' || !Number.isSafeInteger(raw.entry.revision) || raw.entry.revision < 1) throw fail('PROFILE_WRITER_INVALID_RECEIPT');
    checkProfileKey(raw.entry.key);
    return { key: raw.entry.key, exists: raw.entry.exists, token: `m:${raw.entry.revision}`,
      ...(raw.entry.exists ? { value: raw.entry.value } : {}) };
  }
  async function write(id, digest, change, expected, paths, result, kind) {
    access.ensureUsable(); const ref = refs(change.key), receipt = receipts.doc(id);
    const submitted = change.exists ? clone(change.value) : undefined;
    if (change.exists) for (const path of paths) setAt(submitted, path, FieldValue.serverTimestamp());
    await access.guarded(db.runTransaction(async tx => {
      access.ensureUsable(); const prior = await tx.get(receipt);
      if (prior.exists) { savedProof(prior.data(), id, digest); return; }
      const user = await tx.get(ref.user), marker = await tx.get(ref.meta);
      const current = observed(change.key, user, marker), previous = metadataValue(marker);
      if (current.token !== expected.token || expected.exists !== undefined && content(current) !== content(expected)) {
        if (kind !== 'write') throw fail('PROFILE_WRITER_TARGET_CONFLICT');
        tx.create(receipt, { ...proof(id, digest, 'cancelled'), reason: 'conflict' }); return;
      }
      const revision = (previous?.revision || 0) + 1;
      if (!Number.isSafeInteger(revision)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
      const at = FieldValue.serverTimestamp();
      if (change.exists) tx.set(ref.user, submitted); else tx.delete(ref.user);
      tx.set(ref.meta, { format: 1, revision, exists: change.exists, digest: content(change), serverTimestampPaths: encodeValue(paths), at });
      tx.create(receipt, proof(id, digest, kind, { key: change.key, exists: change.exists, revision,
        ...(change.exists ? { value: submitted } : {}) }, result));
    }), true);
  }
  return { read, membershipStorage: { refs, observed },
    async snapshot() {
      const map = new Map(), markers = new Map();
      async function pages(collection, visit) {
        let last;
        while (true) { let query = collection.orderBy('__name__').limit(25); if (last) query = query.startAfter(last);
          const page = await access.guarded(query.get(), false); for (const doc of page.docs) visit(doc);
          if (page.size < 25) break; last = page.docs.at(-1); }
      }
      await pages(users, doc => { const key = `fs/users/${doc.id}`; checkProfileKey(key); map.set(key, doc); });
      await pages(metadata, doc => { const key = `fs/users/${decodeKey(doc.id)}`; checkProfileKey(key); markers.set(key, doc); });
      const missing = { exists: false };
      return sorted([...new Set([...map.keys(), ...markers.keys()])].map(key => observed(key, map.get(key) || missing, markers.get(key) || missing)));
    },
    async commit(op) { const paths = timePaths(op); await write(op.id, op.digest, op.changes[0], { token: op.changes[0].token }, paths, op.result, 'write'); },
    async receipt(op) {
      access.ensureUsable(); const snap = await access.guarded(receipts.doc(op.id).get(), false); if (!snap.exists) return null;
      const raw = snap.data(), decoded = decodeProof(raw, op.id, op.digest);
      if (raw.kind === 'cancelled') return decoded;
      if (raw.kind !== 'write') throw fail('PROFILE_WRITER_RECEIPT_CONFLICT');
      return { id: op.id, digest: op.digest, changes: [decoded], result: decodeValue(raw.result) };
    },
    async cancellationReason(op) {
      const snap = await access.guarded(receipts.doc(op.id).get(), false);
      return snap.exists ? savedProof(snap.data(), op.id, op.digest).reason : undefined;
    },
    async fence(op) {
      access.ensureUsable(); await access.guarded(db.runTransaction(async tx => { access.ensureUsable(); const ref = receipts.doc(op.id), snap = await tx.get(ref);
        if (snap.exists) { savedProof(snap.data(), op.id, op.digest); return; } tx.create(ref, { ...proof(op.id, op.digest, 'cancelled'), reason: 'fenced' }); }), true);
      return this.receipt(op);
    },
    async apply(id, change, expected) {
      const digest = fingerprint({ change, expected });
      await write(id, digest, change, expected, [], null, 'projection');
      const raw = (await access.guarded(receipts.doc(id).get(), false)).data();
      if (raw?.kind !== 'projection') throw fail('PROFILE_WRITER_RECEIPT_CONFLICT'); return decodeProof(raw, id, digest);
    },
  };
}
function createRtdbProfileWriter({ database, access }) {
  const codec = createProfilePayloadCodec();
  function location(key) {
    const uid = checkProfileKey(key), path = validateStoragePath(`users/${encodeKey(uid)}`);
    return { path, parent: database.ref(path), profile: `${path}/profile` };
  }
  const decode = (key, raw) => recordEntry(key, decodeRecord(raw, { path: location(key).profile, payloadCodec: codec }));
  const read = async key => { const loc = location(key); return decode(key, (await access.guarded(measureRtdbGet(database, 'profile', () => loc.parent.child('profile').get()), false)).val()); };
  function decodeProof(raw, op) {
    savedProof(raw, op.id, op.digest);
    if (raw.kind === 'cancelled') return { id: op.id, digest: op.digest, outcome: 'cancelled' };
    if (!raw.entry?.record) throw fail('PROFILE_WRITER_INVALID_RECEIPT');
    return decode(raw.entry.key, raw.entry.record);
  }
  async function transact(key, id, digest, mutate) {
    access.ensureUsable(); const loc = location(key); let callbackError, onValue;
    try {
      await access.guarded(new Promise((resolve, reject) => { onValue = resolve; loc.parent.on('value', onValue, reject); }), false);
      const response = await access.guarded(loc.parent.transaction(raw => {
        callbackError = undefined;
        try {
          access.ensureUsable(); raw ||= {}; raw.profileWriterReceipts ||= {};
          if (raw.profileWriterReceipts[id]) { savedProof(raw.profileWriterReceipts[id], id, digest); return raw; }
          mutate(raw, loc); return raw;
        } catch (error) { callbackError = error; return undefined; }
      }, undefined, false), true);
      if (callbackError) throw callbackError;
      if (!response.committed) throw fail('PROFILE_WRITER_TARGET_CONFLICT');
      return response.snapshot.val().profileWriterReceipts[id];
    } finally { if (onValue) loc.parent.off('value', onValue); }
  }
  async function write(key, id, digest, change, expected, paths, result, kind) {
    const loc = location(key), stable = change.exists ? clone(change.value) : undefined;
    const payload = change.exists ? codec.encode(codec.withServerTimestamps(stable, paths), { basePath: `${loc.profile}/payload` }) : undefined;
    return transact(key, id, digest, (raw, where) => {
      const current = decode(key, raw.profile), record = decodeRecord(raw.profile, { path: where.profile, payloadCodec: codec });
      if (current.token !== expected.token || expected.exists !== undefined && content(current) !== content(expected)) {
        if (kind !== 'write') throw fail('PROFILE_WRITER_TARGET_CONFLICT'); raw.profileWriterReceipts[id] = { ...proof(id, digest, 'cancelled'), reason: 'conflict' }; return;
      }
      if (record.revision === Number.MAX_SAFE_INTEGER) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
      const next = { format: 1, revision: record.revision + 1, generation: record.generation + (change.exists ? 0 : 1), tombstone: !change.exists,
        ...(change.exists ? { payload } : {}) };
      raw.profile = next; raw.profileWriterReceipts[id] = proof(id, digest, kind, { key, record: next }, result);
    });
  }
  return { read, membershipStorage: { location, decode, codec },
    async snapshot() {
      const entries = []; let last;
      while (true) { let query = database.ref('users').orderByKey().limitToFirst(25); if (last) query = query.startAfter(last);
        const snap = await access.guarded(query.get(), false); let count = 0;
        snap.forEach(child => { count++; last = child.key; if (child.val().profile !== undefined) entries.push(decode(`fs/users/${decodeKey(child.key)}`, child.val().profile)); });
        if (count < 25) break; }
      return sorted(entries);
    },
    async commit(op, onConfirmedReceipt) {
      const paths = timePaths(op);
      const raw = await write(op.changes[0].key, op.id, op.digest, op.changes[0], { token: op.changes[0].token }, paths, op.result, 'write');
      // SDK transaction snapshot의 server-time은 서버 저장값과 미세하게 다를 수 있다.
      // 새 서버 시각을 기록한 작업은 기존 fresh receipt 조회로 실제 값을 확인한다.
      if (paths.length || !onConfirmedReceipt) return;
      const decoded = decodeProof(raw, op);
      if (raw.kind !== 'cancelled' && raw.kind !== 'write') throw fail('PROFILE_WRITER_RECEIPT_CONFLICT');
      onConfirmedReceipt?.(raw.kind === 'cancelled' ? decoded
        : { id: op.id, digest: op.digest, changes: [decoded], result: decodeValue(raw.result) });
    },
    async receipt(op) {
      const key = op.changes[0].key, loc = location(key);
      const raw = (await access.guarded(loc.parent.child(`profileWriterReceipts/${op.id}`).get(), false)).val(); if (!raw) return null;
      const decoded = decodeProof(raw, op); if (raw.kind === 'cancelled') return decoded;
      if (raw.kind !== 'write') throw fail('PROFILE_WRITER_RECEIPT_CONFLICT');
      return { id: op.id, digest: op.digest, changes: [decoded], result: decodeValue(raw.result) };
    },
    async cancellationReason(op) {
      const loc = location(op.changes[0].key), raw = (await access.guarded(loc.parent.child(`profileWriterReceipts/${op.id}`).get(), false)).val();
      return raw ? savedProof(raw, op.id, op.digest).reason : undefined;
    },
    async fence(op) { const key = op.changes[0].key; await transact(key, op.id, op.digest, raw => { raw.profileWriterReceipts[op.id] = { ...proof(op.id, op.digest, 'cancelled'), reason: 'fenced' }; }); return this.receipt(op); },
    async apply(id, change, expected) {
      const digest = fingerprint({ change, expected }), raw = await write(change.key, id, digest, change, expected, [], null, 'projection');
      if (raw?.kind !== 'projection') throw fail('PROFILE_WRITER_RECEIPT_CONFLICT'); return decodeProof(raw, { id, digest });
    },
  };
}
function createProfileWriterAdapters({ db, database, FieldValue, timeoutMs, onAmbiguousWrite } = {}) {
  if (!db?.collection || !db?.runTransaction || !FieldValue?.serverTimestamp) throw fail('PROFILE_WRITER_INVALID_DEPENDENCIES');
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  return { legacy: createFirestoreProfileWriter({ db, FieldValue, access }), rtdb: createRtdbProfileWriter({ database, access }) };
}
module.exports = { createProfileWriterAdapters, checkProfileKey, profileReceiptMatches, reserveProfileChange };
