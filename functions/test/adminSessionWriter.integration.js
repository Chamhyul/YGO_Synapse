'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const { ABSOLUTE_MS, IDLE_MS } = require('../services/adminPageSession');
const { encodeKey } = require('../services/user-storage/codec');
const { createAdminSessionStore } = require('../services/user-storage/adminSessionStore');
const id = () => randomBytes(16).toString('hex'), hash = value => createHash('sha256').update(value).digest('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
async function setup(options = {}, runId = id()) {
  const connection = open(runId), binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config, migration, ...options });
  await binding.initialize(); return { ...binding, runId, connection, close: () => connection.close() };
}
async function flip(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
const fixture = (uid = 'synthetic-admin', now = Date.now()) => ({ uid, lastActivity: now, expiresAt: now + ABSOLUTE_MS });
test('기존 FS 세션과 갱신·발급·삭제는 프로필·인벤토리와 같은 epoch로 양방향 전환된다', async () => {
  const f = await setup(), a = hash(id()), b = hash(id());
  try {
    const source = fixture(); await f.connection.db.collection('AdminWebSessions').doc(a).set(source);
    assert.deepEqual(await f.adminSessions.get(a), source); await f.repository.updateSettings(source.uid, { theme: 'dark' });
    await flip(f); assert.deepEqual(await f.adminSessions.get(a), source);
    assert.equal(await f.adminSessions.touch(a, source.uid, source.lastActivity + 1), true);
    await f.adminSessions.set(b, fixture('new-admin')); assert.equal(await f.adminSessions.remove(a), true);
    await flip(f); assert.equal(await f.adminSessions.get(a), undefined); assert.equal((await f.adminSessions.get(b)).uid, 'new-admin');
    assert.equal((await f.repository.read(source.uid)).value.settings.theme, 'dark');
    assert.deepEqual(Object.keys((await f.connection.db.collection('AdminWebSessions').doc(b).get()).data()).sort(), ['expiresAt', 'lastActivity', 'uid']);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 오래된 만료/권한 관측은 갱신·재발급된 세션을 삭제하지 않는다`, async () => {
  const f = await setup(), key = hash(id());
  try {
    if (backend === 'rtdb') await flip(f);
    const initial = fixture(); await f.adminSessions.set(key, initial); const stale = await f.adminSessions.get(key);
    await f.adminSessions.touch(key, initial.uid, initial.lastActivity + 2);
    assert.equal(await f.adminSessions.remove(key, stale), false);
    await f.adminSessions.remove(key); await f.adminSessions.set(key, fixture(initial.uid, initial.lastActivity + 10));
    assert.equal(await f.adminSessions.remove(key, stale), false);
    assert.equal((await f.adminSessions.get(key)).lastActivity, initial.lastActivity + 10);
    await assert.rejects(f.adminSessions.remove(key, { ...stale }), { code: 'USER_STORAGE_INVALID_SESSION_OBSERVATION' });
  } finally { await f.close(); }
});
test('이전 epoch의 세션 관측으로 새 backend의 세션을 삭제하지 않는다', async () => {
  const f = await setup(), key = hash(id());
  try { await f.adminSessions.set(key, fixture()); const stale = await f.adminSessions.get(key); await flip(f);
    assert.equal(await f.adminSessions.remove(key, stale), false); assert.ok(await f.adminSessions.get(key));
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 임의 cookie logout은 부재 head/receipt/변경 기록을 만들지 않는다`, async () => {
  const f = await setup(), key = hash('synthetic-unknown');
  try { if (backend === 'rtdb') await flip(f); const before = await f.transition.inspect();
    assert.equal(await f.adminSessions.remove(key), false); assert.deepEqual(await f.transition.inspect(), before);
    assert.equal((await f.sessionAdapters[backend].inspect(`session/${key}`)).entry.token, '0');
    if (backend === 'rtdb') assert.equal((await f.connection.targetDatabase.ref(`adminSessions/${encodeKey(key)}`).get()).exists(), false);
    else assert.equal((await f.connection.db.collection('adminSessionWriterMetadata').get()).empty, true);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 세션 쓰기 응답 유실은 durable receipt로 복구하고 후속 갱신 뒤에도 보존한다`, async () => {
  let lost = false, opId;
  const f = await setup({ onCheckpoint: async (stage, value) => { if (lost && stage === 'businessCommitted') { lost = false; opId = value; throw new Error('synthetic lost ack'); } } }), key = hash(id());
  try { if (backend === 'rtdb') await flip(f); lost = true;
    await assert.rejects(f.adminSessions.set(key, fixture())); assert.equal((await f.transition.inspect()).unresolved, 1);
    const other = await setup({}, f.runId);
    try { await other.transition.recover(opId); } finally { await other.close(); }
    const value = await f.adminSessions.get(key); await f.adminSessions.touch(key, value.uid, value.lastActivity + 1);
    assert.equal(await f.transition.recover(opId), null); assert.equal((await f.transition.inspect()).unresolved, 0);
    await flip(f); assert.ok(await f.adminSessions.get(key));
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 늦은 세션 생성 RPC는 같은 DB 영구 fence 뒤에 로그인 상태를 복원하지 않는다`, async () => {
  const f = await setup(), other = await setup({}, f.runId), key = hash(id()); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try { if (backend === 'rtdb') await flip(f); const adapter = f.sessionAdapters[backend], original = adapter.commit; let op;
    adapter.commit = async value => { op = value; entered(); await gate; return original(value); };
    const pending = f.adminSessions.set(key, fixture()); await ready;
    assert.equal((await other.transition.fenceUncommitted(op.id)).status, 'cancelled'); await flip(f);
    release(); await assert.rejects(pending, { code: 'WRITER_CANCELLED' }); assert.equal(await f.adminSessions.get(key), undefined);
  } finally { release?.(); await other.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} logout·재발급 뒤 준비 전 오래된 활동 요청은 새 세션을 갱신하지 않는다`, async () => {
  const f = await setup(), key = hash(id()); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try { if (backend === 'rtdb') await flip(f); const initial = fixture(); await f.adminSessions.set(key, initial);
    const prepare = f.transition.prepareAndExecuteWithReceipt; let once = true;
    f.transition.prepareAndExecuteWithReceipt = async (...args) => { if (once && args[4]?.details.action === 'touch') { once = false; entered(); await gate; } return prepare(...args); };
    const pending = f.adminSessions.touch(key, initial.uid, initial.lastActivity + 100); await ready;
    await f.adminSessions.remove(key); await f.adminSessions.set(key, fixture(initial.uid, initial.lastActivity + 10));
    release(); assert.equal(await pending, false); assert.equal((await f.adminSessions.get(key)).lastActivity, initial.lastActivity + 10);
  } finally { release?.(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 두 SDK의 동시 activity는 재조회해 단조 시각을 유지한다`, async () => {
  const f = await setup(), other = await setup({}, f.runId), key = hash(id());
  try { if (backend === 'rtdb') await flip(f); const value = fixture(); await f.adminSessions.set(key, value);
    assert.deepEqual(await Promise.all([f.adminSessions.touch(key, value.uid, value.lastActivity + 10), other.adminSessions.touch(key, value.uid, value.lastActivity + 20)]), [true, true]);
    assert.equal((await f.adminSessions.get(key)).lastActivity, value.lastActivity + 20);
  } finally { await other.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 실제 CAS 콜백 전 idle 만료가 되면 활동 승인을 거부한다`, async () => {
  let now = Date.now(); const f = await setup({ sessionNow: () => now }), key = hash(id());
  try { if (backend === 'rtdb') await flip(f); const value = fixture('u', now); await f.adminSessions.set(key, value);
    if (backend === 'legacy') {
      const tx = f.connection.db.runTransaction; let once = true;
      f.connection.db.runTransaction = callback => tx(async transaction => {
        const get = transaction.get.bind(transaction);
        transaction.get = async ref => { if (once && ref.path.includes('/adminSessionWriterReceipts/')) { once = false; now += IDLE_MS; } return get(ref); };
        return callback(transaction);
      });
    } else {
      const database = f.connection.targetDatabase, ref = database.ref; let once = true;
      database.ref = path => { const target = ref(path), transaction = target.transaction.bind(target);
        target.transaction = (...args) => { if (once && path.startsWith('adminSessions/')) { once = false; now += IDLE_MS; } return transaction(...args); }; return target; };
    }
    assert.equal(await f.adminSessions.touch(key, value.uid, value.lastActivity + 1), false);
    assert.equal((await f.adminSessions.get(key)).lastActivity, value.lastActivity);
  } finally { await f.close(); }
});
test('기본 RTDB 세션 writer는 공통 commit receipt가 있는 head를 조용히 덮어쓰지 않는다', async () => {
  const f = await setup(), key = hash(id());
  try { await flip(f); await f.adminSessions.set(key, fixture());
    await assert.rejects(createAdminSessionStore({ database: f.connection.targetDatabase }).set(key, fixture()), { code: 'USER_STORAGE_INVALID_RECORD' });
    assert.ok(await f.adminSessions.get(key));
  } finally { await f.close(); }
});
async function httpHarness(surface = 'adminPages', services = {}) {
  let now = Date.now(), role = 'owner', disabled = false, revoked = false, issueHook, index = 0;
  const f = await setup({ sessionNow: () => now }), uid = 'synthetic-http-admin', issued = new Set();
  const auth = { verifyIdToken: async token => { if (token !== 'synthetic-token') throw new Error('synthetic-only'); return { uid, auth_time: Math.floor(Date.now()/1000) }; },
    getUser: async () => ({ uid, disabled, customClaims: { role } }),
    createSessionCookie: async () => { if (issueHook) await issueHook(); const value = 'synthetic-cookie-' + ++index; issued.add(value); return value; },
    verifySessionCookie: async cookie => { if (revoked || !issued.has(cookie)) throw Object.assign(new Error('synthetic-only'), { code: 'auth/session-cookie-revoked' }); return { uid, auth_time: Math.floor(Date.now()/1000) }; },
  };
  const forbidden = () => assert.fail('운영 연결 금지');
  const handlers = createAdminRouteHandlers({ env: { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId }, writerBinding: f,
    emulatorDependencies: { auth, now: () => now, template: name => fs.readFile(path.join(__dirname, '../templates/admin', name + '.html'), 'utf8'), ...services },
    productionDependencies: forbidden, proxy: forbidden });
  const app = express(); app.use(express.json()); app.use(handlers[surface]); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  async function call(route, method = 'GET', body = {}, extra = {}) {
    const isBackend = surface === 'adminBackend', origin = isBackend ? new URL(require('../services/adminTransport').BACKEND_URL).origin : base;
    const response = await fetch(base + (isBackend ? '/adminBackend?route=' + encodeURIComponent(route) : route), { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, text };
  }
  return { ...f, uid, call, cookie: () => cookie, advance: ms => { now += ms; }, setRole: value => { role = value; }, disable: () => { disabled = true; }, revoke: () => { revoked = true; }, issueHook: value => { issueHook = value; },
    close: async () => { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); await f.close(); } };
}
for (const surface of ['adminPages', 'adminBackend']) test(`HTTP ${surface} 로그인·문서·activity·권한 회수·logout은 양방향 전환에서 호환된다`, async () => {
  const f = await httpHarness(surface);
  try {
    assert.equal((await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' })).status, 200);
    assert.match(f.cookie(), /^__session=/); assert.match((await f.call('/admin/settings')).text, /id="admin-content"/);
    await flip(f); f.advance(1000);
    assert.equal((await f.call('/admin/session/activity', 'POST', { uid: f.uid })).status, 204);
    assert.match((await f.call('/admin')).text, /id="admin-content"/); await flip(f);
    f.setRole('none'); assert.doesNotMatch((await f.call('/admin')).text, /id="admin-content"/);
    f.setRole('owner'); assert.equal((await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' })).status, 200);
    assert.equal((await f.call('/admin/session/logout', 'POST')).status, 204); assert.doesNotMatch((await f.call('/admin')).text, /id="admin-content"/);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.doesNotMatch(JSON.stringify(await f.stores.legacy.snapshot()), /synthetic-cookie|synthetic-token/);
  } finally { await f.close(); }
});
test('HTTP 로그인 쿠키 발급 중 drain은 기다리고 기존 요청의 새 세션 키만 추가한다', async () => {
  const f = await httpHarness(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try { f.issueHook(async () => { entered(); await gate; });
    const pending = f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' }); await ready;
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    release(); assert.equal((await pending).status, 200); await f.transition.activate(writer);
    assert.match((await f.call('/admin')).text, /id="admin-content"/);
  } finally { release?.(); await f.close(); }
});
test('HTTP 일반 GET/임의 cookie는 세션·외부 작업을 생성하지 않으며 절대/idle 만료도 보존한다', async () => {
  const f = await httpHarness();
  try { const before = await f.transition.inspect();
    assert.equal((await f.call('/admin')).status, 200); assert.equal((await f.call('/admin/session', 'POST')).status, 401);
    assert.equal((await f.call('/admin/session/logout', 'POST', {}, { Cookie: '__session=synthetic-unknown' })).status, 204);
    assert.deepEqual(await f.transition.inspect(), before);
    await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' }); f.advance(IDLE_MS);
    assert.equal((await f.call('/admin/session/activity', 'POST', { uid: f.uid })).status, 401);
    await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' }); f.advance(ABSOLUTE_MS);
    assert.doesNotMatch((await f.call('/admin')).text, /id="admin-content"/);
  } finally { await f.close(); }
});

test('세션 UID는 경로 문자/Unicode를 포함해도 원문을 보존하고 Auth 역할 자원은 직렬화한다', async () => {
  const f = await setup(), key = hash(id()), uid = '합성/특수.#$[]😀';
  try { await f.adminSessions.set(key, fixture(uid)); await flip(f);
    const value = await f.adminSessions.get(key); assert.equal(value.uid, uid);
    await f.adminSessions.withRequest({}, async () => {
      await f.adminSessions.get(key); const writer = await f.transition.route();
      await assert.rejects(f.transition.beginExternal(writer, id(), [require('../services/user-storage/accountResource').accountResource(uid)]), { code: 'WRITER_RESOURCE_BUSY' });
    });
    await flip(f); assert.equal((await f.adminSessions.get(key)).uid, uid);
  } finally { await f.close(); }
});

test('같은 관리자 cookie의 병렬 문서 요청은 기존 요청 종료를 기다려 모두 성공한다', async () => {
  const f = await httpHarness();
  try { await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' });
    const results = await Promise.all([f.call('/admin'), f.call('/admin/settings')]);
    assert.deepEqual(results.map(result => result.status), [200, 200]);
    assert.ok(results.every(result => result.text.includes('id="admin-content"')));
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

for(const backend of ['legacy','rtdb']) test(`${backend} 새 세션은 fresh route·통합 CAS·확정 receipt를 같은 요청에서 재사용한다`,async()=>{
  const f=await setup();
  try{
    if(backend==='rtdb')await flip(f);
    const lean=createUserInventoryWriterBinding({db:f.connection.db,database:f.connection.targetDatabase,bucket:f.connection.bucket,
      FieldValue,runId:f.runId,config:f.connection.config,migration,initializeMissing:false});
    const route=lean.transition.route;let routes=0,receiptReads=0;
    lean.transition.route=async()=>{routes++;return route();};
    lean.transition.prepare=async()=>assert.fail('세션의 준비와 실행을 별도 CAS로 반복하지 않는다');
    lean.transition.execute=async()=>assert.fail('통합 실행 뒤 추가 execute를 하지 않는다');
    const receipt=lean.sessionAdapters[backend].receipt;
    lean.sessionAdapters[backend].receipt=async(...args)=>{receiptReads++;return receipt(...args);};
    const key=hash(id()),value=fixture();
    await lean.adminSessions.withRequest({},async()=>{
      await lean.adminSessions.beginLogin(value.uid);await lean.adminSessions.set(key,value);
    });
    assert.equal(routes,1);assert.equal(receiptReads,0);
    routes=0;
    await lean.adminSessions.withRequest({},async()=>assert.deepEqual(await lean.adminSessions.get(key),value));
    assert.equal(routes,2,'요청 최초 fresh 선택과 최종 epoch 검사는 유지한다');
    assert.deepEqual(await f.adminSessions.get(key),value);
    assert.equal((await f.transition.inspect()).unresolved,0);
  }finally{await f.close();}
});

function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function waitingRead() { const entered = deferred(), release = deferred(); return { entered, release, run: async () => { entered.resolve(); await release.promise; return { syntheticPrivate: 'protected-read-result' }; } }; }
for (const backend of ['legacy', 'rtdb']) test(`${backend} 긴 읽기2개와 페이지 이동·activity는 외부 조회 동안 서로 잠그지 않는다`, { timeout: 60000 }, async () => {
  const errors = waitingRead(), traffic = waitingRead();
  const f = await httpHarness('adminPages', { getErrorSummary: errors.run, getTrafficSummary: traffic.run });
  let first, second;
  try {
    if (backend === 'rtdb') await flip(f);
    await f.call('/admin/session', 'POST', {}, { Authorization: 'Bearer synthetic-token' });
    first = f.call('/admin/api/errors'); await errors.entered.promise;
    second = f.call('/admin/api/traffic'); await traffic.entered.promise;
    assert.equal((await f.transition.inspect()).externalUnresolved, 0,'조회 중에는 세션 잠금이 없다');
    assert.match((await f.call('/admin/cards')).text, /id="admin-content"/);
    f.advance(1000);assert.equal((await f.call('/admin/session/activity','POST',{uid:f.uid})).status,204);
    errors.release.resolve();traffic.release.resolve();
    assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
    assert.equal((await f.transition.inspect()).externalUnresolved,0);
  } finally { errors.release.resolve();traffic.release.resolve();await Promise.allSettled([first,second].filter(Boolean));await f.close(); }
});
for (const backend of ['legacy','rtdb']) for (const change of ['logout','role','disabled','revoked','idle','replacement']) test(`${backend} 읽기 중 ${change} 변경 뒤에는 결과를 응답하지 않는다`, { timeout: 60000 },async()=>{
  const read=waitingRead(),f=await httpHarness('adminPages',{getErrorSummary:read.run});let pending;
  try {
    if(backend==='rtdb')await flip(f);
    await f.call('/admin/session','POST',{}, {Authorization:'Bearer synthetic-token'});
    const cookie=f.cookie().slice('__session='.length);
    pending=f.call('/admin/api/errors');await read.entered.promise;
    if(change==='logout')assert.equal((await f.call('/admin/session/logout','POST')).status,204);
    if(change==='role')f.setRole('none');
    if(change==='disabled')f.disable();
    if(change==='revoked')f.revoke();
    if(change==='idle')f.advance(IDLE_MS);
    if(change==='replacement') { await f.adminSessions.remove(hash(cookie));await f.adminSessions.set(hash(cookie),fixture(f.uid)); }
    read.release.resolve();const response=await pending;
    assert.equal(response.status,401);assert.doesNotMatch(response.text,/protected-read-result/);
    assert.equal((await f.transition.inspect()).externalUnresolved,0);
  } finally {read.release.resolve();if(pending)await Promise.allSettled([pending]);await f.close();}
});
for(const surface of ['adminPages','adminBackend']) test(`${surface} 조회 중 전환은 잠금 때문에 막히지 않고 이전 epoch의 결과는 차단한다`,{timeout:60000},async()=>{
  const read=waitingRead(),f=await httpHarness(surface,{getErrorSummary:read.run});let pending;
  try {
    await f.call('/admin/session','POST',{}, {Authorization:'Bearer synthetic-token'});
    pending=f.call('/admin/api/errors');await read.entered.promise;
    await flip(f);read.release.resolve();const response=await pending;
    assert.equal(response.status,503);assert.doesNotMatch(response.text,/protected-read-result/);
    assert.match((await f.call('/admin')).text,/id="admin-content"/);
    assert.equal((await f.transition.inspect()).externalUnresolved,0);
  } finally {read.release.resolve();if(pending)await Promise.allSettled([pending]);await f.close();}
});
test('조회 중 drain이 시작되면 새 잠금으로 응답을 승인하지 않는다',{timeout:60000},async()=>{
  const read=waitingRead(),f=await httpHarness('adminPages',{getErrorSummary:read.run});let pending;
  try {
    await f.call('/admin/session','POST',{}, {Authorization:'Bearer synthetic-token'});
    pending=f.call('/admin/api/errors');await read.entered.promise;
    const writer=await f.transition.route();await f.transition.copy(writer);await f.transition.drain(writer);
    read.release.resolve();const response=await pending;
    assert.equal(response.status,503);assert.doesNotMatch(response.text,/protected-read-result/);
    assert.equal((await f.transition.inspect()).externalUnresolved,0);
  } finally {read.release.resolve();if(pending)await Promise.allSettled([pending]);await f.close();}
});
