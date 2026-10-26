'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createAdminPageHandler } = require('../services/adminPageSession');
const { accountResource } = require('../services/user-storage/accountResource');
const id = () => randomBytes(16).toString('hex');

async function fixture({ getUserHook, summaryHook, templateHook, readHook } = {}) {
  const runId = id(), connection = open(runId), counters = new AsyncLocalStorage();
  const database = { ref(path) {
    const ref = connection.targetDatabase.ref(path);
    return new Proxy(ref, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (['get', 'transaction'].includes(key)) return (...args) => {
        const active = counters.getStore(); if (active) { active[key]++; readHook?.(path, key, active); }
        return value.apply(target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await createWriterJournalStore({ database }).update(runId, () => ({ value: {
    format: 1, backend: 'rtdb', epoch: 1, phase: 'accepting', sequence: 0,
    floor: 0, operations: {}, events: [], transfer: null, frozen: {},
  } }));
  const options = { db: connection.db, database, bucket: connection.bucket,
    FieldValue: require('firebase-admin/firestore').FieldValue, runId, initializeMissing: false, historyMaintenance: 'deferred',
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } };
  const binding = createUserInventoryWriterBinding(options), cookie = 'synthetic-' + id(), uid = 'synthetic-owner';
  const hash = createHash('sha256').update(cookie).digest('hex');
  await binding.adminSessions.set(hash, { uid, lastActivity: Date.now(), expiresAt: Date.now() + 3600000 });
  const auth = { verifySessionCookie: async () => ({ uid, auth_time: 1 }),
    getUser: async () => { const custom = await getUserHook?.(); if (custom) return custom; return { uid, disabled: false, customClaims: { role: 'owner' }, tokensValidAfterTime: new Date(0).toISOString() }; } };
  const handler = createAdminPageHandler({ auth, store: binding.adminSessions,
    template: async () => { await templateHook?.(); return '<html><body><div id="admin-content" data-admin-title="합성 계측">합성 본문</div></body></html>'; },
    membershipCsv: require('../services/membershipCsvService').createMembershipCsvService({ store: binding.membershipCsv }),
    getErrorSummary: async () => { await summaryHook?.(); return { syntheticPrivate: 'protected-result' }; } });
  return { ...binding, connection, options, hash, uid,
    async call(route) {
      const counts = { get: 0, transaction: 0 }, res = { statusCode: 200, set() { return this; }, type() { return this; },
        status(n) { this.statusCode = n; return this; }, send(value) { this.body = value; return this; }, json(value) { this.body = value; return this; } };
      await counters.run(counts, () => handler({ method: 'GET', url: route, originalUrl: route, protocol: 'https',
        headers: { host: 'synthetic.example', cookie: '__session=' + cookie } }, res));
      return { counts, res };
    }, close: () => connection.close() };
}

test('인증된 문서는 조회로만 승인하고 다음 요청은 새로 검사한다', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const { counts, res } = await f.call('/admin/cards');
      assert.equal(res.statusCode, 200); assert.match(res.body, /합성 본문/);
      assert.deepEqual(counts, { get: 5, transaction: 0 });
    }
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

test('읽기 API는 조회로만 사전·최종 권한과 마지막 세션을 확인한다', async () => {
  const f = await fixture();
  try {
    const { counts, res } = await f.call('/admin/api/errors');
    assert.equal(res.statusCode, 200); assert.equal(res.body.syntheticPrivate, 'protected-result');
    assert.deepEqual(counts, { get: 7, transaction: 0 });
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

test('읽기 요청은 잠금 종료 ACK 장애에 의존하거나 미확정 잠금을 만들지 않는다', async () => {
  const f = await fixture();
  try {
    const end = f.transition.endExternal;
    f.transition.endExternal = async (...args) => { await end(...args); throw Error('synthetic-private-end-failure'); };
    const { res } = await f.call('/admin/api/errors');
    assert.equal(res.statusCode, 200); assert.equal(res.body.syntheticPrivate, 'protected-result');
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

for (const kind of ['document', 'api']) test(`${kind} 승인 도중 다른 journal writer가 갱신해도 종료 CAS가 새 기록을 보존한다`, async () => {
  const f = await fixture(), foreign = createUserInventoryWriterBinding(f.options), foreignId = id(); let started = false;
  try {
    const get = () => f.adminSessions.get(f.hash);
    const changeForeign = async () => {
      await foreign.transition.beginExternal(await foreign.transition.route(), foreignId, [accountResource('synthetic-other')]);
      started = true;
    };
    if (kind === 'document') await f.adminSessions.withRequest({}, async () => {
      assert.equal((await get()).uid, f.uid); await changeForeign();
    }, { reuseJournal: true });
    else {
      let phases = 0;
      const outcome = await f.adminSessions.withReadRequest({}, async () => {
        const value = await get(); if (++phases === 2) await changeForeign(); return { uid: value.uid };
      }, async () => ({ synthetic: true }));
      assert.equal(outcome.access.uid, f.uid);
    }
    const state = (await createWriterJournalStore({ database: f.options.database }).read(f.transition.runId)).value;
    assert.equal(state.external[foreignId].status, 'running');
    assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    await foreign.transition.endExternal(foreignId); started = false;
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { if (started) await foreign.transition.endExternal(foreignId); await f.close(); }
});

for (const route of ['/admin/cards','/admin/api/errors']) test(`${route}: 같은 계정·세션의 쓰기 잠금이 있어도 읽기는 완료되고 잠금을 건드리지 않는다`, async()=>{
 const f=await fixture(),foreign=createUserInventoryWriterBinding(f.options),lease=id();let held=false;
 try{
  await foreign.transition.beginExternal(await foreign.transition.route(),lease,[accountResource(f.uid),'session/'+f.hash]);held=true;
  const response=await Promise.race([f.call(route),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('read waited for writer lease')),3000);t.unref();})]);
  assert.equal(response.res.statusCode,200);assert.equal(response.counts.transaction,0);
  assert.equal((await foreign.transition.inspect()).externalUnresolved,1);
  await foreign.transition.endExternal(lease);held=false;
 }finally{if(held)await foreign.transition.endExternal(lease);await f.close();}
});
for(const change of ['logout','replacement']) test(`최종 Auth 조회 도중 ${change}가 완료되면 결과를 보내지 않는다`,async()=>{
 let f,other,calls=0;
 f=await fixture({getUserHook:async()=>{if(++calls!==2)return;await other.adminSessions.remove(f.hash);
  if(change==='replacement')await other.adminSessions.set(f.hash,{uid:f.uid,lastActivity:Date.now(),expiresAt:Date.now()+3600000});}});
 other=createUserInventoryWriterBinding(f.options);
 try{const {res}=await f.call('/admin/api/errors');assert.equal(res.statusCode,401);assert.deepEqual(res.body,{success:false});}
 finally{await f.close();}
});
test('문서 template 준비 도중 로그아웃되면 보호 문서를 보내지 않는다',async()=>{
 let f,once=true;f=await fixture({templateHook:async()=>{if(once){once=false;await f.adminSessions.remove(f.hash);}}});
 try{const {res}=await f.call('/admin/cards');assert.equal(res.statusCode,200);assert.doesNotMatch(res.body,/합성 본문/);}
 finally{await f.close();}
});

test('마지막 세션 서버 조회 장애는 보호 데이터 없는503이며 쓰기나 재시도로 대체하지 않는다',async()=>{
 let reads=0;
 const f=await fixture({readHook:(path,key)=>{if(key==='get'&&path.startsWith('adminSessions/')&&++reads===3)throw Error('synthetic-private-read-failure');}});
 try{const{res,counts}=await f.call('/admin/api/errors');assert.equal(res.statusCode,503);assert.deepEqual(res.body,{success:false});assert.equal(counts.transaction,0);assert.equal(reads,3);}
 finally{await f.close();}
});

test('정적 문서는 최종 현재 Auth 1회만 확인하며 다음 문서/API는 별도 단계로 재조회한다',async()=>{
 let accounts=0;const f=await fixture({getUserHook:async()=>{accounts++;}});
 try{
  assert.equal((await f.call('/admin/cards')).res.statusCode,200);assert.equal(accounts,1);
  await f.call('/admin');assert.equal(accounts,2);
  await f.call('/admin/api/errors');assert.equal(accounts,4);
 }finally{await f.close();}
});
for(const kind of ['role','disabled','revoked'])test(`정적 template 준비 중 ${kind}가 바뀌면 최종 현재 Auth로 문서 제공을 차단한다`,async()=>{
 let changed=false,accounts=0;const f=await fixture({templateHook:async()=>{changed=true;},getUserHook:async()=>{
  accounts++;if(!changed)return;
  return {uid:'synthetic-owner',disabled:kind==='disabled',customClaims:{role:kind==='role'?'none':'owner'},tokensValidAfterTime:new Date(kind==='revoked'?2000:0).toISOString()};
 }});
 try{const {res}=await f.call('/admin/cards');assert.equal(res.statusCode,200);assert.doesNotMatch(res.body,/합성 본문/);assert.equal(accounts,1);}
 finally{await f.close();}
});

test('관리자 CSV 요약은 다른 CSV 쓰기 잠금 중에도 조회로만 현재 권한을 검사한다', async () => {
  const f = await fixture(); const external = id();
  try {
    // 이 fixture는 전환 header만 준비한다. 실제 이전으로 생기는 CSV control도 합성으로 준비한다.
    await f.csvAdapters.rtdb.apply(id(), { key: 'csv/control', exists: true, token: '0', value: { active: null, operations: {} } }, { exists: false, token: '0' });
    await f.transition.beginExternal(await f.transition.route(), external, ['csv/control']);
    const before = await f.transition.inspect();
    const { counts, res } = await f.call('/admin/api/membership-csv');
    assert.equal(res.statusCode, 200); assert.equal(res.body.count, 0);
    assert.equal(counts.transaction, 0);
    assert.deepEqual(await f.transition.inspect(), before);
    await f.transition.endExternal(external);
  } finally { await f.close(); }
});
