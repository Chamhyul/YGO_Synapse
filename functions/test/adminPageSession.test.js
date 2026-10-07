const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAdminPageHandler, createMemoryStore, createFirestoreStore, PAGES, IDLE_MS } = require('../services/adminPageSession');
function fixture(role = 'owner', getErrorSummary, getTrafficSummary, notices) {
  let time = 10000000; let disabled = false; let revoked = false; let failure = false;
  const calls = []; const issued = new Set(); const store = createMemoryStore();
  const auth = {
    async verifyIdToken(token, checkRevoked) { calls.push(['token', checkRevoked]); if (token !== 'valid') throw Error(); return { uid: 'test-owner' }; },
    async getUser() { calls.push(['claims']); if (failure) throw Error('secret-must-not-leak'); return { disabled, customClaims: role === 'flag' ? { admin: true } : { role } }; },
    async createSessionCookie(token, options) { calls.push(['issue', options.expiresIn]); issued.add('test-signed-cookie'); return 'test-signed-cookie'; },
    async verifySessionCookie(cookie, checkRevoked) {
      calls.push(['cookie', checkRevoked]);
      if (revoked || !issued.has(cookie)) { const error = Error(); error.code = 'auth/session-cookie-revoked'; throw error; }
      return { uid: 'test-owner' };
    }
  };
  const handler = createAdminPageHandler({ auth, store, getErrorSummary, getTrafficSummary, notices, now: () => time,
    template: name => fs.readFile(path.join(__dirname, '../templates/admin', name + '.html'), 'utf8') });
  async function request(url = '/admin', { method = 'GET', cookie = '', origin = 'http://localhost:5005', headers = {}, body = {} } = {}) {
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; },
      type(t) { this.headers['Content-Type'] = t; return this; }, send(v) { this.body = v; return this; }, json(v) { this.body = v; return this; } };
    const parsed = new URL(origin);
    await handler({ url, method, protocol: parsed.protocol.slice(0, -1), body,
      headers: { host: parsed.host, origin, 'content-type': 'application/json', cookie, ...headers } }, res);
    return res;
  }
  async function signIn(origin) { return request('/admin/session', { method: 'POST', origin, headers: { authorization: 'Bearer valid' } }); }
  return { request, signIn, calls, cookie: '__session=test-signed-cookie', advance(ms) { time += ms; }, role(v) { role = v; },
    disable() { disabled = true; }, revoke() { revoked = true; }, fail() { failure = true; } };
}
test('세션이 없으면 로그인 문서만 제공하고 관리자 본문은 응답에 포함하지 않는다', async () => {
  const f = fixture(); const res = await f.request('/admin/cards');
  assert.equal(res.code, 200); assert.match(res.body, /id="admin-login"/); assert.doesNotMatch(res.body, /id="admin-content"/);
  assert.match(res.body, /data-admin-page="\/admin\/cards"/); assert.equal(f.calls.length, 0);
});
test('로그인 토큰 검증·현재 Claims 확인 후 HttpOnly 세션 쿠키를 발급한다', async () => {
  const f = fixture(); const res = await f.signIn();
  assert.equal(res.code, 200); assert.equal(res.body.role, 'owner');
  assert.match(res.headers['Set-Cookie'], /Path=\/admin; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(res.headers['Set-Cookie'], /Expires|Max-Age/);
  assert.deepEqual(f.calls[0], ['token', true]);
  const https = await fixture().signIn('https://ygo-synapse.web.app'); assert.match(https.headers['Set-Cookie'], /; Secure$/);
});
test('UID나 admin=true 본문은 소유자 권한의 근거가 아니며 일반 계정은 거부한다', async () => {
  const f = fixture('user'); const res = await f.request('/admin/session', { method: 'POST', headers: { authorization: 'Bearer valid' }, body: { role: 'owner', admin: true } });
  assert.equal(res.code, 403); assert.equal(res.headers['Set-Cookie'], undefined);
});
test('조작 토큰·비활성 계정은 쿠키를 발급하지 않는다', async () => {
  const f = fixture(); assert.equal((await f.request('/admin/session', { method: 'POST', headers: { authorization: 'Bearer forged' } })).code, 401);
  f.disable(); assert.equal((await f.signIn()).code, 401);
});
test('CSRF: 다른 Origin·Origin 누락·폼 요청·비 HTTPS 원격 주소를 거부한다', async () => {
  for (const options of [{ headers: { origin: 'https://evil.example' } }, { headers: { origin: undefined } },
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } }, { origin: 'http://192.168.0.22:5005' }]) {
    const f = fixture(); const res = await f.request('/admin/session', { method: 'POST', ...options });
    assert.equal(res.code, 403); assert.equal(f.calls.length, 0);
  }
});
test('서명된 세션으로 여섯 페이지를 바로 제공하고 owner 상단 링크를 서버에서 표시한다', async () => {
  const f = fixture(); await f.signIn(); const before = f.calls.filter(c => c[0] === 'token').length;
  for (const route of PAGES.keys()) {
    const res = await f.request(route + '/', { cookie: f.cookie });
    assert.equal(res.code, 200); assert.match(res.body, /id="admin-login"[^>]*hidden/);
    assert.doesNotMatch(res.body, /id="admin-content"[^>]*hidden/); assert.match(res.body, /data-admin-role="owner"/);
    assert.doesNotMatch(res.body, /id="admin-settings"[^>]*hidden/);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
  }
  assert.equal(f.calls.filter(c => c[0] === 'token').length, before);
  assert.equal(f.calls.filter(c => c[0] === 'cookie').length, 6);
  assert.ok(f.calls.filter(c => c[0] === 'cookie').every(c => c[1] === true));
});
test('일반 관리자는 다섯 화면만 접근하고 설정 HTML과 owner 링크를 받지 않는다', async () => {
  for (const role of ['admin', 'flag']) {
    const f = fixture(role); await f.signIn(); const home = await f.request('/admin', { cookie: f.cookie });
    assert.equal(home.code, 200); assert.match(home.body, /id="admin-settings"[^>]*hidden/);
    const settings = await f.request('/admin/settings', { cookie: f.cookie }); assert.equal(settings.code, 403);
    assert.doesNotMatch(settings.body, /id="admin-content"/);
  }
});
test('권한 변경은 다음 페이지 요청에서 현재 Claims로 반영된다', async () => {
  const f = fixture(); await f.signIn(); f.role('admin');
  assert.equal((await f.request('/admin/settings', { cookie: f.cookie })).code, 403);
  f.role('user'); const res = await f.request('/admin/cards', { cookie: f.cookie }); assert.doesNotMatch(res.body, /id="admin-content"/);
});
test('조작·중복·철회된 쿠키와 비활성 계정은 관리자 HTML을 받지 못한다', async () => {
  for (const invalid of ['__session=forged', '__session=test-signed-cookie; __session=test-signed-cookie']) {
    const f = fixture(); await f.signIn(); assert.doesNotMatch((await f.request('/admin', { cookie: invalid })).body, /id="admin-content"/);
  }
  const f = fixture(); await f.signIn(); f.revoke(); assert.doesNotMatch((await f.request('/admin', { cookie: f.cookie })).body, /id="admin-content"/);
  const d = fixture(); await d.signIn(); d.disable(); assert.doesNotMatch((await d.request('/admin', { cookie: d.cookie })).body, /id="admin-content"/);
});
test('페이지 조회는 활동 시간을 연장하지 않고30분이면 서버가 세션을 거부한다', async () => {
  const f = fixture(); await f.signIn(); f.advance(IDLE_MS - 1);
  assert.match((await f.request('/admin', { cookie: f.cookie })).body, /id="admin-content"/);
  f.advance(1); const res = await f.request('/admin', { cookie: f.cookie });
  assert.doesNotMatch(res.body, /id="admin-content"/); assert.match(res.body, /data-admin-expired="true"/);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});
