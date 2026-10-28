'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const f = await fixture({ realAuthHelpers: true });
  const helpers = f.load('functions/utils/auth.js');
  // JWT 입력과 App Check만 합성하고 현재 계정·프로필·claims·DB는 demo SDK로 검사한다.
  f.mock('functions/utils/auth.js', { ...helpers, verifyAppCheck: async () => true });
  await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  const writer = await f.binding.transition.route();
  await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
  const routes = f.load('functions/routes/registration.js');
  const request = () => call(routes.getRegistrationStatus, { method: 'GET', query: { includeUserData: 'true' } });
  const initial = await request(); assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.initialData.membershipClaims.status, 'synced');
  return { ...f, request, initial };
}

test('demo Auth/RTDB의 병렬 가입 조회는 두 검사를 기다리고 기존 전체 응답·journal을 보존한다', { timeout: 30000 }, async () => {
  const f = await setup(), account = gate(), profile = gate(), accountEntered = gate(), profileEntered = gate();
  const auth = f.binding.auth, get = auth.getUser, repo = f.binding.repository, read = repo.readRegistrationProfile;
  const data = f.load('functions/services/loginUserData.js'), full = data.readLoginUserData;
  let bodyReads = 0, first = true, pending;
  try {
    const before = await f.binding.transition.inspect();
    auth.getUser = async uid => {
      if (uid === f.uid && first) { first = false; accountEntered.resolve(); await account.promise; }
      return get(uid);
    };
    repo.readRegistrationProfile = async uid => { profileEntered.resolve(); await profile.promise; return read(uid); };
    data.readLoginUserData = (...args) => { bodyReads++; return full(...args); };
    pending = f.request();
    await Promise.all([accountEntered.promise, profileEntered.promise]);
    assert.equal(bodyReads, 0);
    profile.resolve(); await repo.readRegistrationProfile(f.uid); assert.equal(bodyReads, 0);
    account.resolve(); const response = await pending;
    assert.equal(response.statusCode, 200); assert.equal(bodyReads, 1);
    for (const key of ['allCards', 'settings', 'sourceMembership', 'membershipClaims', 'amount', 'nickname', 'createdAt']) {
      assert.deepEqual(response.body.initialData[key], f.initial.body.initialData[key], key);
    }
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally {
    account.resolve(); profile.resolve(); await pending?.catch(() => {});
    auth.getUser = get; repo.readRegistrationProfile = read; data.readLoginUserData = full;
    await f.close();
  }
});

for (const kind of ['disabled', 'revoked']) test(`demo Auth의 ${kind} 계정은 병렬 프로필 완료 뒤에도 로그인·본문·권한 쓰기를 거부한다`, { timeout: 30000 }, async () => {
  const f = await setup(), account = gate(), entered = gate();
  const auth = f.binding.auth, get = auth.getUser, repo = f.binding.repository, read = repo.readRegistrationProfile;
  const data = f.load('functions/services/loginUserData.js'), full = data.readLoginUserData;
  let bodyReads = 0, pending;
  try {
    const before = await f.binding.transition.inspect();
    auth.getUser = async uid => { await account.promise; return get(uid); };
    repo.readRegistrationProfile = async uid => { const result = await read(uid); entered.resolve(); return result; };
    data.readLoginUserData = (...args) => { bodyReads++; return full(...args); };
    if (kind === 'revoked') auth.verifyIdToken = async () => ({ uid: f.uid, auth_time: 1 });
    pending = f.request(); await entered.promise;
    if (kind === 'disabled') await f.connection.auth.updateUser(f.uid, { disabled: true });
    else await f.connection.auth.revokeRefreshTokens(f.uid);
    account.resolve(); const response = await pending;
    assert.equal(response.statusCode, 401); assert.equal(response.body.success, false); assert.equal(bodyReads, 0);
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally {
    account.resolve(); await pending?.catch(() => {});
    auth.getUser = get; repo.readRegistrationProfile = read; data.readLoginUserData = full;
    await f.close();
  }
});
