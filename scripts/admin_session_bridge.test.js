const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/admin-session.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ user = { uid: 'test', getIdToken: async () => 'dummy' }, active = false, code = 204 } = {}) {
  let time = 100000; let notify; const calls = []; const saved = new Map();
  if (active) saved.set('ygo_admin_server_session', 'active');
  const auth = { currentUser: user, onAuthStateChanged(fn) { notify = fn; fn(user); } };
  const root = { localStorage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) } };
  vm.runInNewContext(source, { window: root, AbortController, setTimeout, clearTimeout, location: { hostname: 'localhost' }, Date: { now: () => time }, firebase: { auth: () => auth },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: code < 400, status: code }; } });
  return { bridge: root.adminSession, calls, saved, advance(ms) { time += ms; }, notify(user) { auth.currentUser = user; notify(user); } };
}
test('브라우저 마커가 있어도 로그인만으로 세션을 발급하거나 주기 요청을 하지 않는다', async () => {
  const f = fixture({ active: true }); await settle(); assert.equal(f.calls.length, 0);
});
test('활동은 기존 서버 세션이 있는 경우에만 전송하고10초 안에는 중복 전송하지 않는다', async () => {
  const f = fixture({ active: true }); f.bridge.activity(); f.bridge.activity(); await settle(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/admin/session/activity'); assert.deepEqual(JSON.parse(f.calls[0].options.body), { uid: 'test' });
  f.advance(10000); f.bridge.activity(); await settle(); assert.equal(f.calls.length, 2);
  const absent = fixture(); absent.bridge.activity(); assert.equal(absent.calls.length, 0);
});
test('계정 변경·공유 로그아웃은 서버 세션 삭제를 요청하고 마커를 지운다', async () => {
  const f = fixture({ active: true }); f.notify({ uid: 'other' }); await settle();
  assert.equal(f.calls[0].url, '/admin/session/logout'); assert.equal(f.saved.size, 0);
  f.notify(null); await settle(); assert.equal(f.calls.length, 2);
});
test('세션 발급 요청은 기존 Firebase 토큰을 동일 출처 POST로 전송하고 성공할 때만 마커를 기록한다', async () => {
  const f = fixture({ code: 200 }); await f.bridge.establish({ uid: 'test', getIdToken: async () => 'dummy' });
  assert.equal(f.calls[0].url, '/admin/session'); assert.equal(f.calls[0].options.headers.Authorization, 'Bearer dummy');
  assert.equal(f.calls[0].options.credentials, 'same-origin'); assert.equal(f.saved.get('ygo_admin_server_session'), 'active');
});
test('서버가 만료를 알리면 표시용 마커도 제거한다', async () => {
  const f = fixture({ active: true, code: 401 }); f.bridge.activity(); await settle(); assert.equal(f.saved.size, 0);
});
