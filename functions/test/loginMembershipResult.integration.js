'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, response, call } = require('./commonWriterFixture.cjs');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function reached(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic-stage-not-reached')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function setup() {
  const f = await fixture({ realAuthHelpers: true });
  try {
    const helpers = f.load('functions/utils/auth.js');
    f.mock('functions/utils/auth.js', { ...helpers, verifyAppCheck: async () => true });
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    const registration = f.load('functions/routes/registration.js'), user = f.load('functions/routes/user.js');
    const claims = f.load('functions/services/membershipClaims.js');
    assert.equal((await claims.syncMembershipClaims(f.uid)).status, 'synced');
    return { ...f, registration, user, claims };
  } catch (error) { await f.close(); throw error; }
}
function stream(f, endpoint = 'registration', token = 'member', enabled = true) {
  const first = gate(), res = response(), frames = [];
  res.write = value => { frames.push(JSON.parse(value)); first.resolve(); return true; };
  res.end = value => { if (value) frames.push(JSON.parse(value)); res.writableEnded = true; return res; };
  res.setHeader = (key, value) => res.headers[key] = value; res.getHeader = key => res.headers[key];
  const req = { method: endpoint === 'registration' ? 'GET' : 'POST',
    query: endpoint === 'registration' ? { includeUserData: 'true', ...(enabled ? { loginMembershipResult: 'true' } : {}) } : {},
    body: endpoint === 'user' && enabled ? { loginMembershipResult: true, inventoryConditional: true } : {},
    headers: { authorization: `Bearer ${token}` }, get() {}, ip: '127.0.0.1' };
  const handler = endpoint === 'registration' ? f.registration.getRegistrationStatus : f.user.getUserData;
  const work = handler(req, res);
  return { work, res, first, frames };
}

