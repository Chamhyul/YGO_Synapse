'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
async function setup() {
  const f = await fixture({ realAuthHelpers: true });
  await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  const route = await f.binding.transition.route();
  await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
  f.user = f.load('functions/routes/user.js');
  const initial = await call(f.user.getUserData); assert.equal(initial.statusCode, 200);
  f.auth = f.binding.auth; f.reads = 0; const get = f.auth.getUser;
  f.auth.getUser = (...args) => { f.reads++; return get(...args); };
  f.check = () => call(f.user.getUserData, { body: { membershipClaimsOnly: true, uid: f.owner,
    accountWindow: { uid: f.owner, customClaims: { role: 'owner' } } } });
  return f;
}
test('실제 HTTP·인증 헬퍼·RTDB/Auth 완료 대조는 한 최신 계정을 공유하며 조회만 수행한다', async () => {
  const f = await setup();
  try {
    const before = await f.binding.transition.inspect();
    const response = await f.check();
    assert.equal(response.statusCode, 200); assert.equal(response.body.membershipClaims.status, 'synced');
    assert.deepEqual(Object.keys(response.body).sort(), ['membershipClaims', 'success']);
    assert.equal(f.reads, 1); assert.deepEqual(await f.binding.transition.inspect(), before);
    await f.check(); assert.equal(f.reads, 2); // 다음 요청의 Auth 결과를 재사용하지 않는다.
  } finally { await f.close(); }
});
test('running/uncertain에는 인증 후 pending만 반환하고 잠금·복구 장벽을 해제하지 않는다', async () => {
  const f = await setup();
  try {
    const store = f.binding.claimsStorage.customClaims, id = await store.acquire(f.uid);
    let before = await f.binding.transition.inspect();
    const response = await f.check(); assert.equal(response.statusCode, 200);
    assert.equal(response.body.membershipClaims.status, 'pending'); assert.equal(f.reads, 1);
    assert.deepEqual(await f.binding.transition.inspect(), before);
    await store.finish(f.uid, id, true); before = await f.binding.transition.inspect();
    assert.equal((await f.check()).body.membershipClaims.status, 'pending'); assert.equal(f.reads, 2);
    assert.equal((await store.inspect(f.uid)).state, 'uncertain');
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { await f.close(); }
});
test('현재 Auth의 disabled·철회는 claims 일치 여부와 무관하게401이고 조회 장애는503이다', async () => {
  for (const mode of ['disabled', 'revoked', 'failure']) {
    const f = await setup();
    try {
      if (mode === 'disabled') await f.connection.auth.updateUser(f.uid, { disabled: true });
      if (mode === 'revoked') {
        await f.connection.auth.revokeRefreshTokens(f.uid);
        f.auth.verifyIdToken = async () => ({ uid: f.uid, auth_time: 1 });
      }
      if (mode === 'failure') f.auth.getUser = async () => { f.reads++; throw Error('synthetic'); };
      const response = await f.check(); assert.equal(response.statusCode, mode === 'failure' ? 503 : 401);
      assert.equal(response.body.success, false); assert.equal(f.reads, 1);
    } finally { await f.close(); }
  }
});