test('일반·관리자 화면의 실제 활동만 서버 시간을 갱신하며 만료 후에는 되살리지 못한다', async () => {
  const f = fixture(); await f.signIn(); f.advance(IDLE_MS - 1);
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } })).code, 204);
  f.advance(IDLE_MS - 1); assert.match((await f.request('/admin', { cookie: f.cookie })).body, /id="admin-content"/);
  f.advance(1); assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } })).code, 401);
});
test('다른 계정의 활동은 기존 관리자 세션을 연장하지 못한다', async () => {
  const f = fixture(); await f.signIn();
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'other' } })).code, 401);
});
test('로그아웃하면 서버 기록도 삭제되어 복사한 쿠키로 재접속할 수 없다', async () => {
  const f = fixture(); await f.signIn();
  assert.equal((await f.request('/admin/session/logout', { method: 'POST', cookie: f.cookie })).code, 204);
  assert.doesNotMatch((await f.request('/admin', { cookie: f.cookie })).body, /id="admin-content"/);
});
test('권한 조회 장애는503으로 차단하고 원문·민감 정보를 응답하지 않는다', async () => {
  const f = fixture(); await f.signIn(); f.fail(); const res = await f.request('/admin', { cookie: f.cookie });
  assert.equal(res.code, 503); assert.doesNotMatch(res.body, /id="admin-content"|secret-must-not-leak/);
});
test('원본 HTML URL·미등록 경로·우회 경로는404, 엔드포인트 GET은405다', async () => {
  const f = fixture();
  for (const route of ['/admin.html', '/admin/cards.html', '/admin/unknown', '/admin/../templates/admin/home.html']) assert.equal((await f.request(route)).code, 404);
  assert.equal((await f.request('/admin/session')).code, 405);
});

