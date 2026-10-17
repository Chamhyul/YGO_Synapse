'use strict';
const { createHash } = require('node:crypto');
const { encodeValue, decodeValue } = require('../../functions/services/user-storage/codec');
const { fingerprint, content } = require('../../functions/services/userMigrationRehearsal');
const { checkKey } = require('./adapters.cjs');
const fail = code => Object.assign(new Error('합성 writer 저장 경계를 확인해야 합니다.'), { code });
const keyId = key => createHash('sha256').update(key).digest('hex');
const absent = key => ({ key, exists: false, token: '0' });
const entry = (key, raw) => raw ? { key, exists: raw.exists, token: String(raw.version), ...(raw.exists ? { value: decodeValue(raw.value) } : {}) } : absent(key);
const next = (change, before) => ({ exists: change.exists, version: Number(before.token) + 1, ...(change.exists ? { value: encodeValue(change.value) } : {}) });
const verify = (actual, expected) => { if (actual.token !== expected.token || content(actual) !== content(expected)) throw fail('WRITER_ADAPTER_CONFLICT'); };
const sorted = rows => rows.sort((a, b) => a.key.localeCompare(b.key));

// 논리 자료의 포착/재생 경계를 실제 두 DB SDK로 확인하는 시험 어댑터다.
// 현행 native 프로필/분할 인벤토리/CSV 저장소를 대신하는 운영 어댑터가 아니다.
function createWriterAdapters(connection) {
  const records = connection.db.collection('writerRecords'), receipts = connection.db.collection('writerReceipts');
  const root = connection.targetDatabase.ref('writerReference');
  function validate(changes) { for (const item of changes) { checkKey(item.key); if (!/^(0|[1-9][0-9]*)$/.test(item.token)) throw fail('WRITER_ADAPTER_INVALID_TOKEN'); } }
  const legacy = {
    async snapshot() { return sorted((await records.get()).docs.map(doc => entry(doc.data().key, doc.data()))); },
    async commit(op) {
      validate(op.changes);
      await connection.db.runTransaction(async tx => {
        const receiptRef = receipts.doc(op.id), saved = await tx.get(receiptRef);
        if (saved.exists) { if (saved.data().digest !== op.digest) throw fail('WRITER_RECEIPT_CONFLICT'); return; }
        const refs = op.changes.map(change => records.doc(keyId(change.key)));
        const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
        const changes = op.changes.map((change, i) => {
          const before = entry(change.key, snapshots[i].exists ? snapshots[i].data() : null);
          if (before.token !== change.token) throw fail('WRITER_ADAPTER_CONFLICT');
          const raw = { key: change.key, ...next(change, before) }; tx.set(refs[i], raw); return entry(change.key, raw);
        });
        tx.create(receiptRef, { digest: op.digest, payload: encodeValue({ id: op.id, digest: op.digest, changes, result: op.result }) });
      });
    },
    async receipt(op) { const saved = await receipts.doc(op.id).get(); return saved.exists ? decodeValue(saved.data().payload) : null; },
    async fence(op) {
      return connection.db.runTransaction(async tx => {
        const ref = receipts.doc(op.id), saved = await tx.get(ref);
        if (saved.exists) { if (saved.data().digest !== op.digest) throw fail('WRITER_RECEIPT_CONFLICT'); return decodeValue(saved.data().payload); }
        const proof = { id: op.id, digest: op.digest, outcome: 'cancelled' };
        tx.create(ref, { digest: op.digest, payload: encodeValue(proof) }); return proof;
      });
    },
    async apply(id, change, expected) {
      validate([change, expected]);
      const digest = fingerprint({ change, expected }), ref = records.doc(keyId(change.key)), receiptRef = receipts.doc(id);
      return connection.db.runTransaction(async tx => {
        const saved = await tx.get(receiptRef);
        if (saved.exists) { if (saved.data().digest !== digest) throw fail('WRITER_RECEIPT_CONFLICT'); return decodeValue(saved.data().payload); }
        const snapshot = await tx.get(ref), before = entry(change.key, snapshot.exists ? snapshot.data() : null);
        verify(before, expected);
        const raw = { key: change.key, ...next(change, before) }, result = entry(change.key, raw);
        tx.set(ref, raw); tx.create(receiptRef, { digest, payload: encodeValue(result) }); return result;
      });
    },
    async seed(change) { checkKey(change.key); await records.doc(keyId(change.key)).create({ key: change.key, ...next(change, absent(change.key)) }); },
  };
  async function rtdbCommit(id, digest, changes, result, expected, cancel = false) {
    let callbackError, onValue;
    try {
    // get()만으로는 transaction용 cache가 남지 않는다. 확인 listener를 승인까지 유지한다.
    await new Promise((resolve, reject) => {
      onValue = snapshot => resolve(snapshot);
      root.on('value', onValue, reject);
    });
    const response = await root.transaction(raw => {
      callbackError = undefined; raw ||= { records: {}, receipts: {} }; raw.records ||= {}; raw.receipts ||= {};
      try {
        if (raw.receipts[id]) {
          if (raw.receipts[id].digest !== digest) throw fail('WRITER_RECEIPT_CONFLICT');
          return raw;
        }
        if (cancel) {
          raw.receipts[id] = { digest, payload: encodeValue({ id, digest, outcome: 'cancelled' }) };
          return raw;
        }
        const after = changes.map((change, i) => {
          const before = entry(change.key, raw.records[keyId(change.key)]);
          if (expected) verify(before, expected[i]);
          else if (before.token !== change.token) throw fail('WRITER_ADAPTER_CONFLICT');
          const saved = { key: change.key, ...next(change, before) }; raw.records[keyId(change.key)] = saved;
          return entry(change.key, saved);
        });
        raw.receipts[id] = { digest, payload: encodeValue(expected ? after[0] : { id, digest, changes: after, result }) };
        return raw;
      } catch (error) { callbackError = error; return undefined; }
    }, undefined, false);
    if (callbackError) throw callbackError;
    if (!response.committed) throw fail('WRITER_ADAPTER_CONFLICT');
    return decodeValue(response.snapshot.val().receipts[id].payload);
    } finally { if (onValue) root.off('value', onValue); }
  }
  const rtdb = {
    async snapshot() { const raw = (await root.get()).val(); return sorted(Object.values(raw?.records || {}).map(item => entry(item.key, item))); },
    async commit(op) { validate(op.changes); await rtdbCommit(op.id, op.digest, op.changes, op.result); },
    async receipt(op) { const saved = (await root.child(`receipts/${op.id}`).get()).val(); return saved ? decodeValue(saved.payload) : null; },
    async fence(op) { return rtdbCommit(op.id, op.digest, [], null, undefined, true); },
    async apply(id, change, expected) { validate([change, expected]); return rtdbCommit(id, fingerprint({ change, expected }), [change], null, [expected]); },
  };
  return { legacy, rtdb };
}

