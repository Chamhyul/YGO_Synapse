'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { requestAccount, validateCurrentAccount } = require('../services/requestAccount');
test('같은 요청·Auth·UID의 병렬 권한 읽기만 공유하고 새 확정 단계/요청/UID/인스턴스는 다시 읽는다', async () => {
  let calls = 0, role = 'owner';
  const auth = { getUser: async uid => { calls++; return { uid, customClaims: { role } }; } }, req = {};
  const values = await Promise.all([requestAccount(req, auth, 'a'), requestAccount(req, auth, 'a')]);
  assert.equal(calls, 1); assert.equal(values[0], values[1]);
  role = 'none';
  assert.equal((await requestAccount(req, auth, 'a', { fresh: true })).customClaims.role, 'none');
  await requestAccount({}, auth, 'a'); await requestAccount(req, auth, 'b');
  await requestAccount(req, { getUser: auth.getUser }, 'a'); assert.equal(calls, 5);
});
test('조회 실패를 같은 단계에서 재제출하지 않으며 다음 확정 단계에서 다시 확인한다', async () => {
  let calls = 0;
  const auth = { getUser: async () => { calls++; throw Object.assign(Error('synthetic'), { code: 'auth/internal-error' }); } }, req = {};
  const values = await Promise.allSettled([requestAccount(req, auth, 'a'), requestAccount(req, auth, 'a')]);
  assert(values.every(v => v.status === 'rejected')); assert.equal(calls, 1);
  await assert.rejects(requestAccount(req, auth, 'a', { fresh: true })); assert.equal(calls, 2);
});
test('비활성·철회 및 불명확한 인증 시각을 허용하지 않는다', () => {
  assert.throws(() => validateCurrentAccount({ disabled: true }, {}), { code: 'auth/user-disabled' });
  for (const auth_time of [undefined, '100', 99]) assert.throws(() => validateCurrentAccount({ tokensValidAfterTime: new Date(100000).toISOString() }, { auth_time }), { code: 'auth/id-token-revoked' });
  assert.doesNotThrow(() => validateCurrentAccount({ tokensValidAfterTime: new Date(100000).toISOString() }, { auth_time: 100 }));
});
