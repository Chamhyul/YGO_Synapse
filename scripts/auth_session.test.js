const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/auth-session.js'), 'utf8');
const TIMEOUT = 30 * 60 * 1000;

function environment() {
  let now = 10000000;
  let timerId = 0;
  const tabs = [];
  const saved = new Map();
  function tab() {
    const listeners = new Map();
    const timers = new Map();
    let expired = 0;
    const events = {
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); }
    };
    const root = {
      ...events, document: events,
      setTimeout(handler, delay) { const id = ++timerId; timers.set(id, { handler, due: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      localStorage: {
        getItem: key => saved.get(key) || null,
        setItem(key, value) {
          saved.set(key, value);
          tabs.filter(other => other !== api).forEach(other => other.emit('storage', { key }));
        }
      }
    };
    vm.runInNewContext(source, { window: root, Date: { now: () => now, parse: Date.parse } });
    const session = root.createAuthSession({ onExpire: () => { expired++; } });
    const api = {
      session, saved,
      emit: (name, event = {}) => listeners.get(name)?.(event),
      get expired() { return expired; },
      runTimers() {
        for (const [id, timer] of [...timers]) {
          if (timer.due <= now) { timers.delete(id); timer.handler(); }
        }
      }
    };
    tabs.push(api);
    return api;
  }
  return { tab, saved, advance(ms) { now += ms; tabs.forEach(tab => tab.runTimers()); }, elapse(ms) { now += ms; }, now: () => now };
}

test('30분 비활동에서 한 번만 만료되고 활동은 타이머를 연장한다', () => {
  const env = environment(); const a = env.tab();
  a.session.start({ uid: 'a' });
  env.advance(TIMEOUT - 1000);
  assert.equal(a.expired, 0);
  a.emit('click');
  env.advance(TIMEOUT - 1);
  assert.equal(a.expired, 0);
  env.advance(1);
  assert.equal(a.expired, 1);
  env.advance(TIMEOUT);
  assert.equal(a.expired, 1);
});

test('다른 일반·관리자 탭의 활동을 공유하고 모두 같은 시각에 만료한다', () => {
  const env = environment(); const a = env.tab(); const b = env.tab();
  a.session.start({ uid: 'a' }); b.session.start({ uid: 'a' });
  env.advance(20 * 60 * 1000);
  b.emit('keydown');
  env.advance(20 * 60 * 1000);
  assert.equal(a.expired + b.expired, 0);
  env.advance(10 * 60 * 1000);
  assert.equal(a.expired, 1); assert.equal(b.expired, 1);
});

test('새로고침·새 탭 진입은 기존 타이머를 초기화하지 않는다', () => {
  const env = environment(); const a = env.tab();
  a.session.start({ uid: 'a' });
  env.advance(20 * 60 * 1000); a.session.stop();
  const b = env.tab(); b.session.start({ uid: 'a' });
  env.advance(10 * 60 * 1000);
  assert.equal(b.expired, 1);
});

test('백그라운드 타이머 지연 후 첫 활동으로 만료 세션을 되살릴 수 없다', () => {
  const env = environment(); const a = env.tab();
  a.session.start({ uid: 'a' }); env.elapse(TIMEOUT + 1); a.emit('click');
  assert.equal(a.expired, 1);
});

test('새로운 명시적 로그인은 만료된 활동 시각을 갱신한다', () => {
  const env = environment(); const a = env.tab();
  a.session.start({ uid: 'a' }); env.advance(TIMEOUT);
  assert.equal(a.session.start({ uid: 'a', metadata: { lastSignInTime: new Date(env.now()).toUTCString() } }), true);
  env.advance(TIMEOUT);
  assert.equal(a.expired, 2);
});

test('계정별 활동은 분리하고 stop 뒤 활동은 기록하지 않는다', () => {
  const env = environment(); const a = env.tab(); const b = env.tab();
  a.session.start({ uid: 'a' }); b.session.start({ uid: 'b' });
  env.advance(20 * 60 * 1000); b.emit('click');
  env.advance(10 * 60 * 1000);
  assert.equal(a.expired, 1); assert.equal(b.expired, 0);
  b.session.stop(); const before = env.saved.get('ygo_auth_activity:b');
  env.elapse(1000); b.emit('click');
  assert.equal(env.saved.get('ygo_auth_activity:b'), before);
});

test('공유 활동 기록 도입 전의 기존 로그인도 최초 진입부터 30분 추적한다', () => {
  const env = environment(); const a = env.tab();
  assert.equal(a.session.start({ uid: 'existing', metadata: { lastSignInTime: new Date(1000).toUTCString() } }), true);
  env.advance(TIMEOUT);
  assert.equal(a.expired, 1);
});
