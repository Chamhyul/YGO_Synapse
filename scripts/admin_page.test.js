const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const user = { uid: 'test-owner', displayName: '검증용 관리자', getIdToken: async () => 'test-token' };
function fixture({ currentUser = user, rendered = false, code = 200, body = {}, establish, redirectError } = {}) {
  const nodes = new Map(); const events = new Map(); const calls = []; let notify; let expire;
  for (const id of ['admin-login', 'admin-status', 'admin-providers', 'admin-retry', 'admin-switch', 'admin-google', 'admin-twitter']) {
    nodes.set(id, { hidden: id !== 'admin-login' || rendered, disabled: false, textContent: '', events: {}, addEventListener(k, fn) { this.events[k] = fn; } });
  }
  if (rendered) for (const id of ['admin-content', 'admin-account', 'admin-settings', 'admin-logout']) {
    nodes.set(id, { hidden: false, dataset: { adminUid: user.uid, adminRole: 'owner' }, events: {}, addEventListener(k, fn) { this.events[k] = fn; } });
  }
  const auth = {
    currentUser, onAuthStateChanged(fn) { notify = fn; fn(this.currentUser); },
    getRedirectResult: () => redirectError ? Promise.reject(Error()) : Promise.resolve(),
    async signOut() { calls.push('firebaseSignOut'); this.currentUser = null; notify(null); },
    async signInWithPopup(provider) { calls.push(provider.name); }, async signInWithRedirect(provider) { calls.push(provider.name); }
  };
  const context = {
    document: { title: '서버가 제공한 제목', body: { dataset: { adminPage: '/admin/cards', ...body } }, getElementById: id => nodes.get(id) || null,
      addEventListener(k, fn) { events.set(k, fn); } },
    window: { addEventListener(k, fn) { events.set(k, fn); },
      createAuthSession({ onExpire }) { expire = onExpire; return { start: () => true, stop() { calls.push('stop'); }, check: () => true }; },
      adminSession: {
        async clear() { calls.push('clear'); }, mark(active) { calls.push(['mark', active]); },
        async establish(next) { calls.push(['establish', next.uid]); return establish ? establish() : { status: code, ok: code === 200 }; }
      }
    },
    location: { hostname: 'localhost', replace(route) { calls.push(['replace', route]); }, reload() { calls.push('reload'); } },
    firebase: { auth: Object.assign(() => auth, { GoogleAuthProvider: class { name = 'google'; }, TwitterAuthProvider: class { name = 'x'; } }) }
  };
  vm.runInNewContext(source, context);
  return { context, nodes, events, calls, auth, expire: () => expire(), notify(next) { auth.currentUser = next; notify(next); } };
}
test('서버가 인증해 제공한 문서는 Firebase 복원 중에도 화면을 유지하고 추가 권한 API를 호출하지 않는다', async () => {
  const f = fixture({ rendered: true });
  assert.equal(f.nodes.get('admin-content').hidden, false);
  await settle(); assert.equal(f.nodes.get('admin-login').hidden, true);
  assert.equal(f.nodes.get('admin-account').textContent, user.displayName);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'establish'), false);
  assert.equal(f.context.document.title, '서버가 제공한 제목');
  assert.equal(f.events.has('visibilitychange'), false);
});
test('최초 진입은 기존 Firebase 세션을 서버 세션으로 교환하고 요청한 독립 경로로 이동한다', async () => {
  const f = fixture(); await settle();
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'establish'));
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'replace' && c[1] === '/admin/cards'));
});
test('비로그인은 서버 세션을 만들지 않고 Google·X만 제공한다', async () => {
  const f = fixture({ currentUser: null }); await settle();
  assert.equal(f.nodes.get('admin-providers').hidden, false);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'establish'), false);
  await f.nodes.get('admin-google').events.click(); await f.nodes.get('admin-twitter').events.click();
  assert.ok(f.calls.includes('google')); assert.ok(f.calls.includes('x'));
});
test('로그아웃·30분 만료는 즉시 화면을 숨기고 Firebase와 서버 세션을 모두 종료한다', async () => {
  for (const expire of [false, true]) {
    const f = fixture({ rendered: true }); await settle();
    if (expire) f.expire(); else f.nodes.get('admin-logout').events.click();
    assert.equal(f.nodes.get('admin-content').hidden, true); await settle();
    assert.ok(f.calls.includes('clear')); assert.ok(f.calls.includes('firebaseSignOut'));
    if (expire) assert.match(f.nodes.get('admin-status').textContent, /30분/);
  }
});
test('서버 만료 응답은 기존 Firebase 세션으로 자동 재발급하지 않고 로그아웃한다', async () => {
  const f = fixture({ body: { adminExpired: 'true' } }); await settle();
  assert.ok(f.calls.includes('firebaseSignOut'));
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'establish'), false);
});
test('서버가 거부한 소유자 페이지·장애 응답은 재발급 루프를 만들지 않는다', async () => {
  for (const body of [{ adminDenied: 'true' }, { adminUnavailable: 'true' }]) {
    const f = fixture({ body }); await settle();
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'establish'), false);
    assert.equal(f.nodes.get('admin-switch').hidden, false);
  }
});
test('세션 발급 도중 계정이 사라지면 늦은 응답으로 이동하지 않고 서버 쿠키를 제거한다', async () => {
  let done; const f = fixture({ establish: () => new Promise(resolve => { done = resolve; }) }); await settle();
  f.notify(null); done({ status: 200, ok: true }); await settle();
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'replace'), false); assert.ok(f.calls.includes('clear'));
});
test('서버 권한 거부와 오류는 재로그인 또는 재시도 화면으로 처리한다', async () => {
  for (const code of [401, 403, 503]) {
    const f = fixture({ code }); await settle();
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'replace'), false);
    if (code === 401) assert.ok(f.calls.includes('firebaseSignOut'));
    if (code === 403) assert.match(f.nodes.get('admin-status').textContent, /관리자 권한/);
    if (code === 503) assert.equal(f.nodes.get('admin-retry').hidden, false);
  }
});
test('뒤로가기 캐시 복원은 서버에 문서를 다시 요청한다', async () => {
  const f = fixture({ rendered: true }); await settle();
  f.events.get('pageshow')({ persisted: false }); assert.equal(f.calls.includes('reload'), false);
  f.events.get('pageshow')({ persisted: true }); assert.ok(f.calls.includes('reload'));
});
test('여섯 관리자 문서는 서버 템플릿에만 존재하고 Hosting은 서버 함수로 연결한다', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '../firebase.json')));
  assert.equal(c.hosting.rewrites[0].function.functionId, 'adminPages');
  assert.equal(c.hosting.rewrites.some(r => r.destination?.startsWith('/admin')), false);
  const { load } = require('../functions/node_modules/cheerio');
  const routes = ['/admin', '/admin/notices', '/admin/cards', '/admin/server-logs', '/admin/admin-logs'];
  for (const name of ['home', 'notices', 'cards', 'server-logs', 'admin-logs', 'settings']) {
    const $ = load(fs.readFileSync(path.join(__dirname, '../functions/templates/admin', name + '.html'), 'utf8'));
    for (const selector of ['.admin-sidebar-links', '.admin-bottom-nav']) assert.deepEqual($(selector).find('a').toArray().map(a => $(a).attr('href')), routes);
    assert.equal($('#admin-settings').attr('href'), '/admin/settings');
    assert.equal($('script[src="/admin.js?v=6"]').length, 1);
    assert.equal($('script[src="/admin-session.js?v=2"]').length, 1);
    assert.equal(fs.existsSync(path.join(__dirname, '../public/admin', name + '.html')), false);
  }
  assert.equal(fs.existsSync(path.join(__dirname, '../public/admin.html')), false);
  const main = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(main, /href=["'][^"']*\/admin/);
  assert.match(main, /admin-session.js\?v=2/);
});
