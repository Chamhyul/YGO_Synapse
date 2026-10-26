'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { currentAdminUser } = require('../services/adminSessionIdentity');

// 설치된 실제 Admin SDK와 동일한 철회/disabled 경계를 비교한다.
// JWT 검증기와 계정 전송만 합성 주입하므로 인증 서버·자격증명은 사용하지 않는다.
for (const method of ['verifySessionCookie', 'verifyIdToken']) test(`${method}: SDK 철회 경계를 유지하고 현재 계정 조회를 한 번으로 합친다`, async () => {
  const app = initializeApp({ projectId: 'demo-admin-identity' }, `identity-${method}`);
  const auth = getAuth(app), decoded = { uid: 'synthetic-owner', sub: 'synthetic-owner', auth_time: 100 };
  let record, lookups = 0, invalid = false;
  const verify = async () => { if (invalid) throw Object.assign(Error(), { code: 'auth/invalid-argument' }); return decoded; };
  auth.sessionCookieVerifier.verifyJWT = verify; auth.idTokenVerifier.verifyJWT = verify;
  auth.getUser = async uid => { assert.equal(uid, decoded.uid); lookups++; if (record instanceof Error) throw record; return record; };
  const code = method === 'verifyIdToken' ? 'auth/id-token-revoked' : 'auth/session-cookie-revoked';
  const outcome = async work => { try { await work(); return 'ok'; } catch (error) { return error.code; } };
  try {
    for (const value of [
      { disabled: false, customClaims: { role: 'owner' } },
      { disabled: true },
      { tokensValidAfterTime: new Date(99000).toISOString() },
      { tokensValidAfterTime: new Date(100000).toISOString() },
      { tokensValidAfterTime: new Date(101000).toISOString() },
      Object.assign(Error(), { code: 'auth/user-not-found' }),
      Object.assign(Error(), { code: 'auth/internal-error' }),
    ]) {
      record = value;
      const original = await outcome(() => auth[method]('synthetic-signed-token', true));
      lookups = 0;
      const current = await outcome(async () => currentAdminUser(auth, await auth[method]('synthetic-signed-token', false), code));
      assert.equal(current, original); assert.equal(lookups, 1);
    }
    record = { customClaims: { role: 'admin' } };lookups = 0;
    await auth[method]('synthetic-signed-token', true);await auth.getUser(decoded.uid);
    assert.equal(lookups, 2, '기존 철회 검사와 별도 역할 조회는 두 번 요청한다');
    lookups = 0;
    await currentAdminUser(auth, await auth[method]('synthetic-signed-token', false), code);
    assert.equal(lookups, 1, '동일 인증 시점의 중복 계정 조회만 없앤다');
    const token = await auth[method]('synthetic-signed-token', false);
    assert.equal((await currentAdminUser(auth, token, code)).customClaims.role, 'admin');
    record = { customClaims: { role: 'none' } };
    assert.equal((await currentAdminUser(auth, token, code)).customClaims.role, 'none','이전 요청의 역할을 재사용하지 않는다');
    invalid = true; lookups = 0;
    await assert.rejects(auth[method]('synthetic-bad-token', false), { code: 'auth/invalid-argument' });
    assert.equal(lookups, 0);
  } finally { await deleteApp(app); }
});
test('철회 기준 또는 인증 시각이 불명확하면 허용하지 않는다', async () => {
  for (const [authTime, validAfter] of [[undefined,new Date(100000).toISOString()],[100,'invalid-date'],['100',new Date(100000).toISOString()]]) {
    const auth = { getUser: async () => ({ tokensValidAfterTime: validAfter }) };
    await assert.rejects(currentAdminUser(auth, { uid:'synthetic',auth_time:authTime }, 'auth/session-cookie-revoked'), { code:'auth/session-cookie-revoked' });
  }
});
