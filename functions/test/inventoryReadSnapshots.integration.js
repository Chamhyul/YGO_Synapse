'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { encodeKey } = require('../services/user-storage/codec');
const { createInventorySnapshotWorker } = require('../services/inventorySnapshotWorker');
async function setup(count = 20) {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards = Object.fromEntries(Array.from({ length: count }, (_, i) => [`A-${i}`, { name: `합성 ${i}`, cid: String(100 + i),
        items: [{ rarity: 'N', qty: i + 1, loc: '상자', illustration: '1' }] }]));
      inv.amount = count * (count + 1) / 2; inv.locations = count ? { 상자: Object.keys(inv.cards) } : {}; inv.rarities = count ? { N: inv.amount } : {};
    });
    const worker = createInventorySnapshotWorker({ select: () => ({ binding: f.binding, config: f.config }) });
    const rebuild = () => worker({ instance: f.config.instanceId, location: f.config.location,
      params: { userKey: encodeKey(f.uid), runKey: encodeKey(f.config.runId) }, data: { after: { val: () => ({ payload: 'event-data-is-not-a-source' }) } } });
    return { ...f, rebuild, viewPath: `inventoryReadSnapshots/${encodeKey(f.config.runId)}/${encodeKey(f.uid)}`,
      requestPath: `inventoryReadSnapshotRequests/${encodeKey(f.config.runId)}/${encodeKey(f.uid)}` };
  } catch (error) { await f.close(); throw error; }
}
function observe(database) {
  const ref = database.ref, reads = [], writes = [];
  database.ref = path => { const target = ref(path);
    for (const [method, list] of [['get', reads], ['transaction', writes], ['set', writes]]) {
      const original = target[method].bind(target); target[method] = (...args) => { list.push(path); return original(...args); };
    } return target;
  };
  return { reads, writes, close() { database.ref = ref; } };
}

