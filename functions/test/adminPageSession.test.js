const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAdminPageHandler, createMemoryStore, createFirestoreStore, PAGES, IDLE_MS } = require('../services/adminPageSession');
function fixture(role = 'owner', getErrorSummary, getTrafficSummary, notices, membershipCsv) {
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
  const handler = createAdminPageHandler({ auth, store, getErrorSummary, getTrafficSummary, notices, membershipCsv, now: () => time,
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
  return { request, signIn, calls, store, auth, cookie: '__session=test-signed-cookie', advance(ms) { time += ms; }, role(v) { role = v; },
    disable() { disabled = true; }, revoke() { revoked = true; }, fail() { failure = true; } };
}
test('세션이 없으면 로그인 문서만 제공하고 관리자 본문은 응답에 포함하지 않는다', async () => {
  const f = fixture(); const res = await f.request('/admin/cards');
  assert.equal(res.code, 200); assert.match(res.body, /id="admin-login"/); assert.doesNotMatch(res.body, /id="admin-content"/);
  assert.match(res.body, /data-admin-page="\/admin\/cards"/); assert.equal(f.calls.length, 0);
});
test('쿠키 없는 로그인 문서는 전환 저장소를 조회하지 않으며 보호 API도 익명으로 거부한다', async () => {
  const f=fixture();let entered=0;
  f.store.withRequest=async()=>{entered++;throw Error('synthetic-storage-down');};
  const document=await f.request('/admin/settings');
  assert.equal(document.code,200);assert.doesNotMatch(document.body,/id="admin-content"/);
  assert.equal((await f.request('/admin/api/traffic')).code,401);
  assert.equal(entered,0);
  assert.equal((await f.signIn()).code,503);assert.equal(entered,1);
});
test('로그인 토큰 검증·현재 Claims 확인 후 HttpOnly 세션 쿠키를 발급한다', async () => {
  const f = fixture(); const res = await f.signIn();
  assert.equal(res.code, 200); assert.equal(res.body.role, 'owner');
  assert.match(res.headers['Set-Cookie'], /Path=\/admin; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(res.headers['Set-Cookie'], /Expires|Max-Age/);
  assert.deepEqual(f.calls[0], ['token', false]);
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
  assert.ok(f.calls.filter(c => c[0] === 'cookie').every(c => c[1] === false));
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


test('회원 CSV API도 현재 관리자 세션·CSRF를 검사하고 조회/미리보기/적용/결과를 구분한다',async()=>{
  const calls=[];
  const service={summary:async()=>{calls.push('read');return{count:1};},preview:async()=>{calls.push('preview');return{};},
    apply:async(_,uid)=>{calls.push(['apply',uid]);return{};},status:async(_,uid)=>{calls.push(['status',uid]);return{status:'completed'};}};
  const f=fixture('admin',undefined,undefined,undefined,service);
  assert.equal((await f.request('/admin/api/membership-csv')).code,401);assert.equal(calls.length,0);
  await f.signIn();
  assert.equal((await f.request('/admin/api/membership-csv',{cookie:f.cookie})).code,200);
  assert.equal((await f.request('/admin/api/membership-csv/preview',{cookie:f.cookie,method:'POST'})).code,200);
  assert.deepEqual(calls,['read','preview']);
  for(const headers of [{origin:'https://evil.invalid'},{'content-type':'text/plain'}]) {
    assert.equal((await f.request('/admin/api/membership-csv',{cookie:f.cookie,method:'POST',headers})).code,403);
  }
  assert.equal((await f.request('/admin/api/membership-csv',{cookie:f.cookie,method:'POST'})).code,200);
  assert.equal((await f.request('/admin/api/membership-csv/status',{cookie:f.cookie,method:'POST'})).code,200);
  assert.deepEqual(calls.slice(2),[['apply','test-owner'],['status','test-owner']]);
  assert.equal((await f.request('/admin/api/membership-csv?uid=owner',{cookie:f.cookie})).code,400);
  f.role('user');assert.equal((await f.request('/admin/api/membership-csv',{cookie:f.cookie,method:'POST'})).code,401);
});


test('공통 요청 종료가 실패하면 로그인 성공 본문과 쿠키를 전달하지 않는다', async () => {
  const f = fixture();
  f.store.withRequest = async (_req, work) => { await work(); throw new Error('synthetic journal end failure'); };
  const result = await f.signIn();
  assert.equal(result.code, 503); assert.deepEqual(result.body, { success: false, code: 'ADMIN_SESSION_UNAVAILABLE' });
  assert.equal(result.headers['Set-Cookie'], undefined);
});
test('공통 요청이 끝난 뒤 기존 로그인 응답과 쿠키 속성을 한 번 전달한다', async () => {
  const f = fixture(); let completed = false;
  f.store.withRequest = async (_req, work) => { const result = await work(); completed = true; return result; };
  const result = await f.signIn(); assert.equal(completed, true); assert.equal(result.code, 200);
  assert.deepEqual(result.body, { success: true, role: 'owner' });
  assert.match(result.headers['Set-Cookie'], /Path=\/admin; HttpOnly; SameSite=Strict/);
});

for (const [reason, code] of [['WRITER_RESOURCE_BUSY','ADMIN_SESSION_BUSY'],['WRITER_FENCED','ADMIN_SESSION_BUSY'],['WRITER_OUTCOME_UNRESOLVED','ADMIN_SESSION_RECOVERY_REQUIRED'],['WRITER_CANCELLED','ADMIN_SESSION_UNAVAILABLE']]) test(`세션 ${reason} 응답은 권한 부족으로 바꾸지 않는다`, async()=>{
 const f=fixture();f.store.withRequest=async()=>{throw Object.assign(Error('secret-detail'),{code:reason});};
 const result=await f.signIn();assert.equal(result.code,503);assert.deepEqual(result.body,{success:false,code});
 assert.equal(result.headers['Set-Cookie'],undefined);
});
test('요청 출처 거부와 실제 관리자 권한 부족을 고정 code로 구분한다',async()=>{
 assert.equal((await fixture('none').signIn()).body.code,'ADMIN_ROLE_REQUIRED');
 const res=await fixture().request('/admin/session',{method:'POST',headers:{origin:'https://evil.example'}});
 assert.equal(res.body.code,'ADMIN_REQUEST_REJECTED');
});

for (const [label,change] of [
 ['logout',async f=>{await f.request('/admin/session/logout',{method:'POST',cookie:f.cookie});}],
 ['권한 회수',async f=>f.role('user')],['계정 중지',async f=>f.disable()],['철회',async f=>f.revoke()],
 ['30분 만료',async f=>f.advance(IDLE_MS)],
]) test(`읽기 중 ${label}가 완료되면 수집한 응답을 전달하지 않는다`,async()=>{
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const f=fixture('owner',async()=>{entered();await gate;return{privateResult:'synthetic-private-result'};});
 await f.signIn();
 const pending=f.request('/admin/api/errors',{cookie:f.cookie});await ready;
 await change(f);release();const result=await pending;
 assert.equal(result.code,401);assert.doesNotMatch(JSON.stringify(result.body),/synthetic-private-result/);
});
test('페이지와 로그인은 최신 계정 한 번으로 철회·역할을 검사하고 이전 요청 값을 재사용하지 않는다',async()=>{
 const f=fixture();await f.signIn();assert.equal(f.calls.filter(c=>c[0]==='claims').length,1);
 f.calls.length=0;await f.request('/admin',{cookie:f.cookie});assert.equal(f.calls.filter(c=>c[0]==='claims').length,1);
 f.role('user');assert.doesNotMatch((await f.request('/admin',{cookie:f.cookie})).body,/id="admin-content"/);
});

test('읽기 응답의 마지막 잠금 종료가 실패하면 수집한 데이터와 성공 상태를 전달하지 않는다',async()=>{
 const f=fixture('owner',async()=>({privateResult:'synthetic-private-result'}));await f.signIn();
 let gates=0;f.store.withRequest=async(_req,work)=>{const result=await work();if(++gates===2)throw Error('synthetic-private-end-failure');return result;};
 const response=await f.request('/admin/api/errors',{cookie:f.cookie});
 assert.equal(response.code,503);assert.deepEqual(response.body,{success:false});
 assert.doesNotMatch(JSON.stringify(response),/synthetic-private-result|synthetic-private-end-failure/);
});
test('로그인 계정 조회 장애는 인증 실패와 구분한503이며 쿠키를 발급하지 않는다',async()=>{
 const f=fixture();f.fail();const response=await f.signIn();
 assert.equal(response.code,503);assert.equal(response.headers['Set-Cookie'],undefined);
 assert.equal(response.body.code,'ADMIN_SESSION_UNAVAILABLE');
});
for(const invalid of ['expired','disabled','role']) test(`읽기 사전 인증의 ${invalid} 거부는 세션을 쓰거나 외부 데이터를 조회하지 않는다`,async()=>{
 let reads=0;const f=fixture('owner',async()=>{reads++;return{};});await f.signIn();
 if(invalid==='expired')f.advance(IDLE_MS);
 if(invalid==='disabled')f.disable();
 if(invalid==='role')f.role('user');
 f.store.remove=async()=>assert.fail('읽기 전용 사전 확인에서 삭제하면 안 된다');
 f.store.withReadRequest=async(_req,authorize)=>({access:await authorize({readOnly:true})});
 const res=await f.request('/admin/api/errors',{cookie:f.cookie});
 assert.equal(res.code,401);assert.equal(reads,0);
});


test('활동 POST만 요청 journal을 재사용하고 발급·로그아웃 경계는 유지한다', async () => {
  const f = fixture(), seen = [];
  f.store.withRequest = async (_req, action, options) => { seen.push(options); return action(); };
  assert.equal((await f.signIn()).code, 200);
  assert.deepEqual(seen.pop(), { reuseJournal: false, activityOnly: false });
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } })).code, 204);
  assert.deepEqual(seen.pop(), { reuseJournal: true, activityOnly: true });
  await f.request('/admin/cards', { cookie: f.cookie });
  assert.deepEqual(seen.pop(), { reuseJournal: true, activityOnly: false });
  await f.request('/admin/session/logout', { method: 'POST', cookie: f.cookie });
  assert.deepEqual(seen.pop(), { reuseJournal: false, activityOnly: false });
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic-preparation-timeout')), 2000); })]).finally(() => clearTimeout(timer));
}
test('활동의 현재 Auth와 route는 병렬이며 양쪽 승인 전에는 활동을 쓰지 않고 요청마다 새로 확인한다', async () => {
  const f = fixture(); await f.signIn();
  const routeStarted = deferred(), routeReady = deferred(), accountStarted = deferred(), accountReady = deferred();
  const getUser = f.auth.getUser, touch = f.store.touch; let touched = 0;
  f.store.withRequest = async (req, action) => { routeStarted.resolve(); await routeReady.promise; return action(); };
  f.auth.getUser = async () => { accountStarted.resolve(); await accountReady.promise; return getUser(); };
  f.store.touch = async (...args) => { touched++; return touch(...args); };
  const before = f.calls.length, pending = f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, body: { uid: 'test-owner' } });
  try {
    await bounded(Promise.all([routeStarted.promise, accountStarted.promise])); assert.equal(touched, 0);
    routeReady.resolve(); await new Promise(setImmediate); assert.equal(touched, 0);
    accountReady.resolve(); assert.equal((await pending).code, 204); assert.equal(touched, 1);
    assert.deepEqual(f.calls.slice(before).map(c => c[0]).sort(), ['claims', 'cookie']);
    f.disable(); assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie })).code, 401);
    assert.equal(touched, 1); assert.equal(f.calls.slice(before).filter(c => c[0] === 'claims').length, 2);
  } finally { routeReady.resolve(); accountReady.resolve(); await pending; }
});
test('활동 route 실패 때 시작된 Auth를 회수하고 실패 응답을 유지한다', async () => {
  const f = fixture(); await f.signIn(); const entered = deferred(), release = deferred(); let settled = false, replied = false;
  f.auth.getUser = async () => { entered.resolve(); await release.promise; settled = true; throw Error('synthetic-account-down'); };
  f.store.withRequest = async () => { await entered.promise; throw Error('synthetic-route-down'); };
  const pending = f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie }).then(value => { replied = true; return value; });
  try {
    await bounded(entered.promise); await new Promise(setImmediate); assert.equal(replied, false);
    release.resolve(); const response = await pending; assert.equal(response.code, 503); assert.equal(settled, true);
    assert.equal(response.body.code, 'ADMIN_SESSION_UNAVAILABLE');
  } finally { release.resolve(); await pending; }
});
test('활동의 CSRF·조작 쿠키는 병렬 준비로 계정 조회나 쓰기를 허용하지 않는다', async () => {
  const f = fixture(); await f.signIn(); let writes = 0;
  f.store.withRequest = async (req, action) => action(); f.store.touch = async () => { writes++; return true; };
  const before = f.calls.length;
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: f.cookie, headers: { origin: 'https://evil.example' } })).code, 403);
  assert.equal(f.calls.length, before);
  assert.equal((await f.request('/admin/session/activity', { method: 'POST', cookie: '__session=forged' })).code, 401);
  assert.equal(f.calls.slice(before).filter(c => c[0] === 'claims').length, 0); assert.equal(writes, 0);
});
