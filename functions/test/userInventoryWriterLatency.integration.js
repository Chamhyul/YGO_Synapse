'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createInventoryWriterAdapters, splitStable } = require('../services/userInventoryWriterAdapters');
const { fingerprint } = require('../services/userMigrationRehearsal');
const { encodeKey } = require('../services/user-storage/codec');
const { processAddCards, processMoveCards } = require('../utils/inventoryStorage');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete', pendingCount: 0, unresolvedCount: 0, retryAt: 0 }) };
const fixture = () => ({ version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: 3,
  locations: { '합성 보관함': ['A', 'B'] }, rarities: { SR: 1, N: 2 },
  cards: {
    A: { name: '합성 A', cid: '100', items: [{ rarity: 'SR', qty: 1, loc: '합성 보관함', illustration: '1' }] },
    B: { name: '합성 B', cid: '200', items: [{ rarity: 'N', qty: 2, loc: '합성 보관함', illustration: '1' }] },
  } });
async function setup() {
  const runId = id(), connection = open(runId);
  const options = { db: connection.db, database: connection.targetDatabase, bucket: connection.bucket,
    FieldValue, runId, migration, now: () => '2020-02-01T00:00:00.000Z' };
  const bootstrap = createUserInventoryWriterBinding(options); await bootstrap.initialize();
  return { connection, bootstrap, options, close: () => connection.close() };
}
async function switchTo(binding) {
  const writer = await binding.transition.route();
  await binding.transition.copy(writer); await binding.transition.drain(writer);
  return binding.transition.activate(writer);
}
function observe(database, delayMs = 0) {
  const original = database.ref, calls = { get: [], transaction: [], on: [] };
  database.ref = path => {
    const ref = original(path);
    for (const name of Object.keys(calls)) {
      const method = ref[name].bind(ref);
      ref[name] = (...args) => {
        calls[name].push(path);
        if (name === 'get' && delayMs) return new Promise(resolve => setTimeout(resolve, delayMs)).then(() => method(...args));
        return method(...args);
      };
    }
    return ref;
  };
  return { calls, restore() { database.ref = original; } };
}

// 운영이 사용하는 initializeMissing:false와 초기화 promise를 캐시하는 시험
// 설정을 모두 검증한다. 이전 epoch의 route를 다음 요청으로 캐시하면 안 된다.
for (const initializeMissing of [false, true]) test(`인벤토리 route 재사용은 initializeMissing:${initializeMissing}에서 전환·역전환을 따른다`, async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    const binding = createUserInventoryWriterBinding({ ...f.options, initializeMissing });
    await binding.initialize();
    let routes = 0;
    const route = binding.transition.route; binding.transition.route = async () => { routes++; return route(); };
    for (const backend of ['legacy', 'rtdb', 'legacy']) {
      assert.equal((await route()).backend, backend); routes = 0;
      assert.deepEqual((await binding.inventoryRepository.downloadInventory('u')).data, fixture());
      assert.equal(routes, 1, '요청마다 현재 route를 한 번 읽고 이전 요청 값을 재사용하지 않는다');
      if (backend === 'rtdb' || (await route()).epoch === 1) await switchTo(binding);
    }
  } finally { await f.close(); }
});

test('합성 SDK 지연을 고정한 RTDB 부분 수정은 같은 응답·영수증·선택 카드 범위를 유지한다', async t => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    await switchTo(f.bootstrap);
    const binding = createUserInventoryWriterBinding({ ...f.options, initializeMissing: false });
    // 단순 부분 수정만 계측한다. 프로필/claims/HTTP/IAM 지연은 포함하지 않는다.
    let expectedAmount = 3;
    for (const delayMs of [0, 20]) {
      const samples = [];
      for (let index = 0; index < 3; index++) {
        for (const action of ['add', 'move']) {
          const historyBefore = await binding.transition.historyStatus();
          const meter = observe(f.connection.targetDatabase, delayMs), start = performance.now();
          let saved, results;
          try {
            saved = await binding.inventoryRepository.updateInventoryWithRetry('u', value => {
              results = [];
              if (action === 'add') processAddCards(value, { A: { name: '합성 A', cid: '100',
                items: [{ rarity: 'SR', qty: 1, loc: '합성 보관함', illustration: '1', requestIndex: 0 }] } }, results);
              else processMoveCards(value, [{ cardNo: 'A', rarity: 'SR', proc: '1', currentLoc: '합성 보관함', targetLoc: '합성 이동함', moveQty: 1 }], results);
            }, 3, { cardNumbers: ['A'] });
          } finally { meter.restore(); }
          if (action === 'add') expectedAmount++;
          assert.deepEqual(results.map(result => result.status), ['success']);
          assert.equal(saved.amount, expectedAmount); assert.equal(saved.cards.B, undefined);
          const head = `inventories/${encodeKey('u')}`;
          const sample = { action, elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
            get: meter.calls.get.length, headGet: meter.calls.get.filter(path => path === head).length,
            routeGet: meter.calls.get.filter(path => path.startsWith('profileWriterTransitions/') && path.endsWith('/head')).length,
            transaction: meter.calls.transaction.length, listener: meter.calls.on.length };
          sample.maintenance = (await binding.transition.historyStatus()).version !== historyBefore.version;
          if (!sample.maintenance) assert.deepEqual({ get: sample.get, headGet: sample.headGet, routeGet: sample.routeGet,
            transaction: sample.transaction, listener: sample.listener },
          { get: 8, headGet: 2, routeGet: 1, transaction: 5, listener: 2 });
          else assert(sample.transaction > 6, '이력 정리 쓰기는 일반 업무 CAS와 구분한다');
          samples.push(sample);
          const full = (await binding.inventoryRepository.downloadInventory('u')).data;
          assert.equal(full.cards.B.items[0].qty, 2); assert.equal(full.cards.A.name, saved.cards.A.name);
          assert.equal(full.amount, expectedAmount);
          assert.equal((await binding.transition.inspect()).unresolved, 0);
        }
      }
      t.diagnostic(JSON.stringify({ delayPerGetMs: delayMs, samples, maxRssKiB: process.resourceUsage().maxRSS }));
    }
  } finally { await f.close(); }
});