test('정상 version3 조회는 전체 update·정규화·저장 없이 현재 원본을 반환한다', { timeout: 30000 }, async () => {
  const f = await setup(); const repo = f.binding.inventoryRepository, update = repo.updateInventoryWithRetry;
  let o;
  try {
    const expected = (await repo.downloadInventory(f.uid)).data;
    repo.updateInventoryWithRetry = () => assert.fail('정상 조회의 전체 update 금지');
    const before = await f.binding.transition.inspect(); o = observe(f.connection.targetDatabase);
    const migration = f.load('functions/services/inventoryMigrationService.js');
    const actual = await migration.ensureInventoryV2(f.uid);
    assert.deepEqual(actual, expected); assert(o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    assert(o.writes.every(path => path.startsWith('inventoryReadSnapshotRequests/')));
    assert.equal((await f.connection.targetDatabase.ref(f.requestPath).get()).exists(), true);
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { o?.close(); repo.updateInventoryWithRetry = update; await f.close(); }
});
test('실제 demo 전체 조회 복사본은 카드별 GET을0으로 줄이고 완전한 동일 응답을 반환한다', { timeout: 30000 }, async () => {
  const f = await setup(40); let o;
  try {
    const routes = f.load('functions/routes/registration.js');
    const expected = await call(routes.getRegistrationStatus, { method: 'GET', query: { includeUserData: 'true' } });
    assert.equal((await f.rebuild()).status, 'stored');
    const before = await f.binding.transition.inspect(); o = observe(f.connection.targetDatabase);
    const response = await call(routes.getRegistrationStatus, { method: 'GET', query: { includeUserData: 'true' } });
    assert.equal(response.statusCode, 200);
    for (const field of ['allCards', 'amount', 'locations', 'rarities', 'names', 'inventoryVersion', 'inventoryMigration', 'settings', 'sourceMembership'])
      assert.deepEqual(response.body.initialData[field], expected.body.initialData[field], field);
    assert.equal(o.reads.filter(path => path.startsWith('inventoryCardVersions/')).length, 0);
    assert.equal(o.reads.filter(path => path.startsWith('inventoryReadSnapshots/')).length, 1);
    assert.equal(o.writes.length, 0); assert.deepEqual(await f.binding.transition.inspect(), before);
    o.reads.length = 0;
    assert.equal((await f.rebuild()).status, 'unchanged');
    assert(!o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    console.log(JSON.stringify({ event: 'synthetic_inventory_read_view', cardTypes: 40, cardBodyGets: 0, viewGets: 1, canonicalWrites: 0, production: false }));
  } finally { o?.close(); await f.close(); }
});

for (const kind of ['quantity', 'missing', 'revision', 'generation', 'epoch', 'header', 'invalid-json']) test(`복사본 ${kind} 변조/불일치는 원본 전체 조회로 돌아간다`, { timeout: 30000 }, async () => {
  const f = await setup(2); let o;
  try {
    await f.rebuild(); const ref = f.connection.targetDatabase.ref(f.viewPath), raw = (await ref.get()).val();
    if (kind === 'missing') await ref.remove();
    else {
      if (['revision', 'generation', 'epoch'].includes(kind)) raw.source[kind]++;
      else if (kind === 'invalid-json') raw.payload = '{';
      else { const p = JSON.parse(raw.payload); if (kind === 'header') p.header.inventoryVersion = 99;
        else p.cards[0].number = 'forged'; raw.payload = JSON.stringify(p); }
      await ref.set(raw);
    }
    o = observe(f.connection.targetDatabase);
    const actual = await f.binding.inventoryRepository.readPreparedInventory(f.uid);
    assert.equal(actual.value.amount, 3); assert.equal(Object.keys(actual.value.cards).length, 2);
    assert(o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    assert(o.writes.every(path => path.startsWith('inventoryReadSnapshotRequests/')));
  } finally { o?.close(); await f.close(); }
});

test('다른 세션의 부분 수량 변경·전체 초기화·재생성은 이전 복사본을 최신으로 반환하지 않는다', { timeout: 30000 }, async () => {
  const f = await setup(1); let o;
  try {
    await f.rebuild();
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards['A-0'].items[0].qty = 8; inv.amount = 8; inv.rarities.N = 8;
    }, 3, { cardNumbers: ['A-0'] });
    o = observe(f.connection.targetDatabase); const updated = await f.binding.inventoryRepository.readPreparedInventory(f.uid);
    assert.equal(updated.value.amount, 8); assert(o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    o.close(); o = undefined; await f.rebuild();
    await f.binding.inventoryRepository.deleteInventory(f.uid);
    const cleared = await f.binding.inventoryRepository.readPreparedInventory(f.uid); assert.equal(cleared.value.amount, 0);
    await f.rebuild(); const raw = (await f.connection.targetDatabase.ref(f.viewPath).get()).val();
    assert.equal(raw.payload ?? null, null); assert.equal(raw.source.exists, false);
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards = { NEW: { name: '새 카드', cid: '999', items: [{ qty: 2, rarity: 'N', loc: '상자', illustration: '1' }] } };
      inv.amount = 2; inv.locations = { 상자: ['NEW'] }; inv.rarities = { N: 2 };
    });
    const recreated = await f.binding.inventoryRepository.readPreparedInventory(f.uid);
    assert.equal(recreated.value.amount, 2); assert.equal(Object.hasOwn(recreated.value.cards, 'A-0'), false);
  } finally { o?.close(); await f.close(); }
});

test('조건부 unchanged도 현재 metadata/전환을 확인하며 전체 조회 복사본과 API 계약을 함께 유지한다', { timeout: 30000 }, async () => {
  const f = await setup(3); let o;
  try {
    await f.rebuild(); const first = await f.binding.inventoryRepository.readInventoryForSync(f.uid);
    assert.equal(first.data.amount, 6); assert.match(first.token, /^i1:/);
    o = observe(f.connection.targetDatabase);
    const result = await f.binding.inventoryRepository.readInventoryForSync(f.uid, first.token);
    assert.equal(result.unchanged, true); assert.equal(result.data, undefined);
    assert(!o.reads.some(path => path.startsWith('inventoryCardVersions/') || path.startsWith('inventoryReadSnapshots/')));
    assert.equal(o.writes.length, 0);
  } finally { o?.close(); await f.close(); }
});

test('drain·역전환에서는 조회 복사본을 권한이나 새 원본으로 사용하지 않는다', { timeout: 30000 }, async () => {
  const f = await setup(1);
  try {
    await f.rebuild(); const writer = await f.binding.transition.route(); await f.binding.transition.drain(writer);
    assert.equal(await f.binding.inventoryRepository.readPreparedInventory(f.uid), undefined);
    assert.equal((await f.rebuild()).status, 'skipped');
    await f.binding.transition.resume(writer, { id: 'c'.repeat(32), writersDrained: true });
    const active = await f.binding.transition.route(); await f.binding.transition.copy(active);
    await f.binding.transition.drain(active); await f.binding.transition.activate(active);
    assert.equal((await f.binding.transition.route()).backend, 'legacy');
    assert.equal(await f.binding.inventoryRepository.readPreparedInventory(f.uid), undefined);
    assert.equal((await f.binding.inventoryRepository.downloadInventory(f.uid)).data.amount, 1);
  } finally { await f.close(); }
});
test('수정·복구는 조회 복사본으로 원본 누락을 숨기거나 변경을 실행하지 않는다', { timeout: 30000 }, async () => {
  const f = await setup(1);
  try {
    await f.rebuild();
    const root = (await f.connection.targetDatabase.ref(`inventories/${encodeKey(f.uid)}`).get()).val();
    const [hash, ref] = Object.entries(root.payload.cards).find(([key]) => key.startsWith('h'));
    await f.connection.targetDatabase.ref(`inventoryCardVersions/${encodeKey(f.uid)}/${hash}/${ref.v}`).remove();
    let called = 0;
    await assert.rejects(f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, () => { called++; }),
      { code: 'USER_STORAGE_MISSING_CARD_VERSION' });
    assert.equal(called, 0);
    assert.equal((await f.connection.targetDatabase.ref(`inventories/${encodeKey(f.uid)}/revision`).get()).val(), root.revision);
  } finally { await f.close(); }
});

test('조회 복사본 읽기·재생성 신호 장애는 원본 조회와 후속 쓰기를 막지 않는다', { timeout: 30000 }, async () => {
  const f = await setup(2), database = f.connection.targetDatabase, original = database.ref;
  try {
    database.ref = path => {
      const ref = original(path);
      if (path.startsWith('inventoryReadSnapshots/')) ref.get = async () => { throw Error('synthetic view read failure'); };
      if (path.startsWith('inventoryReadSnapshotRequests/')) ref.transaction = async () => { throw Error('synthetic request failure'); };
      return ref;
    };
    const value = await f.binding.inventoryRepository.readPreparedInventory(f.uid);
    assert.equal(value.value.amount, 3);
    database.ref = original;
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards['A-0'].items[0].qty = 4; inv.amount = 6; inv.rarities.N = 6;
    }, 3, { cardNumbers: ['A-0'] });
    assert.equal((await f.binding.inventoryRepository.downloadInventory(f.uid)).data.amount, 6);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { database.ref = original; await f.close(); }
});
