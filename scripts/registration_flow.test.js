const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function fixture(api) {
  const nodes = new Map(), calls = [];
  for (const id of ['auth-modal', 'signup-modal', 'terms-agree-cb', 'privacy-agree-cb', 'signup-status', 'signup-complete-btn']) {
    nodes.set(id, { id, checked: false, disabled: true, hidden: true, options: { dismissible: true },
      setAttribute() {}, querySelectorAll: () => [nodes.get('terms-agree-cb'), nodes.get('privacy-agree-cb')],
    });
  }
  const auth = { currentUser: { uid: 'new' }, async signOut() { calls.push('sign-out'); auth.currentUser = null; } };
  const c = vm.createContext({
    document: { getElementById: id => nodes.get(id) }, firebase: { auth: () => auth },
    UserStore: { user: null },
    applyServiceAuthState(user) { c.UserStore.user = user; calls.push(['service-user', user?.uid || null]); },
    getAppModal: node => ({ open() { calls.push(['open', node.id]); } }),
    M: { Modal: { getInstance: node => ({ options: node.options, close() {
      calls.push(['close', node.id]); if (node.id === 'signup-modal') c.cancelServiceRegistration();
    } }) } },
    callApi: (...args) => { calls.push(['api', ...args]); return api(...args); },
    showToast: message => calls.push(['toast', message]),
  });
  vm.runInContext('let authStateRevision = 0, pendingRegistrationUser = null, pendingConsentVersions = null, registrationSaving = false;', c);
  for (const name of ['handleFirebaseAuthState', 'toggleRegistrationButton', 'setRegistrationSaving', 'completeServiceRegistration', 'cancelServiceRegistration']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /);
    vm.runInContext(rest.slice(0, end + 1), c);
  }
  return { c, nodes, calls, auth };
}
const newStatus = { success: true, registered: false, consentVersions: { terms: 'terms-version', privacy: 'privacy-version' } };
function agree(f) {
  f.nodes.get('terms-agree-cb').checked = f.nodes.get('privacy-agree-cb').checked = true;
  f.c.toggleRegistrationButton();
}
test('기존 회원은 신규 동의창 없이 서비스 로그인 상태로 전환한다', async () => {
  const f = fixture(async () => ({ success: true, registered: true }));
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user.uid, 'new');
  assert.equal(f.calls.some(call => call[0] === 'open'), false);
});
test('신규 회원은 서비스 로그인 전 동의창을 열며 취소하면 가입 호출 없이 로그아웃한다', async () => {
  const f = fixture(async () => newStatus);
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user, null);
  assert.ok(f.calls.some(call => call[0] === 'open' && call[1] === 'signup-modal'));
  assert.equal(f.nodes.get('signup-complete-btn').disabled, true);
  f.c.cancelServiceRegistration(); await Promise.resolve();
  assert.ok(f.calls.includes('sign-out'));
  assert.equal(f.calls.filter(call => call[0] === 'api').length, 1);
});
test('가입 성공 이후에만 로그인 상태를 열고 동의·버전을 서버에 보낸다', async () => {
  const f = fixture(async name => name === 'getRegistrationStatus' ? newStatus : { success: true, registered: true });
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f);
  await f.c.completeServiceRegistration();
  assert.equal(f.c.UserStore.user.uid, 'new');
  const request = f.calls.find(call => call[1] === 'completeRegistration');
  assert.equal(request[3].agreements.terms, true); assert.equal(request[3].agreements.privacy, true);
  assert.equal(request[3].consentVersions.terms, 'terms-version');
  assert.equal(f.calls.includes('sign-out'), false);
});
test('저장 중 중복 가입·닫기를 차단하고 실패 후 재시도를 허용한다', async () => {
  let reject;
  const f = fixture(name => name === 'getRegistrationStatus' ? Promise.resolve(newStatus) : new Promise((_, no) => { reject = no; }));
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f);
  const saving = f.c.completeServiceRegistration();
  assert.equal(f.nodes.get('signup-modal').options.dismissible, false);
  await f.c.completeServiceRegistration(); f.c.cancelServiceRegistration();
  assert.equal(f.calls.filter(call => call[1] === 'completeRegistration').length, 1);
  assert.equal(f.calls.includes('sign-out'), false);
  reject(Error('fixture')); await saving;
  assert.equal(f.c.UserStore.user, null);
  assert.equal(f.nodes.get('signup-complete-btn').disabled, false);
  assert.equal(f.nodes.get('signup-modal').options.dismissible, true);
});
test('문서 버전이 변경되면 최신 버전을 조회하고 두 동의를 다시 요구한다', async () => {
  const f = fixture(async name => {
    if (name === 'getRegistrationStatus') return newStatus;
    throw Object.assign(Error('changed'), { code: 'CONSENT_VERSION_CHANGED' });
  });
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f); await f.c.completeServiceRegistration();
  assert.equal(f.nodes.get('terms-agree-cb').checked, false);
  assert.equal(f.nodes.get('privacy-agree-cb').checked, false);
  assert.equal(f.nodes.get('signup-complete-btn').disabled, true);
});
test('늦게 도착한 이전 계정 조회는 로그아웃 후 동의창을 다시 열지 않는다', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.auth.currentUser = null; await f.c.handleFirebaseAuthState(null);
  finish(newStatus); await pending;
  assert.equal(f.calls.some(call => call[0] === 'open'), false);
  assert.equal(f.c.UserStore.user, null);
});
test('가입 상태 조회 실패는 기존 회원으로 간주하거나 가입 데이터를 만들지 않는다', async () => {
  const f = fixture(async () => { throw Error('unavailable'); });
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user, null); assert.ok(f.calls.includes('sign-out'));
});

test('공통 Escape 처리는 가입 저장 중 dismissible=false를 존중하고 완료 후 닫기를 허용한다', () => {
  let dismissible = false, closed = 0;
  const top = { classList: { contains: name => ['modal', 'ui-overlay'].includes(name) } };
  const c = vm.createContext({
    modalStates: new Map([[top, { closing: false }]]), sheetAnimationStates: new Map(),
    document: { querySelector: () => null, addEventListener() {} },
    M: { Modal: { getInstance: () => ({ options: { dismissible }, close() { closed++; } }) } },
  });
  const start = source.indexOf('function handleManagedSheetKeydown(');
  const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(rest.slice(0, end + 1), c);
  const event = { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} };
  c.handleManagedSheetKeydown(event); assert.equal(closed, 0);
  dismissible = true; c.handleManagedSheetKeydown(event); assert.equal(closed, 1);
});