// 파일 upload는 generation 조건과 metadata 영수증을 사용한다. 삭제와 별도 영수증 사이 간극을 자동 복구하지 않는다.
function createStorageCapture(connection, key) {
  checkKey(key); if (!key.startsWith('inventory/')) throw fail('WRITER_ADAPTER_INVALID_KEY');
  const file = connection.bucket.file(`users/${key.slice(10)}/inventory.json`);
  async function snapshot() {
    const [exists] = await file.exists(); if (!exists) return [];
    const [meta] = await file.getMetadata(), [body] = await file.download();
    return [{ key, exists: true, token: String(meta.generation), value: JSON.parse(body.toString()) }];
  }
  return { snapshot,
    async commit(op) {
      if (op.changes.length !== 1 || op.changes[0].key !== key) throw fail('WRITER_ADAPTER_INVALID_KEY');
      const change = op.changes[0], options = { preconditionOpts: { ifGenerationMatch: change.token }, resumable: false };
      if (!change.exists) { await file.delete({ ifGenerationMatch: change.token }); throw fail('WRITER_STORAGE_DELETE_UNRESOLVED'); }
      await file.save(JSON.stringify(change.value), { ...options, metadata: { contentType: 'application/json', metadata: {
        writerReceipt: JSON.stringify({ id: op.id, digest: op.digest, result: op.result, content: content(change) }),
      } } });
    },
    async receipt(op) {
      const [exists] = await file.exists(); if (!exists) return null;
      const [meta] = await file.getMetadata(), saved = JSON.parse(meta.metadata?.writerReceipt || 'null');
      const rows = await snapshot();
      if (!saved || saved.id !== op.id || saved.digest !== op.digest || saved.content !== content(rows[0])) return null;
      return { id: saved.id, digest: saved.digest, result: saved.result, changes: rows };
    },
    async apply() { throw fail('WRITER_STORAGE_NATIVE_ADAPTER_REQUIRED'); },
  };
}
module.exports = { createWriterAdapters, createStorageCapture };
