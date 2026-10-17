'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { splitStable } = require('../services/userInventoryWriterAdapters');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
async function setup(extra = {}) {
  const runId = id(), connection = open(runId);
  const binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) }, ...extra });
  await binding.initialize(); const old = await binding.transition.route();
  await binding.transition.copy(old); await binding.transition.drain(old); await binding.transition.activate(old);
  const writer = await binding.transition.route(), candidate = splitStable({ version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: 1,
    locations: { box: ['A'] }, rarities: { SR: 1 }, cards: { A: { name: '합성', cid: '100', items: [{ rarity: 'SR', qty: 1, loc: 'box', illustration: '1' }] } } });
  const operationId = id(), changes = [{ key: 'inventory/u', exists: true, token: '0', value: { exists: true, manifest: candidate.manifest } }];
  const options = { details: { kind: 'inventory', blobs: candidate.blobs }, resources: ['fs/users/u'] };
  return { runId, connection, binding, writer, operationId, changes, options,
    execute: () => binding.transition.prepareAndExecuteWithReceipt(writer, operationId, changes, null, options), close: () => connection.close() };
}
test('새 명령은 journal CAS2회로 잠금/실행과 완료를 확정하고 같은 ID는 다시 저장하지 않는다', async () => {
  const f = await setup(), db = f.connection.targetDatabase, original = db.ref; let transactions = 0;
  db.ref = path => { const ref = original(path); return new Proxy(ref, { get(o, k) {
    const v = o[k]; if (k === 'transaction' && path === 'profileWriterTransitions/' + encodeKey(f.runId)) return (...args) => { transactions++; return v.apply(o, args); };
    return typeof v === 'function' ? v.bind(o) : v;
  } }); };
  try {
    const result = await f.execute(); assert.equal(transactions, 2); assert.equal(result.receipt.changes[0].token, '1:0');
    const saved = await f.binding.inventories.rtdb.read('inventory/u');
    assert.deepEqual(await f.execute(), result); assert.equal(transactions, 2);
    assert.deepEqual(await f.binding.inventories.rtdb.read('inventory/u'), saved);
  } finally { db.ref = original; await f.close(); }
});
test('실행 소유권 ACK 유실은 업무 RPC를 시작하지 않고 재실행을 거부하며 기존 fence로 취소한다', async () => {
  const f = await setup(), db = f.connection.targetDatabase, original = db.ref; let lost = false;
  db.ref = path => { const ref = original(path); return new Proxy(ref, { get(o, k) {
    const v = o[k]; if (k === 'transaction' && path === 'profileWriterTransitions/' + encodeKey(f.runId)) return async (...args) => {
      const result = await v.apply(o, args); if (!lost && result.committed) { lost = true; throw Error('synthetic start ACK loss'); } return result;
    }; return typeof v === 'function' ? v.bind(o) : v;
  } }); };
  try {
    await assert.rejects(f.execute(), /ACK loss/); db.ref = original;
    assert.equal((await f.binding.inventories.rtdb.read('inventory/u')).exists, false);
    assert.equal((await f.binding.transition.inspect()).unresolved, 1);
    await assert.rejects(f.execute(), { code: 'WRITER_OUTCOME_UNRESOLVED' });
    assert.equal((await f.binding.transition.fenceUncommitted(f.operationId)).status, 'cancelled');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { db.ref = original; await f.close(); }
});
test('업무 저장 뒤 중단은 fresh 영수증으로 한 번만 포착하고 역전환에 보존한다', async () => {
  let stop = true; const f = await setup({ onCheckpoint: async stage => { if (stop && stage === 'businessCommitted') throw Error('synthetic interrupted'); } });
  try {
    await assert.rejects(f.execute(), /interrupted/); const before = await f.binding.inventories.rtdb.read('inventory/u');
    stop = false; await f.binding.transition.recover(f.operationId); await f.binding.transition.recover(f.operationId);
    assert.deepEqual(await f.binding.inventories.rtdb.read('inventory/u'), before);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    await f.binding.transition.copy(f.writer); await f.binding.transition.drain(f.writer); await f.binding.transition.activate(f.writer);
    assert.equal((await f.binding.inventoryRepository.downloadInventory('u')).data.amount, 1);
  } finally { await f.close(); }
});
test('실행 checkpoint에서 drain·동일ID 경합이 있어도 승인 소유자만 업무를 한 번 실행한다', async () => {
  let entered, release; const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'executing') { entered(); await gate; } } });
  try {
    const pending = f.execute(); await ready;
    await assert.rejects(f.execute(), { code: 'WRITER_OUTCOME_UNRESOLVED' });
    await f.binding.transition.drain(f.writer);
    await assert.rejects(f.binding.transition.activate(f.writer), { code: 'WRITER_NOT_DRAINED' });
    release(); await pending; assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.binding.inventories.rtdb.read('inventory/u')).token, '1:0');
  } finally { release?.(); await f.close(); }
});
