'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
async function setup() {
  const f = await fixture(); await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'test', privacy: 'test' });
  const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
  await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
  const routes = f.load('functions/routes/registration.js');
  const request = query => call(routes.getRegistrationStatus, { method: 'GET', query });
  assert.equal((await request({ includeUserData: 'true' })).body.initialData.membershipClaims.status, 'synced');
  return { ...f, request };
}
test('실제 SDK 통합 로그인은 프로필 snapshot 연결로 body 1회·route 2회를 줄이고 응답을 보존한다', async () => {
  const f = await setup(), repo = f.binding.repository, method = repo.readRegistrationProfile;
  const route = f.binding.transition.route, read = f.binding.stores.rtdb.read;
  let routes = 0, profiles = 0;
  f.binding.transition.route = async () => { routes++; return route(); };
  f.binding.stores.rtdb.read = key => { if (key.startsWith('fs/users/')) profiles++; return read(key); };
  try {
    delete repo.readRegistrationProfile;
    const before = await f.request({ includeUserData: 'true' }), old = { routes, profiles };
    routes = profiles = 0; repo.readRegistrationProfile = method;
    const after = await f.request({ includeUserData: 'true', initialProfile: 'untrusted-input' });
    assert.equal(before.statusCode, 200); assert.equal(after.statusCode, 200);
    assert.equal(old.profiles - profiles, 1); assert.equal(old.routes - routes, 2);
    for (const key of ['registered', 'consentVersions']) assert.deepEqual(after.body[key], before.body[key]);
    for (const key of ['allCards', 'settings', 'sourceMembership', 'membershipClaims', 'amount', 'nickname', 'createdAt']) {
      assert.deepEqual(after.body.initialData[key], before.body.initialData[key], key);
    }
    assert.equal(Object.hasOwn(after.body, 'profile'), false);
    console.log(JSON.stringify({ event: 'synthetic_registration_profile_reuse', before: old, after: { routes, profiles }, actualOAuth: false }));
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.binding.transition.inspect()).externalUnresolved, 0);
  } finally { repo.readRegistrationProfile = method; f.binding.transition.route = route; f.binding.stores.rtdb.read = read; await f.close(); }
});
test('기존 가입 API·미가입 무조회·이후 변경의 새 조회를 보존한다', async () => {
  const f = await setup();
  try {
    const plain = await f.request({}); assert.equal(plain.body.registered, true); assert(!Object.hasOwn(plain.body, 'initialData'));
    const routes = f.load('functions/routes/registration.js');
    const fresh = await call(routes.getRegistrationStatus, { method: 'GET', token: 'owner', query: { includeUserData: 'true' } });
    assert.equal(fresh.body.registered, false); assert(!Object.hasOwn(fresh.body, 'initialData'));
    await f.binding.repository.updateNickname(f.uid, 'synthetic-new');
    assert.equal((await f.request({ includeUserData: 'true' })).body.initialData.nickname, 'synthetic-new');
  } finally { await f.close(); }
});