function operation(current, data) {
  const candidate = splitStable(data), operationId = id();
  const changes = [{ key: 'inventory/u', exists: true, token: current.token, value: { exists: true, manifest: candidate.manifest } }];
  const details = { kind: 'inventory', blobs: candidate.blobs };
  return { id: operationId, digest: fingerprint({ changes, details }), changes, details, result: null };
}
test('같은 native snapshot의 영수증 조회 중 다른 SDK가 fence하면 늦은 CAS와 중복 제출을 거부한다', async () => {
  const f = await setup(), second = open(f.options.runId); let release, meter;
  try {
    const adapter = f.bootstrap.inventories.rtdb;
    const initial = operation(await adapter.read('inventory/u'), fixture()); await adapter.commit(initial);
    const changed = fixture(); changed.cards.A.name = '반영되면 안 되는 변경';
    const op = operation(await adapter.read('inventory/u'), changed);
    let entered, once = true;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const original = f.connection.targetDatabase.ref;
    f.connection.targetDatabase.ref = path => {
      const ref = original(path), get = ref.get.bind(ref);
      if (path.startsWith('inventoryWriterReceipts/')) ref.get = async () => {
        const snapshot = await get();
        if (once) { once = false; entered(); await gate; }
        return snapshot;
      };
      return ref;
    };
    meter = { restore() { f.connection.targetDatabase.ref = original; } };
    const pending = adapter.commit(op); await Promise.race([ready, pending.then(() => assert.fail('경쟁 경계 전에 저장됨'))]);
    const remote = createInventoryWriterAdapters({ db: second.db, database: second.targetDatabase, bucket: second.bucket, FieldValue }).rtdb;
    assert.equal((await remote.fence(op)).outcome, 'cancelled');
    release(); await pending; meter.restore();
    assert.equal((await adapter.receipt(op)).outcome, 'cancelled'); assert.equal(await adapter.cancellationReason(op), 'fenced');
    const fenced = await adapter.read('inventory/u');
    await adapter.commit(op); assert.deepEqual(await adapter.read('inventory/u'), fenced);
    assert.deepEqual(fenced.value.manifest, initial.changes[0].value.manifest);
  } finally { release?.(); meter?.restore(); await Promise.all([f.close(), second.close()]); }
});

test('RTDB 저장은 native snapshot 한 번으로 시작하고 이전 영수증 재실행·다른 digest를 계속 구분한다', async () => {
  const f = await setup();
  try {
    const adapter = f.bootstrap.inventories.rtdb;
    const first = operation(await adapter.read('inventory/u'), fixture());
    const meter = observe(f.connection.targetDatabase);
    try { await adapter.commit(first); }
    finally { meter.restore(); }
    assert.equal(meter.calls.get.filter(path => path === `inventories/${encodeKey('u')}`).length, 1);
    const changed = fixture(); changed.cards.A.name = '후속 변경';
    const next = operation(await adapter.read('inventory/u'), changed); await adapter.commit(next);
    const current = await adapter.read('inventory/u');
    await adapter.commit(first);
    assert.deepEqual(await adapter.read('inventory/u'), current);
    assert.equal((await adapter.receipt(first)).changes[0].token, '1:0');
    await assert.rejects(adapter.commit({ ...first, digest: 'a'.repeat(64) }), { code: 'INVENTORY_WRITER_RECEIPT_CONFLICT' });
    assert.deepEqual(await adapter.read('inventory/u'), current);
  } finally { await f.close(); }
});