for (const endpoint of ['registration', 'user']) test(`${endpoint}: 정상 demo 조회는 Auth1회·무쓰기로 전체 응답을 보존한다`, { timeout: 30000 }, async () => {
  const f = await setup(), auth = f.binding.auth, get = auth.getUser; let reads = 0;
  try {
    const before = await f.binding.transition.inspect();
    auth.getUser = (...args) => { reads++; return get(...args); };
    const request = stream(f, endpoint); await request.work;
    const data = request.res.body.initialData || request.res.body;
    assert.equal(data.membershipClaims.status, 'synced'); assert(Array.isArray(data.allCards));
    assert.equal(data.settings.membership.status, 'none'); assert.equal(reads, 1); assert.equal(request.frames.length, 0);
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { auth.getUser = get; await f.close(); }
});

for (const endpoint of ['registration', 'user']) for (const membership of ['active', 'none']) test(`${endpoint}/${membership}: 권한 갱신 ACK를 보류해도 회원 판정·보유 정보 첫 결과를 먼저 전송한다`, { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), release = gate(), auth = f.binding.auth, set = auth.setCustomUserClaims;
  let request, ended = false;
  try {
    if (membership === 'active') await f.binding.repository.updateSettings(f.uid, { membership: {
      status: 'active', type: 'csv', levelName: '합성 회원', userChannelId: 'UC' + 'x'.repeat(22),
      verificationVersion: 2, verificationProvider: 'youtube', lastChecked: 1,
    } });
    // 승격과 회수 모두 현재 원본을 표시하며, 과거 Auth 요약을 화면 판정에 쓰지 않는다.
    await f.connection.auth.setCustomUserClaims(f.uid, { preserved: true, ygoMembership: {
      v: 1, active: membership !== 'active', provider: 'youtube', version: 'synthetic-old',
    } });
    auth.setCustomUserClaims = async (...args) => { entered.resolve(); await release.promise; return set(...args); };
    request = stream(f, endpoint); request.work.then(() => { ended = true; });
    await reached(entered.promise); await reached(request.first.promise);
    const data = request.frames[0].result.initialData || request.frames[0].result;
    assert.equal(data.settings.membership.status, membership); assert(Array.isArray(data.allCards));
    assert.equal(data.membershipClaims.status, 'pending'); assert.equal(ended, false);
    assert.equal(request.res.writableEnded, undefined);
    assert.equal((await f.binding.claimsStorage.customClaims.inspect(f.uid)).state, 'running');
    release.resolve(); await request.work;
    assert.equal(request.frames.length, 2); assert.equal(request.frames[1].type, 'recorded');
    assert.equal(request.frames[1].result.membershipClaims.status, 'synced');
    assert.equal(Object.hasOwn(request.frames[1].result, 'allCards'), false);
    assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.preserved, true);
    assert.equal((await f.binding.claimsStorage.customClaims.inspect(f.uid)).state, 'idle');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { release.resolve(); await request?.work.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});

test('권한 완료 증거가 느려도 계정·가입 확인 직후 기존 전체 본문 조회를 시작한다', { timeout: 30000 }, async () => {
  const f = await setup(), evidence = gate(), body = gate(), entered = gate();
  const store = f.binding.claimsStorage.customClaims, settled = store.isSettled;
  const data = f.load('functions/services/loginUserData.js'), full = data.readLoginUserData;
  let request;
  try {
    store.isSettled = async (...args) => { entered.resolve(); await evidence.promise; return settled(...args); };
    data.readLoginUserData = (...args) => { body.resolve(); return full(...args); };
    request = stream(f); await reached(entered.promise); await reached(body.promise);
    assert.equal(request.res.body, undefined); assert.equal(request.frames.length, 0);
    evidence.resolve(); await request.work;
    assert.equal(request.res.body.initialData.membershipClaims.status, 'synced');
  } finally { evidence.resolve(); await request?.work.catch(() => {}); store.isSettled = settled; data.readLoginUserData = full; await f.close(); }
});

test('legacy JSON 요청은 기존 동기 갱신 완료 응답을 유지한다', { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), release = gate(), auth = f.binding.auth, set = auth.setCustomUserClaims;
  let request;
  try {
    await f.connection.auth.setCustomUserClaims(f.uid, {});
    auth.setCustomUserClaims = async (...args) => { entered.resolve(); await release.promise; return set(...args); };
    request = stream(f, 'registration', 'member', false); await reached(entered.promise);
    assert.equal(request.frames.length, 0); assert.equal(request.res.body, undefined);
    release.resolve(); await request.work;
    assert.equal(request.res.body.initialData.membershipClaims.status, 'synced'); assert.equal(request.frames.length, 0);
  } finally { release.resolve(); await request?.work.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});

for (const mode of ['disabled', 'revoked', 'unregistered', 'bad-token']) test(`${mode}: 성공 프레임·권한 쓰기 없이 기존 인증·가입 거부를 유지한다`, { timeout: 30000 }, async () => {
  const f = await setup(), auth = f.binding.auth, set = auth.setCustomUserClaims; let request, writes = 0;
  try {
    await f.connection.auth.setCustomUserClaims(f.uid, {});
    auth.setCustomUserClaims = async (...args) => { writes++; return set(...args); };
    if (mode === 'disabled') await f.connection.auth.updateUser(f.uid, { disabled: true });
    if (mode === 'revoked') { await f.connection.auth.revokeRefreshTokens(f.uid); auth.verifyIdToken = async () => ({ uid: f.uid, auth_time: 1 }); }
    request = stream(f, 'registration', mode === 'unregistered' ? 'owner' : mode === 'bad-token' ? 'invalid' : 'member');
    await request.work;
    assert.equal(request.frames.length, 0); assert.equal(writes, 0);
    if (mode === 'unregistered') assert.equal(request.res.body.registered, false);
    else assert.equal(request.res.statusCode, 401);
  } finally { await request?.work.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});

test('첫 결과 뒤 연결 종료·Auth ACK 불명확에도 uncertain 장벽과 명시 복구를 보존한다', { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), release = gate(), auth = f.binding.auth, set = auth.setCustomUserClaims;
  let request;
  try {
    await f.connection.auth.setCustomUserClaims(f.uid, { preserved: true });
    auth.setCustomUserClaims = async (...args) => { entered.resolve(); await release.promise; await set(...args); throw Error('synthetic-ack-lost'); };
    request = stream(f); await reached(entered.promise); await reached(request.first.promise);
    request.res.destroyed = true; request.res.end = () => { throw Error('synthetic-disconnect'); };
    release.resolve(); await request.work;
    const lock = await f.binding.claimsStorage.customClaims.inspect(f.uid);
    assert.equal(lock.state, 'uncertain'); assert((await f.binding.transition.inspect()).unresolved > 0);
    auth.setCustomUserClaims = set;
    await f.binding.transition.drain(await f.binding.transition.route());
    assert.equal((await f.claims.recoverMembershipClaims(f.uid, lock.operationId, { writersDrained: true })).status, 'synced');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.preserved, true);
  } finally { release.resolve(); await request?.work.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});

test('후속 권한 저장의 확정 거부는 첫 회원 판정을 유지하고 실패 종료로 알리며 재제출하지 않는다', { timeout: 30000 }, async () => {
  const f = await setup(), auth = f.binding.auth, set = auth.setCustomUserClaims;
  let request, writes = 0;
  try {
    await f.connection.auth.setCustomUserClaims(f.uid, {});
    auth.setCustomUserClaims = async () => { writes++; throw Object.assign(Error('synthetic'), { code: 'auth/insufficient-permission' }); };
    request = stream(f); await request.work;
    assert.equal(request.frames[0].result.initialData.settings.membership.status, 'none');
    assert.equal(request.frames[1].type, 'recorded'); assert.equal(request.frames[1].success, false);
    assert.equal(writes, 1); assert.equal((await f.binding.claimsStorage.customClaims.inspect(f.uid)).state, 'idle');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await request?.work.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});

test('native 읽기 창의 최초 route·잠금 병렬성과 원본/잠금/전환 최종 재검사를 유지한다', { timeout: 30000 }, async () => {
  const f = await setup(), routeEntered = gate(), lockEntered = gate(), release = gate();
  const transition = f.binding.transition, route = transition.route, store = f.binding.claimsStorage.customClaims, observe = store.observe;
  let check;
  try {
    let firstRoute = true, firstLock = true;
    transition.route = async () => { if (firstRoute) { firstRoute = false; routeEntered.resolve(); await release.promise; } return route(); };
    store.observe = async uid => { if (firstLock) { firstLock = false; lockEntered.resolve(); await release.promise; } return observe(uid); };
    check = f.claims.beginLoginMembershipCheck(f.uid, { readAccount: () => f.binding.auth.getUser(f.uid) });
    await reached(Promise.all([routeEntered.promise, lockEntered.promise]));
    release.resolve(); assert.equal((await check.account).uid, f.uid);
    assert.equal((await check.checked).claims.status, 'synced');
  } finally { release.resolve(); await check?.checked; transition.route = route; store.observe = observe; await f.close(); }
});
