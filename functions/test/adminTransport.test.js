const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminProxy, createAdminBackendHandler, createLocalAdminRenderer, BACKEND_URL } = require('../services/adminTransport');
const { createAdminPageHandler, createMemoryStore, IDLE_MS } = require('../services/adminPageSession');
function response() {
  return { code: 200, headers: {}, set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(v) { this.code = v; return this; }, type(v) { this.set('Content-Type', v); return this; },
    send(v) { this.body = v; return this; }, json(v) { this.type('application/json'); this.body = JSON.stringify(v); return this; } };
}
function request(route, { method = 'GET', token, cookie, origin = 'http://localhost:5005', body = {} } = {}) {
  return { originalUrl: route, url: route, method, protocol: 'http', body,
    headers: { host: 'localhost:5005', origin, 'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}) } };
}
function fixture() {
  let role = 'owner', time = 1000, reads = 0, writes = 0, authChecks = 0;
  const issued = new Set(), sent = [];
  const auth = {
    async verifyIdToken(token, checkRevoked) { assert.equal(checkRevoked, true); authChecks++; if (token !== 'valid') throw Error('invalid'); return { uid: 'test' }; },
    async getUser() { return { customClaims: { role } }; },
    async createSessionCookie() { issued.add('signed-cookie'); return 'signed-cookie'; },
    async verifySessionCookie(cookie, checkRevoked) { assert.equal(checkRevoked, true); if (!issued.has(cookie)) throw Object.assign(Error(), { code: 'auth/invalid-session-cookie' }); return { uid: 'test' }; }
  };
  const handler = createAdminPageHandler({ auth, store: createMemoryStore(), now: () => time,
    template: async () => '<html><title></title><body><section id="admin-login"></section><main id="admin-content" data-admin-title="관리자"><a id="admin-settings" hidden></a></main></body></html>',
    getTrafficSummary: async () => { reads++; return { value: 1 }; },
    getErrorSummary: async () => { reads++; return { value: 2 }; },
    notices: { async list() { reads++; return { revision: '1', notices: [] }; }, async mutate() { writes++; return {}; }, preview: () => ({}) }
  });
  const backend = createAdminBackendHandler({ handler, env: {} });
  const proxy = createAdminProxy({ fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, BACKEND_URL);
    sent.push({ url, options });
    const req = { originalUrl: new URL(url).pathname + new URL(url).search, method: options.method,
      headers: Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: options.body ? JSON.parse(options.body) : {} };
    const res = response(); await backend(req, res);
    return { status: res.code, headers: new Headers(res.headers), text: async () => res.body || '' };
  } });
  return { async call(route, options) { const res = response(); await proxy(request(route, options), res); return res; },
    sent, counts: () => ({ reads, writes, authChecks }), setRole(v) { role = v; }, expire() { time += IDLE_MS; } };
}
test('로컬은 사용자 토큰만 전달하고 운영 서버가 세션과 문서 권한을 결정한다', async () => {
  const f = fixture();
  const login = await f.call('/admin/session', { method: 'POST', token: 'valid' });
  assert.equal(login.code, 200); assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(login.headers['set-cookie'], /Secure/);
  assert.equal(f.sent[0].options.headers.Authorization, 'Bearer valid');
  const cookie = '__session=signed-cookie';
  const page = await f.call('/admin/notices', { cookie });
  assert.match(page.body, /data-admin-role="owner"/);
  assert.equal(f.sent[1].options.headers.Cookie, cookie);
  assert.equal(f.sent[1].options.headers.Authorization, undefined);
});
test('조작 토큰과 role 주장·일반 계정은 운영에서 거부하고 데이터를 조회하거나 저장하지 않는다', async () => {
  const f = fixture();
  assert.equal((await f.call('/admin/session', { method: 'POST', token: 'forged', body: { role: 'owner' } })).code, 401);
  f.setRole('user');
  assert.equal((await f.call('/admin/session', { method: 'POST', token: 'valid', body: { role: 'owner', admin: true } })).code, 403);
  for (const route of ['/admin/api/traffic', '/admin/api/errors', '/admin/api/notices']) {
    assert.equal((await f.call(route, { cookie: '__session=forged' })).code, 401);
  }
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, authChecks: 2 });
});
test('로컬 검사를 우회해도 운영은 현재 권한·세션 만료를 다시 검사하며 캐시 제공 전에 차단한다', async () => {
  const f = fixture(); await f.call('/admin/session', { method: 'POST', token: 'valid' });
  const cookie = '__session=signed-cookie';
  assert.equal((await f.call('/admin/api/traffic', { cookie })).code, 200);
  f.setRole('user');
  assert.equal((await f.call('/admin/api/traffic', { cookie })).code, 401);
  assert.equal((await f.call('/admin/api/notices', { method: 'POST', cookie, body: { action: 'delete' } })).code, 401);
  assert.equal(f.counts().reads, 1); assert.equal(f.counts().writes, 0);
  f.setRole('owner'); await f.call('/admin/session', { method: 'POST', token: 'valid' }); f.expire();
  assert.equal((await f.call('/admin/api/notices', { cookie })).code, 401);
});
test('운영 검사를 통과한 쓰기만 실행하며 다른 출처의 로컬 쓰기는 전송하지 않는다', async () => {
  const f = fixture(); await f.call('/admin/session', { method: 'POST', token: 'valid' });
  const cookie = '__session=signed-cookie';
  assert.equal((await f.call('/admin/api/notices', { method: 'POST', cookie, body: { action: 'update' } })).code, 200);
  assert.equal(f.counts().writes, 1);
  const before = f.sent.length;
  assert.equal((await f.call('/admin/api/notices', { method: 'POST', cookie, origin: 'https://evil.invalid' })).code, 403);
  assert.equal(f.sent.length, before);
});
test('운영 API의 에뮬레이터 실행은 권한 처리나 직접 데이터 접근 전에 차단한다', async () => {
  for (const env of [{ FUNCTIONS_EMULATOR: 'true' }, { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }, { FIREBASE_STORAGE_EMULATOR_HOST: 'localhost:5004' }, { FIRESTORE_EMULATOR_HOST: 'localhost:5003' }]) {
    let calls = 0;
    const backend = createAdminBackendHandler({ env, handler: () => { calls++; } });
    const res = response(); await backend(request('/adminBackend?route=%2Fadmin%2Fapi%2Fnotices'), res);
    assert.equal(res.code, 503); assert.equal(calls, 0);
  }
});
test('미배포·일반 HTML 응답·네트워크 장애는503이며 직접 조회로 대체하지 않는다', async () => {
  for (const fetchImpl of [async () => ({ status: 200, headers: new Headers(), text: async () => 'public home' }), async () => { throw Error('private-network-secret'); }]) {
    const proxy = createAdminProxy({ fetchImpl }); const res = response();
    await proxy(request('/admin/api/notices'), res);
    assert.equal(res.code, 503); assert.doesNotMatch(res.body, /secret|public home/);
  }
});
test('운영 서버는 고정된 관리자 경로만 처리하며 쿼리·UID로 다른 API를 호출할 수 없다', async () => {
  let calls = 0;
  const backend = createAdminBackendHandler({ env: {}, handler: () => { calls++; } });
  for (const url of ['/adminBackend?route=https%3A%2F%2Fevil.invalid', '/adminBackend?route=%2Fadmin&route=%2Fadmin', '/adminBackend?route=%2Fadmin&uid=owner', '/adminBackend?route=%2FmanageAdminRole']) {
    const res = response(); await backend(request(url), res); assert.equal(res.code, 404);
  }
  assert.equal(calls, 0);
  const res = response(); await createAdminProxy({ fetchImpl: () => { throw Error('must not call'); } })(request('/not-admin'), res);
  assert.equal(res.code, 404);
});
test('운영 인증 결과로 로컬 최신 템플릿을 표시하고 미인증·만료 시 본문은 제거한다', async () => {
  let revision = 1;
  const render = createLocalAdminRenderer(async () => `<html><title></title><body><section id="admin-login"></section><main id="admin-content" data-admin-title="공지 편집"><a id="admin-settings" hidden></a><p>로컬 수정 ${revision}</p></main></body></html>`);
  const signed = '<html><body><main id="admin-content" data-admin-uid="test" data-admin-role="owner"></main></body></html>';
  assert.match(await render(signed, '/admin/notices', 200), /로컬 수정 1/);
  revision++;
  assert.match(await render(signed, '/admin/notices', 200), /로컬 수정 2/);
  const expired = await render('<html><body data-admin-expired="true"></body></html>', '/admin/notices', 200);
  assert.doesNotMatch(expired, /id="admin-content"/); assert.match(expired, /data-admin-expired="true"/);
  await assert.rejects(render('<main id="admin-content" data-admin-role="owner"></main>', '/admin', 200));
});
