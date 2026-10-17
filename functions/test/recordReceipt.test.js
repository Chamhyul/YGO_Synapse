'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');
const path = `records/${encodeKey('synthetic')}`;
const first = { operationId: 'a'.repeat(32), operationDigest: '1'.repeat(64) };
const second = { operationId: 'b'.repeat(32), operationDigest: '2'.repeat(64) };
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const data = new Map(), events = [];
  const snapshot = value => ({ val: () => clone(value) });
  const db = { ref(key) { return {
    async get() { return snapshot(data.get(key) ?? null); },
    on(_event, callback) { queueMicrotask(() => callback(snapshot(data.get(key) ?? null))); },
    off() {},
    async transaction(callback) {
      events.push('transaction');
      const next = callback(clone(data.get(key) ?? null));
      if (next === undefined) return { committed: false, snapshot: snapshot(data.get(key) ?? null) };
      data.set(key, clone(next));
      return { committed: true, snapshot: snapshot(next) };
    },
  }; } };
  const archived = [];
  const archiveReceipt = async (uid, receipt) => { events.push('archive'); archived.push({ uid, receipt: clone(receipt) }); };
  const store = createRecordStore({ database: db, path: 'records', archiveReceipt, ...options });
  return { data, events, db, store, archived };
}

test('확정 receipt는 CAS와 같은 revision에 기록하고 후속 변경 전에 보관한다', async () => {
  const { store, events, archived } = fixture();
  const initial = await store.compareAndSet('synthetic', 0, { qty: 1 }, first);
  assert.deepEqual(initial.commitReceipt, { id: first.operationId, digest: first.operationDigest,
    outcome: 'committed', revision: 1, generation: 0 });
  events.length = 0;
  const changed = await store.compareAndSet('synthetic', 1, { qty: 2 }, second);
  assert.deepEqual(events, ['archive', 'transaction']);
  assert.deepEqual(archived, [{ uid: 'synthetic', receipt: initial.commitReceipt }]);
  assert.equal(changed.commitReceipt.id, second.operationId);
  assert.equal(changed.commitReceipt.revision, 2);
});

test('receipt 없는 기존 writer도 보관 후 이전 receipt를 유지한다', async () => {
  const { store, archived } = fixture();
  const initial = await store.compareAndSet('synthetic', 0, { qty: 1 }, first);
  const changed = await store.compareAndSet('synthetic', 1, { qty: 2 });
  assert.deepEqual(changed.commitReceipt, initial.commitReceipt);
  const updated = await store.update('synthetic', value => ({ value: { qty: value.qty + 1 } }));
  assert.deepEqual(updated.record.commitReceipt, initial.commitReceipt);
  assert.equal(archived.length, 2);
});

test('기존 프로필 형식은 확장 설정 없이 유지하고 receipt 사용은 거부한다', async () => {
  const { db, data } = fixture();
  const store = createRecordStore({ database: db, path: 'records' });
  const saved = await store.compareAndSet('synthetic', 0, { name: '합성' });
  assert.deepEqual(Object.keys(saved), ['exists', 'value', 'revision', 'generation']);
  await assert.rejects(store.compareAndSet('synthetic', 1, {}, first), { code: 'USER_STORAGE_INVALID_OPERATION' });
  data.get(path).commitReceipt = { id: first.operationId, digest: first.operationDigest,
    outcome: 'committed', revision: 1, generation: 0 };
  await assert.rejects(store.read('synthetic'), { code: 'USER_STORAGE_INVALID_RECORD' });
});

test('receipt 보관 실패와 기한 초과는 다음 CAS를 제출하지 않는다', async () => {
  const { db, data } = fixture();
  const seed = createRecordStore({ database: db, path: 'records', archiveReceipt: async () => {} });
  await seed.compareAndSet('synthetic', 0, { qty: 1 }, first);
  const original = clone(data.get(path));
  const failing = createRecordStore({ database: db, path: 'records', archiveReceipt: async () => { throw new Error('합성 보관 실패'); } });
  await assert.rejects(failing.compareAndSet('synthetic', 1, { qty: 2 }, second), /합성 보관 실패/);
  const waiting = createRecordStore({ database: db, path: 'records', timeoutMs: 15, archiveReceipt: () => new Promise(() => {}) });
  await assert.rejects(waiting.compareAndSet('synthetic', 1, { qty: 2 }, second), { code: 'USER_STORAGE_READ_TIMEOUT' });
  assert.deepEqual(data.get(path), original);
});

