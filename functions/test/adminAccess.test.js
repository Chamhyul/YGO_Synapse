const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture({ claims = {}, disabled = false, tokenError, lookupError } = {}) {
  const calls = [];
  const auth = {
    async verifyIdToken(token, revoked) {
      calls.push(['verify', token, revoked]);
      if (tokenError) throw tokenError;
      return { uid: 'test-user' };
    },
    async getUser(uid) {
      calls.push(['lookup', uid]);
      if (lookupError) throw lookupError;
      return { customClaims: claims, disabled };
    }
  };
  const context = vm.createContext({
    exports: {}, console: { error: (...args) => calls.push(['log', ...args]) },
    require(name) {
      if (name === 'firebase-functions/v2/https') return { onRequest: (_, handler) => handler };
      if (name === '../../config/firebase') return { admin: { auth: () => auth } };
      if (name === '../../services/adminActionTransport') return { forwardAdminRequest: async () => false };
      if (name === '../../utils/auth') return { setCors() {} };
      if (name === '../../utils/safeError') return { safeErrorSummary: () => ({ name: 'Error' }) };
      throw new Error(name);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../routes/admin/access.js'), 'utf8'), context);
  const res = {
    code: 200, headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
  return { handler: context.exports.checkAdminAccess, calls, res };
}

test('세 가지 공지사항 관리자 Claims를 허용하고 자기 권한 결과만 반환한다', async () => {
  for (const claims of [{ admin: true }, { role: 'admin' }, { role: 'owner' }]) {
    const { handler, calls, res } = fixture({ claims });
    await handler({ method: 'POST', headers: { authorization: 'Bearer dummy-token' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(Object.keys(res.body), ['success', 'role']);
    assert.equal(res.body.role, claims.role === 'owner' ? 'owner' : 'admin');
    assert.deepEqual(calls[0], ['verify', 'dummy-token', true]);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('일반 계정·문자열 admin·멤버십 표시는 관리자 권한이 아니다', async () => {
  for (const claims of [{}, { admin: 'true' }, { membership: 'Administrator' }, { role: 'none', admin: false }]) {
    const { handler, res } = fixture({ claims });
    await handler({ method: 'POST', headers: { authorization: 'Bearer dummy' } }, res);
    assert.equal(res.code, 403);
  }
});

test('토큰 누락·잘못된 타입은 인증 조회 전에 거부한다', async () => {
  for (const authorization of [undefined, 123, 'Basic dummy', 'Bearer ']) {
    const { handler, res, calls } = fixture();
    await handler({ method: 'POST', headers: { authorization } }, res);
    assert.equal(res.code, 401);
    assert.equal(calls.length, 0);
  }
});

test('철회된 토큰·비활성 계정은 거부하고 조회 장애는 503으로 닫는다', async () => {
  for (const [options, code] of [
    [{ tokenError: new Error('secret-token') }, 401],
    [{ disabled: true, claims: { admin: true } }, 401],
    [{ lookupError: new Error('secret-account') }, 503]
  ]) {
    const { handler, res, calls } = fixture(options);
    await handler({ method: 'POST', headers: { authorization: 'Bearer dummy' } }, res);
    assert.equal(res.code, code);
    assert.doesNotMatch(JSON.stringify({ body: res.body, calls }), /secret-token|secret-account/);
  }
});

test('GET은 거부하고 CORS 사전 요청에는 인증을 요구하지 않는다', async () => {
  for (const [method, code] of [['GET', 405], ['OPTIONS', 204]]) {
    const { handler, res, calls } = fixture();
    await handler({ method, headers: {} }, res);
    assert.equal(res.code, code);
    assert.equal(calls.length, 0);
  }
});

test('설정 페이지 권한 요청은 현재 owner만 허용하고 일반 관리자도 거부한다', async () => {
  for (const claims of [{ role: 'owner' }, { role: 'admin' }, { admin: true }, {}]) {
    const { handler, res } = fixture({ claims });
    await handler({ method: 'POST', headers: { authorization: 'Bearer dummy' }, body: { scope: 'settings' } }, res);
    assert.equal(res.code, claims.role === 'owner' ? 200 : 403);
  }
});
