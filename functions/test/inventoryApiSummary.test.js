'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { cardHash } = require('../services/user-storage/inventoryManifest');
const { encodeKey } = require('../services/user-storage/codec');
const { readApiSummary } = require('../services/user-storage/inventoryApiSummary');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const base = `inventories/${encodeKey('synthetic')}`;
function fixture() {
  return { version: 3, updatedAt: 'old', amount: 5, locations: { '상자.#': ['A'], '다른 위치': ['B'] }, rarities: { SR: 2, UR: 3 },
    cards: { A: { name: '합성 A', cid: 'a', items: [{ qty: 2, rarity: 'SR', loc: '상자.#', illustration: '1' }] },
      B: { name: '합성 B', cid: 'b', items: [{ qty: 3, rarity: 'UR', loc: '다른 위치', illustration: '1' }] } } };
}
function database() {
  let tree = {};
  const f = { reads: [], writes: 0, beforeCommit: undefined };
  const value = path => clone(path.split('/').reduce((node, part) => node?.[part], tree) ?? null);
  const save = (path, next) => {
    const parts = path.split('/'), key = parts.pop(); let node = tree;
    for (const part of parts) node = node[part] ||= {};
    if (next === null) delete node[key]; else node[key] = clone(next);
  };
  const snap = value => ({ val: () => clone(value) });
  f.value = value; f.save = save;
  f.db = { ref(path) { return {
    async get() { f.reads.push(path); return snap(value(path)); },
    on(event, callback) { queueMicrotask(() => callback(snap(value(path)))); }, off() {},
    async set(next) { f.writes++; save(path, next); }, async remove() { f.writes++; save(path, null); },
    async transaction(callback) {
      if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = undefined; await hook(); }
      const next = callback(value(path));
      if (next === undefined) return { committed: false, snapshot: snap(value(path)) };
      f.writes++; save(path, next); return { committed: true, snapshot: snap(next) };
    },
  }; } };
  return f;
}
async function seed(value = fixture()) {
  const f = database(), store = createPartitionedInventoryStore({ database: f.db, now: () => 'saved' });
  await store.update('synthetic', inventory => Object.assign(inventory, value));
  f.reads.length = 0; f.writes = 0;
  return { f, store };
}
function add(inventory) {
  inventory.cards.A.items[0].qty++;
  inventory.amount++;
  inventory.rarities.SR++;
  return 'changed';
}

test('API 부분 수정은 미선택 본문 없이 전체 집계와 CID 상태를 반환한다', async () => {
  const { f, store } = await seed();
  const result = await store.updateApiCards('synthetic', ['A'], add);
  assert.equal(result.result, 'changed');
  assert.equal(result.record.scope, 'api-cards');
  assert.deepEqual(Object.keys(result.record.value.cards), ['A']);
  assert.equal(result.record.value.amount, 6);
  assert.deepEqual(result.record.value.rarities, { SR: 3, UR: 3 });
  assert.deepEqual(result.record.value.locations, fixture().locations);
  assert.deepEqual(result.inventoryMigration, { status: 'complete', pendingCount: 0, unresolvedCount: 0, retryAt: 0 });
  assert.ok(!f.reads.some(path => path.includes(`/${cardHash('B')}/`)));
  assert.equal((await store.read('synthetic')).value.amount, 6);
});

test('삭제의 rarity 0과 기존 위치 배열 순서를 다음 부분 수정에서도 보존한다', async () => {
  const { store } = await seed();
  const result = await store.updateApiCards('synthetic', ['A'], inventory => {
    inventory.cards.A.items[0].loc = '다른 위치';
    delete inventory.locations['상자.#'];
    inventory.locations['다른 위치'].push('A');
  });
  assert.deepEqual(result.record.value.locations['다른 위치'], ['B', 'A']);
  assert.deepEqual((await store.read('synthetic')).value.locations['다른 위치'], ['B', 'A']);
  await store.updateApiCards('synthetic', ['A'], inventory => {
    delete inventory.cards.A; inventory.amount -= 2; inventory.rarities.SR = 0;
    inventory.locations['다른 위치'] = ['B'];
  });
  const again = await store.updateApiCards('synthetic', ['B'], () => {});
  assert.deepEqual(again.record.value.rarities, { SR: 0, UR: 3 });
  assert.deepEqual((await store.read('synthetic')).value.rarities, { SR: 0, UR: 3 });
});

test('요약 없는 저장 형식은 callback 전에 generation을 포함해 전체 경로를 요구한다', async () => {
  const { f, store } = await seed();
  const raw = f.value(base); delete raw.payload.apiSummary; f.save(base, raw);
  let calls = 0;
  await assert.rejects(store.updateApiCards('synthetic', ['A'], () => calls++), error =>
    error.code === 'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE' && error.generation === 0);
  assert.equal(calls, 0); assert.equal(f.writes, 0);
  await store.update('synthetic', () => {}, { skipUnchanged: true, expectedGeneration: 0 });
  assert.ok(f.value(base).payload.apiSummary);
});