test('활동을 계속해도12시간 절대 만료는 연장되지 않는다', async () => {
  const f = fixture(); await f.signIn();
  for (let i = 0; i < 47; i++) {
    f.advance(15 * 60 * 1000);
    assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } })).code, 204);
  }
  f.advance(15 * 60 * 1000);
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } })).code, 401);
});

test('Firestore 세션 저장소는 트랜잭션에서 UID·만료를 확인하고 삭제된 세션을 재생성하지 않는다', async () => {
  const rows = new Map();
  const ref = key => ({ key, async get() { return { exists: rows.has(key), data: () => rows.get(key) }; },
    async set(value) { rows.set(key, value); }, async delete() { rows.delete(key); } });
  const db = { collection(name) { assert.equal(name, 'AdminWebSessions'); return { doc: ref }; },
    async runTransaction(fn) { return fn({ get: r => r.get(), update(r, value) { rows.set(r.key, { ...rows.get(r.key), ...value }); } }); } };
  const store = createFirestoreStore(db);
  await store.set('hash-only', { uid: 'test-owner', lastActivity: 1000, expiresAt: 99999999 });
  assert.equal(await store.touch('hash-only', 'other', 1100), false);
  assert.equal(await store.touch('hash-only', 'test-owner', 1200), true);
  assert.equal((await store.get('hash-only')).lastActivity, 1200);
  assert.equal(await store.touch('hash-only', 'test-owner', 1200 + IDLE_MS), false);
  await store.remove('hash-only');
  assert.equal(await store.touch('hash-only', 'test-owner', 1300), false);
  assert.equal(rows.size, 0);
});

