'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { fixture, call } = require('./commonWriterFixture.cjs');
async function setup() {
  const f = await fixture(); await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w);
  await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
    inv.cards = { 'SYN-1': { name: '합성 카드', cid: '100', items: [{ qty: 2, loc: '합성 위치', rarity: 'N', illustration: '1' }] } };
    inv.amount = 2; inv.locations = { '합성 위치': ['SYN-1'] }; inv.rarities = { N: 2 };
  });
  f.user = f.load('functions/routes/user.js'); f.claims = f.load('functions/services/membershipClaims.js');
  assert.equal((await call(f.user.getUserData, { method: 'GET' })).statusCode, 200); return f;
}
const read = (f, token, extra = {}) => call(f.user.getUserData, { body: { inventoryConditional: true,
  membershipClaimsReadOnly: true, ...(token ? { inventoryToken: token } : {}), ...extra } });
function observe(database) {
  const original = database.ref, gets = [], transactions = [];
  database.ref = path => { const ref = original(path); for (const [method, list] of [['get', gets], ['transaction', transactions]]) {
    const work = ref[method].bind(ref); ref[method] = (...args) => { list.push(path); return work(...args); };
  } return ref; };
  return { gets, transactions, close() { database.ref = original; } };
}
test('동일 실제 RTDB head는 카드 본문·전체 head·저장을 읽지 않고 프로필·claims만 새로 확인한다', async () => {
  const f = await setup(); let o;
  try {
    const first = await read(f); assert.equal(first.statusCode, 200); assert.equal(first.body.allCards.length, 1);
    assert.equal(first.body.inventorySync.status, 'full'); assert.match(first.body.inventorySync.token, /^i1:[a-f0-9]{64}$/);
    await f.binding.repository.updateNickname(f.uid, '새 합성 이름');
    const before = await f.binding.transition.inspect(); o = observe(f.connection.targetDatabase);
    const next = await read(f, first.body.inventorySync.token); assert.equal(next.statusCode, 200);
    assert.equal(next.body.inventorySync.status, 'unchanged'); assert.equal(next.body.nickname, '새 합성 이름');
    assert.equal(next.body.membershipClaims.status, 'synced');
    for (const key of ['allCards', 'amount', 'locations', 'rarities', 'names', 'inventoryVersion']) assert(!Object.hasOwn(next.body, key));
    assert(!o.gets.some(p => p.startsWith('inventoryCardVersions/') || /^inventories\/[^/]+$/.test(p)));
    assert.equal(o.transactions.length, 0); o.close(); o = undefined;
    assert.deepEqual(await f.binding.transition.inspect(), before);
    console.log(JSON.stringify({ event: 'synthetic_inventory_conditional_read', cardBodyReads: 0, fullHeadReads: 0, transactions: 0, oauth: false, production: false }));
  } finally { o?.close(); await f.close(); }
});
test('다른 세션의 수량 변경·전체 초기화·재생성은 기존 token을 재사용하지 않는다', async () => {
  const f = await setup();
  try {
    const old = (await read(f)).body.inventorySync.token;
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => { inv.cards['SYN-1'].items[0].qty = 3; inv.amount = 3; inv.rarities.N = 3; });
    const next = await read(f, old); assert.equal(next.body.inventorySync.status, 'full'); assert.equal(next.body.amount, 3); assert.notEqual(next.body.inventorySync.token, old);
    await f.binding.inventoryRepository.deleteInventory(f.uid);
    const empty = await read(f, next.body.inventorySync.token); assert.equal(empty.body.inventorySync.status, 'full'); assert.deepEqual(empty.body.allCards, []);
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => { inv.cards = {}; });
    assert.equal((await read(f, old)).body.inventorySync.status, 'full');
  } finally { await f.close(); }
});
test('계정이 다르면 token은 전용 경로로 처리하며 권한 회수·claims 미확정은 숨기지 않는다', async () => {
  const f = await setup();
  try {
    const token = (await read(f)).body.inventorySync.token;
    await f.binding.repository.completeRegistration(f.owner, { terms: 'synthetic', privacy: 'synthetic' });
    const other = await call(f.user.getUserData, { token: 'owner', body: { inventoryConditional: true, inventoryToken: token, membershipClaimsReadOnly: true } });
    assert.equal(other.body.inventorySync.status, 'full'); assert.deepEqual(other.body.allCards, []);
    const lock = f.binding.claimsStorage.customClaims, op = await lock.acquire(f.uid); await lock.finish(f.uid, op, true);
    const pending = await read(f, token); assert.equal(pending.body.inventorySync.status, 'unchanged');
    assert.equal(pending.body.membershipClaims.status, 'pending'); assert.equal((await lock.inspect(f.uid)).state, 'uncertain');
  } finally { await f.close(); }
});
test('역전환·재전환 epoch가 바뀌면 전체 조회하며 기존 옵션 없는 API 응답을 유지한다', async () => {
  const f = await setup();
  try {
    const token = (await read(f)).body.inventorySync.token;
    for (const backend of ['legacy', 'rtdb']) {
      const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w);
      assert.equal((await f.binding.transition.route()).backend, backend);
      const response = await read(f, token); assert.equal(response.statusCode, 200); assert.equal(response.body.inventorySync.status, 'full'); assert.equal(response.body.amount, 2);
    }
    const legacy = await call(f.user.getUserData, { method: 'GET' }); assert(Array.isArray(legacy.body.allCards)); assert(!Object.hasOwn(legacy.body, 'inventorySync'));
  } finally { await f.close(); }
});