test('fallback 이후 초기화된 데이터는 expectedGeneration으로 부활하지 않는다', async () => {
  const { f, store } = await seed();
  await store.clear('synthetic'); const writes = f.writes;
  let calls = 0;
  for (const operation of [() => store.update('synthetic', () => calls++, { expectedGeneration: 0 }),
    () => store.updateApiCards('synthetic', ['A'], () => calls++, { expectedGeneration: 0 })]) {
    await assert.rejects(operation(), { code: 'USER_STORAGE_CONFLICT' });
  }
  assert.equal(calls, 0); assert.equal(f.writes, writes);
});

test('기존/부재 API no-op와 전체 skipUnchanged는 시각/CAS/blob을 바꾸지 않는다', async () => {
  const { f, store } = await seed();
  const before = f.value(base);
  await store.updateApiCards('synthetic', ['A'], () => 'failed');
  await store.update('synthetic', () => {}, { skipUnchanged: true });
  assert.equal(f.writes, 0); assert.deepEqual(f.value(base), before);
  await store.updateApiCards('missing', [], () => {});
  await store.update('missing', () => {}, { skipUnchanged: true });
  assert.equal(f.writes, 0);
});

test('기존 generic 부분 수정은 이전 API 요약을 무효화한다', async () => {
  const { f, store } = await seed();
  await store.updateCards('synthetic', ['A'], cards => cards.A.items[0].qty++);
  assert.equal(f.value(base).payload.apiSummary, undefined);
  await assert.rejects(store.updateApiCards('synthetic', ['A'], () => {}), { code: 'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE' });
});

test('미선택 CID 재조회 시각 도래는 callback 전에 전체 준비를 요구한다', async () => {
  const value = fixture(); value.cards.B.cid = null; value.cards.B.cidCheckedAt = Date.now() - 86400001;
  const { f, store } = await seed(value); let calls = 0;
  await assert.rejects(store.updateApiCards('synthetic', ['A'], () => calls++), { code: 'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE' });
  assert.equal(calls, 0); assert.equal(f.writes, 0);
});

test('특수 키·null prototype·root 메타데이터를 요약과 전체 읽기에 보존한다', async () => {
  const value = fixture();
  value.locations = Object.assign(Object.create(null), value.locations);
  value.rarities = Object.assign(Object.create(null), value.rarities);
  value.cards.A.items[0].rarity = '__proto__';
  delete value.rarities.SR; value.rarities.__proto__ = 2;
  value.custom = { preserved: true };
  const { store } = await seed(value);
  const result = await store.updateApiCards('synthetic', ['A'], inventory => {
    inventory.cards.A.items[0].qty++; inventory.amount++; inventory.rarities.__proto__++;
  });
  assert.equal(Object.getPrototypeOf(result.record.value.rarities), null);
  assert.equal(result.record.value.rarities.__proto__, 3);
  assert.deepEqual(result.record.value.custom, value.custom);
  assert.equal((await store.read('synthetic')).value.rarities.__proto__, 3);
  assert.equal({}.preserved, undefined);
});

test('요약/참조 불일치와 mutator의 잘못된 집계는 저장하지 않는다', async () => {
  const { f, store } = await seed();
  await assert.rejects(store.updateApiCards('synthetic', ['A'], inventory => inventory.cards.A.items[0].qty++), { code: 'USER_STORAGE_INVALID_API_SUMMARY' });
  assert.equal(f.writes, 0);
  const raw = f.value(base); raw.payload.header.updatedAt = 'tampered'; f.save(base, raw);
  assert.throws(() => readApiSummary(raw.payload), { code: 'USER_STORAGE_INVALID_API_SUMMARY' });
  await assert.rejects(store.read('synthetic'), { code: 'user-storage/invalid-inventory-format' });
});


test('요약을 만들 수 없는 기존 parts의 전체 no-op도 반복 저장하지 않는다', async () => {
  const value = fixture(); value.version = 1; value.cidMigration = { retryableError: true, retryAt: Date.now() + 30000 };
  const { f, store } = await seed(value); const before = f.value(base);
  await store.update('synthetic', () => {}, { skipUnchanged: true });
  await store.update('synthetic', () => {}, { skipUnchanged: true });
  assert.deepEqual(f.value(base), before); assert.equal(f.writes, 0);
});

test('요약 값만 변경되어도 fingerprint 검증으로 callback 전에 거부한다', async () => {
  const { f, store } = await seed(); const raw = f.value(base);
  raw.payload.apiSummary.value.value[encodeKey('amount')] = 999;
  f.save(base, raw); let calls = 0;
  await assert.rejects(store.updateApiCards('synthetic', ['A'], () => calls++), { code: 'user-storage/invalid-inventory-format' });
  assert.equal(calls, 0); assert.equal(f.writes, 0);
});

test('남은 CID migration marker는 전체 준비 없이 부분 처리하지 않는다', async () => {
  const value = fixture(); value.cidMigration = { retryableError: false, retryAt: 1 };
  const { f, store } = await seed(value); let calls = 0;
  assert.equal(f.value(base).payload.apiSummary, undefined);
  await assert.rejects(store.updateApiCards('synthetic', ['A'], () => calls++), { code: 'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE' });
  assert.equal(calls, 0); assert.equal(f.writes, 0);
});
