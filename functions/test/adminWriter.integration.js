'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createWriterAdminOperations } = require('../services/adminWriterOperations');
const { createAdminOperationRequestHandler } = require('../services/adminActionTransport');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createNoticeWriterService } = require('../services/noticeWriterService');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
const environment = f => ({ ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId });
async function setup(options = {}, runId = id()) {
  const connection = open(runId), binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config, migration, ...options });
  await binding.initialize(); return { ...binding, runId, connection, close: () => connection.close() };
}
async function flip(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
const notice = revision => ({ action: 'add', title: '합성 공지', content: '<p>검증</p><script>unsafe()</script>', revision });
async function state(f) { return (await createWriterJournalStore({ database: f.connection.targetDatabase, path: 'profileWriterTransitions' }).read(f.runId)).value; }
async function serve(handler) {
  const app = express(); app.use(express.json()); app.use(handler); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  return { base, async call(body, headers = {}, route = '/', method = 'POST') {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch (_) {}
    return { status: res.status, headers: res.headers, data, text };
  }, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
const forbidden = () => assert.fail('운영 proxy/카드 handler 호출 금지');
for (const backend of ['legacy', 'rtdb']) test(`${backend} 공지 Storage CRUD·generation·정렬·정화와 양방향 전환을 유지한다`, async () => {
  const f = await setup(); try {
    if (backend === 'rtdb') await flip(f);
    assert.equal((await f.notices.list()).revision, '0');
    const added = await f.notices.mutate(notice('0')); assert.equal(added.revision, null); assert.doesNotMatch(added.notice.content, /script|unsafe/);
    const current = await f.notices.list(); assert.match(current.revision, /^\d+$/); assert.equal(current.notices.length, 1);
    await flip(f); assert.deepEqual(await f.notices.list(), current);
    const changed = await f.notices.mutate({ action: 'update', id: added.notice.id, title: '수정', isPinned: 2, revision: current.revision });
    assert.equal(changed.notice.title, '수정'); assert.equal(changed.notice.isPinned, 2);
    const [meta] = await f.connection.bucket.file('public/notices.json').getMetadata();
    assert.equal(meta.contentType, 'application/json'); assert.equal(meta.cacheControl, 'public, max-age=0, must-revalidate');
    await f.notices.mutate({ action: 'delete', id: added.notice.id, revision: (await f.notices.list()).revision });
    assert.equal((await f.notices.list()).notices.length, 0); assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.equal((await f.stores.legacy.snapshot()).some(entry => entry.key.startsWith('notice/')), false);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 두 SDK의 같은 공지 revision 수정은 한 번만 성공한다`, async () => {
  const f = await setup(), other = await setup({}, f.runId); try {
    if (backend === 'rtdb') await flip(f);
    const results = await Promise.allSettled([f.notices.mutate(notice('0')), other.notices.mutate(notice('0'))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal((await f.notices.list()).notices.length, 1); assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await other.close(); await f.close(); }
});
test('기존 PID 공지 잠금은 자동삭제 없이 쓰기와 전체 복사를 차단하고 목록 조회는 유지한다', async () => {
  const f = await setup(); try {
    const ref = f.connection.db.collection('AdminNoticeLocks').doc('publication'), original = { pid: 12345, token: 'synthetic-lock', expiresAt: 0 };
    await ref.set(original); assert.equal((await f.notices.list()).notices.length, 0);
    await assert.rejects(f.notices.mutate(notice('0')), { code: 'NOTICE_LEGACY_LOCK_MIGRATION_REQUIRED' });
    await assert.rejects(f.transition.copy(await f.transition.route()), { code: 'NOTICE_LEGACY_LOCK_MIGRATION_REQUIRED' });
    assert.deepEqual((await ref.get()).data(), original); assert.equal((await f.connection.bucket.file('public/notices.json').exists())[0], false);
  } finally { await f.close(); }
});
test('공지 시간초과는 늦은 RPC를 재전송하지 않고 복구 재실패도 같은 ID로 이어간다', async () => {
  const f = await setup(); let release, written, writes = 0, readFails = false;
  const gate = new Promise(resolve => { release = resolve; }), completed = new Promise(resolve => { written = resolve; });
  const value = { notices: [] }, storage = { read: async () => { if (readFails) throw Error('synthetic read failure'); return { data: structuredClone(value), revision: String(writes) }; },
    write: async data => { writes++; await gate; Object.assign(value, data); written(); return null; } };
  const service = createNoticeWriterService({ requests: f.adminRequests, transition: f.transition, storage, timeoutMs: 25 });
  try {
    await assert.rejects(service.mutate(notice('0')), { code: 'NOTICE_STORAGE_TIMEOUT' });
    const old = Object.values((await state(f)).external).find(op => op.status === 'uncertain'); assert.ok(old);
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' }); release(); await completed;
    readFails = true; await assert.rejects(service.recoverPublication(old.id, { writersDrained: true }));
    const first = (await state(f)).external[old.id].recoveryId; assert.equal((await state(f)).external[first].status, 'uncertain');
    readFails = false; assert.equal((await service.recoverPublication(old.id, { writersDrained: true })).count, 1);
    assert.equal((await state(f)).external[old.id].recoveryId, first); assert.equal(writes, 1); await f.transition.activate(writer);
  } finally { release?.(); await f.close(); }
});
test('Storage 늦은 저장·응답 유실은 전환을 막고 실제 종료 확인 뒤 현재 파일만 대조한다', async () => {
  let enter, release, submitted = 0; const ready = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const value = { notices: [] }; const storage = { read: async () => ({ data: structuredClone(value), revision: String(submitted) }),
    write: async data => { submitted++; enter(); await gate; Object.assign(value, data); throw Error('synthetic lost ack'); } };
  const f = await setup({ noticeStorage: storage }); try {
    const pending = f.notices.mutate(notice('0')); await ready;
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    release(); await assert.rejects(pending);
    const lock = Object.values((await state(f)).external).find(op => op.status === 'uncertain'); assert.deepEqual(lock.resources, ['notice/publication']);
    await assert.rejects(f.notices.recoverPublication(lock.id), { code: 'WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED' });
    const recovered = await f.notices.recoverPublication(lock.id, { writersDrained: true });
    assert.deepEqual(recovered, { revision: '1', count: 1, outcome: 'current-state-only' }); assert.equal(submitted, 1);
    await f.transition.activate(writer); assert.equal((await f.transition.inspect()).unresolved, 0);
    await assert.rejects(f.notices.recoverPublication(lock.id, { writersDrained: true }));
  } finally { release?.(); await f.close(); }
});
test('Storage 확정412와 손상 파일은 덮어쓰기 없이 종료하며 resource 키는 업무 자료가 아니다', async () => {
  let saves = 0; const f = await setup({ noticeStorage: { read: async () => ({ data: { notices: [] }, revision: '0' }),
    write: async () => { saves++; throw Object.assign(Error('synthetic CAS'), { code: 412 }); } } });
  try {
    await assert.rejects(f.notices.mutate(notice('0')), { status: 409 }); assert.equal(saves, 1); assert.equal((await f.transition.inspect()).unresolved, 0);
    await assert.rejects(f.transition.prepare(await f.transition.route(), id(), [{ key: 'notice/publication', exists: true, token: '0', value: {} }]), { code: 'INVENTORY_WRITER_INVALID_COMMAND' });
    const other = await setup({}, f.runId); try {
      const raw = '{"notices":"invalid"}'; await other.connection.bucket.file('public/notices.json').save(raw);
      await assert.rejects(other.notices.mutate(notice('0')), { status: 503 });
      assert.equal((await other.connection.bucket.file('public/notices.json').download())[0].toString(), raw);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
async function consoleHarness(f, options = {}) {
  const uid = 'synthetic-owner-' + id(), target = 'synthetic-target-' + id(), auth = f.connection.auth;
  await auth.createUser({ uid }); await auth.createUser({ uid: target });
  await auth.setCustomUserClaims(uid, { role: 'owner', admin: true }); await auth.setCustomUserClaims(target, { other: 'preserve' });
  const injected = { getUser: auth.getUser.bind(auth), listUsers: auth.listUsers.bind(auth), setCustomUserClaims: auth.setCustomUserClaims.bind(auth),
    verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); if (token !== 'synthetic-token') throw Object.assign(Error('rejected'), { code: 'auth/id-token-revoked' }); return { uid, role: 'owner' }; }, ...options.auth };
  const env = environment(f), operations = createWriterAdminOperations({ ...options, writerBinding: f, auth: injected, env });
  const http = await serve(createAdminOperationRequestHandler(forbidden, { env, writerOperations: operations }));
  return { ...http, uid, target, auth, operations, env, async operation(operation, body = {}, token = 'synthetic-token', method = 'POST') {
    return http.call({ operation, method, body, query: {}, uid: target, role: 'owner' }, { Authorization: 'Bearer ' + token });
  } };
}
for (const backend of ['legacy', 'rtdb']) test(`${backend} 네 관리자 console HTTP는 같은 writer에 연결하고 현재 Auth/CSV/공지 계약을 유지한다`, async () => {
  const f = await setup(), h = await consoleHarness(f); try {
    if (backend === 'rtdb') await flip(f);
    const access = await h.operation('checkAdminAccess'); assert.deepEqual(access.data, { success: true, role: 'owner' }); assert.equal(access.headers.get('x-ygo-admin-action'), '1');
    const changed = await h.operation('manageAdminRole', { action: 'setAdmin', targetUid: h.target, isAdmin: true });
    assert.equal(changed.status, 200); assert.equal(changed.data.role, 'admin'); assert.equal(changed.data.targetUid, h.target);
    const claims = (await h.auth.getUser(h.target)).customClaims; assert.equal(claims.other, 'preserve'); assert.equal(claims.ygoMembership.v, 1);
    assert.equal(claims.role, 'admin'); assert.equal(claims.admin, true);
    const list = await h.operation('manageAdminRole', { action: 'list' }); assert.equal(list.data.adminList.some(user => user.uid === h.target && user.isAdmin), true);
    const added = await h.operation('manageNotice', notice()); assert.equal(added.status, 200); assert.equal(added.data.notice.title, '합성 공지');
    const members = [{ channelId: 'UC' + '1'.repeat(22), memberName: '합성 회원', levelName: 'A' }];
    const csv = await h.operation('uploadMembershipCsv', { members }); assert.equal(csv.status, 200); assert.equal(csv.data.count, 1);
    await flip(f); assert.deepEqual((await f.membershipCsv.read()).members, members);
    assert.equal((await h.operation('manageAdminRole', { action: 'setAdmin', targetUid: h.target, isAdmin: false })).status, 200);
    const after = (await h.auth.getUser(h.target)).customClaims; assert.equal(after.role, 'none'); assert.equal(after.other, 'preserve');
    assert.equal((await h.operation('checkAdminAccess', {}, 'invalid')).status, 401);
    await h.auth.setCustomUserClaims(h.uid, { role: 'admin', admin: true });
    assert.equal((await h.operation('checkAdminAccess', { scope: 'settings' })).status, 403);
    assert.equal((await h.operation('manageAdminRole', { action: 'setOwner', targetUid: h.target })).status, 403);
    await h.auth.setCustomUserClaims(h.uid, { role: 'none', admin: false });
    assert.equal((await h.operation('manageNotice', notice())).status, 403);
    await h.auth.updateUser(h.uid, { disabled: true }); assert.equal((await h.operation('checkAdminAccess')).status, 401);
    assert.equal((await h.operation('triggerAutoCrawl')).status, 503); assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await h.close(); await f.close(); }
});
test('관리자 목록 pagination과 Auth 시간초과의 기존 오류 계약을 유지한다', async () => {
  const f = await setup(), pages = [], h = await consoleHarness(f, { auth: { listUsers: async (limit, pageToken) => {
    pages.push([limit, pageToken]); return pageToken ? { users: [{ uid: 'b', customClaims: { admin: true } }] }
      : { users: [{ uid: 'a', email: 'synthetic@example.invalid', customClaims: { role: 'owner' } }, { uid: 'non-admin' }], pageToken: 'next' };
  } } });
  try {
    const result = await h.operation('manageAdminRole', { action: 'list' }); assert.equal(result.data.count, 2);
    assert.deepEqual(pages, [[1000, undefined], [1000, 'next']]);
    assert.deepEqual(result.data.adminList[1], { uid: 'b', email: '', displayName: '', role: 'admin', isAdmin: true });
    const auth = { verifyIdToken: () => new Promise(() => {}), getUser: forbidden };
    const operations = createWriterAdminOperations({ writerBinding: f, auth, env: environment(f), timeoutMs: 25 });
    const blocked = await serve(operations.manageNotice); try {
      const timed = await blocked.call(notice(), { Authorization: 'Bearer synthetic-token' });
      assert.equal(timed.status, 503); assert.equal(timed.data.code, 'AUTH_VERIFICATION_UNAVAILABLE');
      assert.equal((await f.transition.inspect()).unresolved, 0); assert.equal((await f.notices.list()).notices.length, 0);
    } finally { await blocked.close(); }
  } finally { await h.close(); await f.close(); }
});
test('console 요청 진행 중 drain은 대기하며 종료 승인 유실 시 성공 응답을 전달하지 않는다', async () => {
  const f = await setup(); let entered, release, gated = true;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = await consoleHarness(f, { auth: { verifyIdToken: async () => { if (gated) { gated = false; entered(); await gate; } return { uid: h.uid }; } } });
  try {
    const pending = h.operation('checkAdminAccess'); await ready;
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' }); release(); assert.equal((await pending).status, 200);
    await f.transition.activate(writer);
    const end = f.transition.endExternal; f.transition.endExternal = async () => { throw Error('synthetic end ack loss'); };
    const result = await h.operation('manageNotice', notice()); assert.equal(result.status, 503); assert.equal(result.data.success, false);
    f.transition.endExternal = end; assert.ok((await f.transition.inspect()).externalUnresolved > 0);
    assert.equal((await f.notices.list()).notices.length, 1);
  } finally { release?.(); await h.close(); await f.close(); }
});
test('동일 caller/target의 관리자 권한 변경은 인증 진행과 프로필을 앞지르지 않는다', async () => {
  const f = await setup(), h = await consoleHarness(f); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    const holder = f.adminRequests.withRequest({}, async () => { await f.adminRequests.reserveAccounts([h.target]); entered(); await gate; });
    await ready; let done = false;
    const pending = h.operation('manageAdminRole', { action: 'setAdmin', targetUid: h.target, isAdmin: true }).then(result => { done = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(done, false);
    assert.equal((await h.auth.getUser(h.target)).customClaims.role, undefined); release(); await holder;
    assert.equal((await pending).status, 200);
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { release?.(); await h.close(); await f.close(); }
});
test('writer 미주입/다른 run/환경 변경은 Auth·Storage·운영 전달 전에 거부한다', async () => {
  const f = await setup(), h = await consoleHarness(f); try {
    assert.throws(() => createWriterAdminOperations({ writerBinding: f, auth: { verifyIdToken: forbidden, getUser: forbidden }, env: { ...environment(f), USER_PROFILE_WRITER_RUN_ID: id() } }), { code: 'USER_STORAGE_CONFIG_INVALID' });
    const blocked = await serve(createAdminOperationRequestHandler(forbidden, { env: environment(f) })); try {
      assert.equal((await blocked.call({ operation: 'manageNotice', method: 'POST', query: {}, body: notice() }, { Authorization: 'Bearer synthetic-token' })).status, 503);
    } finally { await blocked.close(); }
    const before = await f.transition.inspect(); h.env.FIREBASE_AUTH_EMULATOR_HOST = 'example.org:9099';
    assert.equal((await h.operation('checkAdminAccess')).status, 503); assert.deepEqual(await f.transition.inspect(), before);
  } finally { await h.close(); await f.close(); }
});
for (const surface of ['adminPages', 'adminBackend']) test(`HTTP ${surface} 공지 API는 세션과 같은 부모 lease/Storage를 사용한다`, async () => {
  const f = await setup(), uid = 'synthetic-page-' + id();
  const handlers = createAdminRouteHandlers({ env: environment(f), writerBinding: f, productionDependencies: forbidden, proxy: forbidden,
    emulatorDependencies: { template: async () => '', notices: { mutate: forbidden, list: forbidden }, auth: {
      verifyIdToken: async () => ({ uid }), getUser: async () => ({ uid, customClaims: { role: 'owner' } }),
      createSessionCookie: async () => 'synthetic-cookie', verifySessionCookie: async () => ({ uid }) } } });
  const h = await serve(handlers[surface]); let cookie;
  async function call(route, method = 'POST', body = {}) {
    const backend = surface === 'adminBackend', origin = backend ? new URL(require('../services/adminTransport').BACKEND_URL).origin : h.base;
    return h.call(body, { Origin: origin, Authorization: 'Bearer synthetic-token', ...(cookie ? { Cookie: cookie } : {}) },
      backend ? '/adminBackend?route=' + encodeURIComponent(route) : route, method);
  }
  try {
    const login = await call('/admin/session'); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    const added = await call('/admin/api/notices', 'POST', notice('0')); assert.equal(added.status, 200); assert.equal(added.data.notice.title, '합성 공지');
    await flip(f); assert.equal((await call('/admin/api/notices', 'GET')).data.notices.length, 1);
    assert.equal((await call('/admin/api/notices', 'POST', notice('0'))).status, 409);
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await h.close(); await f.close(); }
});

for (const backend of ['legacy','rtdb']) test(`${backend} 소유자 설정에서 봇 관리자 지정/해제·CSV 접근과 claims 보존`, async () => {
  const f=await setup();let server;
  try {
    if(backend==='rtdb')await flip(f);
    const users=new Map([['synthetic-owner',{uid:'synthetic-owner',customClaims:{role:'owner'}}],['synthetic-bot',{uid:'synthetic-bot',email:'bot@example.invalid',customClaims:{unrelated:'keep'}}]]);
    const auth={async verifyIdToken(token){if(!users.has(token))throw Object.assign(Error(),{code:'auth/invalid-id-token'});return{uid:token};},async getUser(uid){if(!users.has(uid))throw Object.assign(Error(),{code:'auth/user-not-found'});return structuredClone(users.get(uid));},async getUserByEmail(email){return this.getUser([...users.values()].find(user=>user.email===email)?.uid);},async listUsers(){return{users:[...users.values()]};},async setCustomUserClaims(uid,claims){users.get(uid).customClaims=structuredClone(claims);}};
    const operations=createWriterAdminOperations({writerBinding:f,auth,env:environment(f)});
    server=await serve(createAdminOperationRequestHandler(forbidden,{env:environment(f),writerOperations:operations}));
    const call=(operation,body,uid='synthetic-owner')=>server.call({operation,method:'POST',query:{},body},{Authorization:'Bearer '+uid});
    assert.equal((await call('manageAdminRole',{action:'settingsList'},'synthetic-bot')).status,403);
    assert.equal((await call('manageAdminRole',{action:'settingsLookup',kind:'email',value:'bot@example.invalid'})).data.account.role,'none');
    const grant=await call('manageAdminRole',{action:'settingsSetAdmin',targetUid:'synthetic-bot',isAdmin:true,expectedRole:'none'});assert.equal(grant.status,200);assert.equal(grant.data.account.role,'admin');
    assert.equal(users.get('synthetic-bot').customClaims.unrelated,'keep');
    assert.equal((await call('uploadMembershipCsv',{},'synthetic-bot')).status,400); // 인증을 통과하고 CSV 입력 검사에서 거부
    assert.equal((await call('manageAdminRole',{action:'settingsList'},'synthetic-bot')).status,403);
    assert.equal((await call('manageAdminRole',{action:'settingsSetAdmin',targetUid:'synthetic-owner',isAdmin:false,expectedRole:'admin'})).status,403);
    assert.equal((await call('manageAdminRole',{action:'settingsSetAdmin',targetUid:'synthetic-bot',isAdmin:false,expectedRole:'admin'})).data.account.role,'none');
    assert.equal((await call('uploadMembershipCsv',{},'synthetic-bot')).status,403);
    assert.equal((await f.transition.inspect()).unresolved,0);
  } finally {await server?.close();await f.close();}
});