test('합성 카드200개에서 조건부 조회는 본문 GET/전체 변환·전송량을 줄인다', async () => {
  const f = await setup(); let original;
  try {
    await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['SYN-' + i, { name: '합성 카드' + i, cid: String(1000+i), items: [{ qty: 1, loc: '합성 위치', rarity: 'N', illustration: '1' }] }]));
      inv.amount = 200; inv.locations = { '합성 위치': Object.keys(inv.cards) }; inv.rarities = { N: 200 };
    });
    const token = (await read(f)).body.inventorySync.token, samples = [];
    for (const conditional of [false, true]) {
      const db = f.connection.targetDatabase; original = db.ref; let reads = 0, cardReads = 0, bytes = 0;
      db.ref = path => { const ref = original(path), get = ref.get.bind(ref); ref.get = async (...args) => {
        reads++; if (path.startsWith('inventoryCardVersions/')) cardReads++;
        await new Promise(resolve => setTimeout(resolve, 25)); const value = await get(...args);
        bytes += Buffer.byteLength(JSON.stringify(value.val())); return value;
      }; return ref; };
      const start = performance.now(), response = await call(f.user.getUserData, { body: conditional
        ? { inventoryConditional: true, inventoryToken: token, membershipClaimsReadOnly: true } : { membershipClaimsReadOnly: true } });
      const sample = { conditional, durationMs: Math.round((performance.now()-start)*1000)/1000, gets: reads, cardBodyGets: cardReads, readBytes: bytes, responseBytes: Buffer.byteLength(JSON.stringify(response.body)) };
      db.ref = original; original = undefined; assert.equal(response.statusCode, 200);
      if (conditional) { assert.equal(response.body.inventorySync.status, 'unchanged'); assert.equal(cardReads, 0); }
      else assert.equal(response.body.allCards.length, 200);
      samples.push(sample);
    }
    assert(samples[1].responseBytes < samples[0].responseBytes / 4); assert(samples[1].readBytes < samples[0].readBytes);
    console.log(JSON.stringify({ event: 'synthetic_inventory_conditional_comparison', cards: 200, simulatedGetDelayMs: 25, actualOAuth: false, productionLatency: false, samples }));
  } finally { if (original) f.connection.targetDatabase.ref = original; await f.close(); }
});

test('미확정 CID는 실제 RTDB 기한 전 본문을 생략하고 같은 revision이어도 기한부터 전체 준비한다', async () => {
 const f=await setup();let o;
 try {
  await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid,inv=>{inv.cards['SYN-1'].cid=null;inv.cards['SYN-1'].cidCheckedAt=Date.now();});
  const first=await read(f);assert.equal(first.statusCode,200);assert.equal(first.body.inventoryMigration.unresolvedCount,1);assert(first.body.inventorySync.token);
  o=observe(f.connection.targetDatabase);const next=await read(f,first.body.inventorySync.token);
  assert.equal(next.body.inventorySync.status,'unchanged');assert(!o.gets.some(p=>p.startsWith('inventoryCardVersions/')));assert.equal(o.transactions.length,0);o.close();o=undefined;
  const {createPartitionedInventoryStore}=f.load('functions/services/user-storage/partitionedInventoryStore.js');
  const store=createPartitionedInventoryStore({database:f.connection.targetDatabase});
  const metadata=await store.readMetadata(f.uid,{forSync:true}),record=await store.read(f.uid),writer=await f.binding.transition.route();
  assert(metadata.syncMigration.nextRetryAt>Date.now());let clock=metadata.syncMigration.nextRetryAt-1,full=0;
  const reader=f.load('functions/services/inventoryConditionalSync.js').createInventorySyncReader({now:()=>clock,route:async()=>writer,metadata:uid=>store.readMetadata(uid,{forSync:true}),snapshot:async()=>{full++;return record;},migrationStatus:()=>({status:'complete'})});
  assert.equal((await reader(f.uid,first.body.inventorySync.token)).unchanged,true);clock++;
  assert.equal((await reader(f.uid,first.body.inventorySync.token)).unchanged,undefined);assert.equal(full,1);
  assert.equal((await store.readMetadata(f.uid)).revision,metadata.revision);
 } finally{o?.close();await f.close();}
});
