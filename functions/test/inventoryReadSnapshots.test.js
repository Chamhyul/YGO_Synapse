'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createInventoryReadSnapshots } = require('../services/inventoryReadSnapshots');
const { splitInventory } = require('../services/user-storage/inventoryManifest');
const { encodeKey } = require('../services/user-storage/codec');
const { fingerprint } = require('../services/userMigrationRehearsal');
const { createInventorySnapshotWorker } = require('../services/inventorySnapshotWorker');
function fixture(options = {}) {
  const rows = new Map(), calls = [], writer = { backend: 'rtdb', epoch: 1, phase: 'accepting' }, runId = 'a'.repeat(32);
  const database = { ref(path) { calls.push(path); return {
    async get() { return { val: () => rows.get(path) ?? null }; },
    async transaction(update) { const value = update(rows.get(path) ?? null); if (value !== undefined) rows.set(path, value);
      return { committed: value !== undefined, snapshot: { val: () => rows.get(path) ?? null } }; },
  }; } };
  const split = splitInventory({ inventory: { version: 3, amount: 2, locations: { '상자': ['A'] }, rarities: { '기본': 2 },
    cards: { A: { name: '합성', cid: '101', items: [{ qty: 2, rarity: '기본', loc: '상자', illustration: '1' }] } } },
    locationState: { locationNames: {}, nextLocationId: 1 } }, { uid: 'synthetic' });
  const blobs = {};
  for (const b of split.blobs) { split.manifest.cards[b.hash].v = fingerprint(b.value).slice(0, 32); blobs[b.hash] = b.value; }
  // scope 대조에만 사용하는 원본 manifest다. codec/API 요약 검증은 native 통합 검사에서 수행한다.
  const head = { exists: true, revision: 4, generation: 0, value: split.manifest };
  const store = createInventoryReadSnapshots({ database, runId, getWriter: () => writer,
    verifyBlob: (value, token) => assert.equal(fingerprint(value).slice(0, 32), token), ...options });
  return { rows, calls, writer, head, store, blobs, runId,
    path: `inventoryReadSnapshots/${encodeKey(runId)}/${encodeKey('synthetic')}` };
}
test('전체 복사본1건이 현재 UID·epoch·revision·세대·manifest 및 모든 카드 지문과 일치해야 사용한다', async () => {
  const f = fixture(); assert.equal((await f.store.save('synthetic', { head: f.head, blobs: f.blobs })).status, 'stored');
  const raw = await f.store.load('synthetic');
  assert.deepEqual(f.store.unpack('synthetic', f.head, raw), Object.assign(Object.create(null), f.blobs));
  for (const field of ['revision', 'generation']) assert.equal(f.store.unpack('synthetic', { ...f.head, [field]: f.head[field] + 1 }, raw), undefined);
  assert.equal(f.store.unpack('other', f.head, raw), undefined);
  f.writer.epoch++; assert.equal(f.store.unpack('synthetic', f.head, raw), undefined);
  assert(f.calls.every(path => path.startsWith('inventoryReadSnapshots/')));
});
test('수량 변조·누락·추가 카드와 잘못된 헤더는 원본 조회로 복귀할 검증 오류다', async () => {
  const f = fixture(); await f.store.save('synthetic', { head: f.head, blobs: f.blobs });
  const raw = await f.store.load('synthetic');
  for (const change of [p => p.cards.pop(), p => p.cards.push(p.cards[0]), p => p.header.inventoryVersion = 99,
    p => { p.cards[0].number = 'forged'; }]) {
    const p = JSON.parse(raw.payload); change(p);
    assert.throws(() => f.store.unpack('synthetic', f.head, { ...raw, payload: JSON.stringify(p) }));
  }
});
test('늦은 worker는 최신 복사본이나 초기화 후 tombstone 장벽을 되돌리지 않는다', async () => {
  const f = fixture(), fresh = { ...f.head, revision: 8, generation: 1 };
  await f.store.save('synthetic', { head: fresh, blobs: f.blobs });
  assert.equal((await f.store.save('synthetic', { head: f.head, blobs: f.blobs })).status, 'unchanged');
  const cleared = { ...fresh, exists: false, revision: 9 };
  await f.store.save('synthetic', { head: cleared, blobs: f.blobs });
  assert.equal((await f.store.load('synthetic')).payload, null);
  await f.store.save('synthetic', { head: fresh, blobs: f.blobs });
  assert.equal((await f.store.load('synthetic')).source.revision, 9);
});
test('누락 요청은 작은 영속 신호만 쓰며 원본 카드·head·journal에 접근하지 않는다', async () => {
  const f = fixture(); await f.store.request('synthetic', f.head);
  assert(f.calls.every(path => path.startsWith('inventoryReadSnapshotRequests/')));
  const raw = [...f.rows.values()][0]; assert.equal(raw.source.revision, 4);
  assert.equal(Object.hasOwn(raw, 'payload'), false); assert.match(raw.nonce, /^[a-f0-9]{32}$/);
});
test('worker는 올바른 인스턴스·지역·run·UID만 처리하고 이벤트의 카드 본문을 쓰지 않는다', async () => {
  const config = { instanceId: 'synthetic', location: 'synthetic-region', runId: 'a'.repeat(32) }, calls = [];
  const handler = createInventorySnapshotWorker({ select: () => ({ config,
    binding: { rebuildInventoryReadSnapshot: async uid => { calls.push(uid); return { status: 'stored' }; } } }) });
  const event = { instance: config.instanceId, location: config.location,
    params: { userKey: encodeKey('synthetic'), runKey: encodeKey(config.runId) }, data: { after: { val: () => ({ forged: 'ignored' }) } } };
  await handler(event); assert.deepEqual(calls, ['synthetic']);
  for (const changed of [{ instance: 'other' }, { location: 'other' }, { params: { userKey: encodeKey('../other') } }]) await assert.rejects(handler({ ...event, ...changed }));
  await handler({ ...event, params: { ...event.params, runKey: encodeKey('b'.repeat(32)) } });
  assert.equal(calls.length, 1);
});
test('큰 복사본은 원본 조회를 유지하며 같은 revision의 재생성 요청을 반복하지 않는다', async () => {
  const f = fixture({ maxBytes: 1 });
  assert.equal((await f.store.save('synthetic', { head: f.head, blobs: f.blobs })).status, 'oversize');
  const raw = await f.store.load('synthetic'); assert.equal(raw.payload, null);
  assert.equal(f.store.unpack('synthetic', f.head, raw), undefined);
  f.calls.length = 0; await f.store.request('synthetic', f.head, raw); assert.equal(f.calls.length, 0);
});
for (const target of ['refreshInventoryReadSnapshot', 'prepareInventoryReadSnapshot']) test(`${target}는 자체 이벤트만 export하고 공개 HTTP·새 인증·원본 쓰기를 만들지 않는다`, () => {
  const { execFileSync } = require('node:child_process'), path = require('node:path');
  const script = `const f=require('./index');console.log(JSON.stringify({names:Object.keys(f),meta:f[process.env.FUNCTION_TARGET].__endpoint,
    unrelated:Object.keys(require.cache).filter(p=>['routes/inventory.js','routes/user.js','services/userInventoryWriterRepository.js'].some(n=>p.endsWith('/'+n)))}));`;
  const value = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-startup', K_SERVICE: 'synthetic', K_REVISION: 'synthetic', FUNCTION_TARGET: target } }).trim().split('\n').at(-1));
  assert.deepEqual(value.names, [target]); assert.deepEqual(value.unrelated, []);
  assert.equal(value.meta.eventTrigger.eventType, 'google.firebase.database.ref.v1.written');
  assert.equal(value.meta.eventTrigger.retry, true); assert.deepEqual(value.meta.region, ['asia-southeast1']);
});