test('이미 충돌한 요청은 보관하지 않고 보관 도중 바뀐 revision도 덮어쓰지 않는다', async () => {
  const { store, data, db, archived } = fixture();
  await store.compareAndSet('synthetic', 0, { qty: 1 }, first);
  await assert.rejects(store.compareAndSet('synthetic', 0, { qty: 9 }, second), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal(archived.length, 0);
  const racing = createRecordStore({ database: db, path: 'records', archiveReceipt: async () => {
    const raw = clone(data.get(path)); raw.revision++; data.set(path, raw);
  } });
  await assert.rejects(racing.compareAndSet('synthetic', 1, { qty: 9 }, second), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal((await store.read('synthetic')).value.qty, 1);
  assert.equal(data.get(path).revision, 2);
});

test('기존 데이터의 fence는 내용과 generation을 보존하고 취소 결과를 원자 기록한다', async () => {
  const { store, data, events } = fixture();
  await store.compareAndSet('synthetic', 0, { qty: 1 }, first);
  const previous = clone(data.get(path)); events.length = 0;
  const fenced = await store.fence('synthetic', 1, second);
  assert.deepEqual(fenced.value, { qty: 1 });
  assert.equal(fenced.exists, true);
  assert.equal(fenced.generation, 0);
  assert.deepEqual(data.get(path).payload, previous.payload);
  assert.deepEqual(fenced.commitReceipt, { id: second.operationId, digest: second.operationDigest,
    outcome: 'cancelled', revision: 2, generation: 0 });
  assert.deepEqual(events, ['archive', 'transaction']);
  await assert.rejects(store.compareAndSet('synthetic', 1, { qty: 9 }, first), { code: 'USER_STORAGE_CONFLICT' });
});

test('삭제 경계와 유지된 ID 상한은 fence 후에도 그대로다', async () => {
  const { store, data } = fixture({ retainOnDelete: value => ({ nextId: value?.nextId || 0 }) });
  await store.compareAndSet('synthetic', 0, { qty: 1, nextId: 7 }, first);
  const deleted = await store.delete('synthetic', 1, second);
  assert.equal(deleted.commitReceipt.outcome, 'committed');
  assert.equal(deleted.commitReceipt.generation, 1);
  const previous = clone(data.get(path));
  const fenced = await store.fence('synthetic', 2);
  assert.deepEqual(data.get(path), { ...previous, revision: 3 });
  assert.deepEqual(fenced.value, { nextId: 7 });
  assert.equal(fenced.exists, false);
  assert.equal(fenced.generation, 1);
});

test('최초 생성 전 fence는 삭제 경계를 남기며 늦은 revision 0 쓰기를 막는다', async () => {
  const { store } = fixture({ retainOnDelete: value => ({ nextId: value?.nextId || 0 }) });
  const fenced = await store.fence('synthetic', 0, first);
  assert.equal(fenced.revision, 1);
  assert.equal(fenced.generation, 1);
  assert.equal(fenced.exists, false);
  assert.deepEqual(fenced.value, { nextId: 0 });
  assert.equal(fenced.commitReceipt.outcome, 'cancelled');
  await assert.rejects(store.compareAndSet('synthetic', 0, { qty: 1 }, second), { code: 'USER_STORAGE_CONFLICT' });
  const created = await store.compareAndSet('synthetic', 1, { qty: 1 }, second);
  assert.equal(created.generation, 1);
});

test('receipt 엄격 검증은 잘못된 값과 미래 revision·generation을 거부한다', async () => {
  const { store, data } = fixture();
  await store.compareAndSet('synthetic', 0, { qty: 1 }, first);
  const original = clone(data.get(path));
  const invalid = [null, [], {}, { ...original.commitReceipt, extra: true },
    { ...original.commitReceipt, id: 'invalid' }, { ...original.commitReceipt, digest: 'invalid' },
    { ...original.commitReceipt, outcome: 'unknown' }, { ...original.commitReceipt, revision: 0 },
    { ...original.commitReceipt, revision: 2 }, { ...original.commitReceipt, generation: -1 },
    { ...original.commitReceipt, generation: 1 }];
  for (const commitReceipt of invalid) {
    data.set(path, { ...original, commitReceipt });
    await assert.rejects(store.read('synthetic'), { code: 'USER_STORAGE_INVALID_RECORD' });
  }
});

test('작업 식별자와 digest가 불완전하거나 잘못되면 읽기·쓰기 전에 거부한다', async () => {
  const { store, events } = fixture();
  for (const options of [null, [], { operationId: first.operationId }, { operationDigest: first.operationDigest },
    { ...first, operationId: 'invalid' }, { ...first, operationDigest: 'invalid' }]) {
    await assert.rejects(store.compareAndSet('synthetic', 0, {}, options), { code: 'USER_STORAGE_INVALID_OPERATION' });
    await assert.rejects(store.delete('synthetic', 0, options), { code: 'USER_STORAGE_INVALID_OPERATION' });
    await assert.rejects(store.fence('synthetic', 0, options), { code: 'USER_STORAGE_INVALID_OPERATION' });
  }
  assert.deepEqual(events, []);
});