test('오류 API는 관리자 세션과 현재 권한을 매 요청 확인하고 인증 전 외부 조회를 하지 않는다', async () => {
  let reads = 0;
  const f = fixture('owner', async () => { reads++; return { occurrenceCount: 0 }; });
  assert.equal((await f.request('/admin/api/errors')).code, 401); assert.equal(reads, 0);
  await f.signIn();
  const success = await f.request('/admin/api/errors', { cookie: f.cookie });
  assert.equal(success.code, 200); assert.equal(success.body.success, true);
  assert.equal(success.headers['Cache-Control'], 'private, no-store'); assert.equal(reads, 1);
  f.role('user'); assert.equal((await f.request('/admin/api/errors', { cookie: f.cookie })).code, 401); assert.equal(reads, 1);
});
test('오류 API는 만료·철회된 쿠키, 임의 조회 조건과 쓰기 요청을 거부한다', async () => {
  for (const expire of [f => f.advance(IDLE_MS), f => f.revoke()]) {
    const f = fixture('admin', async () => { throw Error('조회되면 안 됨'); }); await f.signIn(); expire(f);
    assert.equal((await f.request('/admin/api/errors', { cookie: f.cookie })).code, 401);
    const page = await f.request('/admin', { cookie: f.cookie });
    assert.match(page.body, /data-admin-expired="true"/);
  }
  const f = fixture('admin', async () => ({})); await f.signIn();
  assert.equal((await f.request('/admin/api/errors?project=other', { cookie: f.cookie })).code, 400);
  assert.equal((await f.request('/admin/api/errors', { method: 'POST', cookie: f.cookie })).code, 405);
});
test('오류 API 조회 장애는 원본 메시지를 숨긴503 JSON이며 홈 로그인 상태와 구분된다', async () => {
  const f = fixture('owner', async () => { throw Error('private-secret'); }); await f.signIn();
  const res = await f.request('/admin/api/errors', { cookie: f.cookie });
  assert.equal(res.code,503); assert.deepEqual(res.body,{success:false});
  assert.equal((await f.request('/admin', { cookie: f.cookie })).code,200);
});

test('방문 통계 API도 현재 관리자 세션을 확인하며 일반 계정·임의 조회 조건을 거부한다', async () => {
  let reads = 0;
  const f = fixture('admin', undefined, async () => { reads++; return { current: { activeUsers: 1 } }; });
  assert.equal((await f.request('/admin/api/traffic')).code,401); assert.equal(reads,0);
  await f.signIn();
  const res = await f.request('/admin/api/traffic', { cookie:f.cookie });
  assert.equal(res.code,200);assert.equal(res.body.current.activeUsers,1);assert.equal(res.headers['Cache-Control'],'private, no-store');
  assert.equal((await f.request('/admin/api/traffic?property=other', {cookie:f.cookie})).code,400);
  f.role('user');assert.equal((await f.request('/admin/api/traffic', {cookie:f.cookie})).code,401);assert.equal(reads,1);
});

test('공지 API는 세션·현재 권한·CSRF를 검사하고 미리보기는 저장 없이 제공한다', async () => {
  let writes=0, previews=0;
  const service={list:async()=>({notices:[],revision:'0'}),mutate:async()=>{writes++;return{};},preview:async()=>{previews++;return{title:'제목',content:'본문'};}};
  const f=fixture('admin',undefined,undefined,service);
  assert.equal((await f.request('/admin/api/notices')).code,401);await f.signIn();
  assert.equal((await f.request('/admin/api/notices',{cookie:f.cookie})).code,200);
  assert.equal((await f.request('/admin/api/notices',{method:'POST',cookie:f.cookie,headers:{origin:'https://evil.example'}})).code,403);
  assert.equal(writes,0);
  assert.equal((await f.request('/admin/api/notices/preview',{method:'POST',cookie:f.cookie})).code,200);assert.equal(previews,1);assert.equal(writes,0);
  f.role('user');assert.equal((await f.request('/admin/api/notices',{method:'POST',cookie:f.cookie})).code,401);assert.equal(writes,0);
});
test('공지 충돌은409로 반환하고 저장소 장애의 원문은 숨긴다',async()=>{
  for(const [error,expected] of [[Object.assign(Error('공지 충돌'),{status:409}),409],[Error('private-secret'),503]]){
    const f=fixture('owner',undefined,undefined,{mutate:async()=>{throw error;}});await f.signIn();
    const res=await f.request('/admin/api/notices',{method:'POST',cookie:f.cookie});assert.equal(res.code,expected);assert.doesNotMatch(JSON.stringify(res.body),/private-secret/);
  }
});
