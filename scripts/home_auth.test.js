const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const authStart = source.indexOf('function applyServiceAuthState(user) {');
const authEnd = source.indexOf('\nlet currentNoticeIndex', authStart);
assert.ok(authStart >= 0 && authEnd > authStart, '인증 콜백을 찾을 수 있어야 한다');

function fixture({ mobile = false, withHome = true } = {}) {
  const nodes = new Map();
  const calls = [];
  const ownedSection = { id: 'owned-section' };
  for (const id of ['auth-nav-btn', 'auth-icon', 'auth-text', 'auth-modal', 'mobile-auth-modal']) {
    nodes.set(id, { id, dataset: {} });
  }
  if (withHome) {
    for (const [id, hidden] of [['home-unauth-content', false], ['home-auth-content', true]]) {
      nodes.set(id, {
        id, hidden,
        style: new Proxy({}, { set() { throw new Error('홈 표시 상태에 인라인 스타일을 사용하지 않는다'); } }),
      });
    }
  }
  let notifyAuth;
  const context = vm.createContext({
    firebase: { auth: () => ({ onAuthStateChanged(callback) { notifyAuth = callback; } }) },
    window: {},
    document: {
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: selector => selector === '.target-inventory-section' ? [ownedSection] : [],
      documentElement: { classList: { contains: name => mobile && name === 'is-mobile-device' } },
    },
    UserStore: { user: null, settings: {}, isUserDataSyncDone: false },
    cardCacheInstance: { clearAll() {} }, clearTimeout() {}, inventoryMigrationTimer: null,
    UIStore: { mode: 'inventory', inventoryMode: 'list' },
    AutoLogoutManager: {
      start: () => calls.push(['auto-logout', 'start']),
      stop: () => calls.push(['auto-logout', 'stop']),
    },
    M: { Modal: { getInstance: node => ({ close: () => calls.push(['modal-close', node.id]) }) } },
    loadUserData: () => calls.push(['load-user-data']),
    loadUserTheme: (...args) => calls.push(['load-user-theme', ...args]),
    checkAndHideInitialLoading: () => calls.push(['check-loading']),
    updateProviderUI: (...args) => calls.push(['provider', ...args]),
    renderInventoryGrid: () => calls.push(['inventory-grid']),
    renderLinkedAccounts: user => calls.push(['linked-accounts', user]),
    renderOwnedCardsToContainer: (rows, section) => calls.push(['owned-clear', rows.length, section.id]),
    handleTooltipDisplay: () => calls.push(['tooltip']),
  });
  vm.runInContext(source.slice(authStart, authEnd), context);
  return { context, nodes, calls, notifyAuth: context.applyServiceAuthState };
}

test('인증 복원과 로그아웃에서 홈 표시를 전환하고 기존 데이터·모달 처리를 유지한다', () => {
  for (const mobile of [false, true]) {
    const { context, nodes, calls, notifyAuth } = fixture({ mobile });
    const unauth = nodes.get('home-unauth-content');
    const auth = nodes.get('home-auth-content');
    const user = { uid: 'restored-user' };

    notifyAuth(user);
    assert.equal(context.window.isAuthInitialized, true);
    assert.equal(context.UserStore.user, user);
    assert.ok(calls.some(([action, settings, wait]) => action === 'load-user-theme' && settings === undefined && wait === true));
    assert.equal(unauth.hidden, true);
    assert.equal(auth.hidden, false);
    assert.ok(calls.some(([action]) => action === 'load-user-data'));
    assert.ok(calls.some(([action, count]) => action === 'owned-clear' && count === 0));
    assert.ok(calls.some(([action, id]) => action === 'modal-close'
      && id === 'auth-modal'));

    calls.length = 0;
    notifyAuth(null);
    assert.equal(context.UserStore.user, null);
    assert.ok(calls.some(([action]) => action === 'load-user-theme'));
    assert.equal(context.UserStore.isUserDataSyncDone, true);
    assert.equal(unauth.hidden, false);
    assert.equal(auth.hidden, true);
    assert.deepEqual(calls.filter(([action]) => action === 'provider'), [
      ['provider', 'google', false, 0], ['provider', 'twitter', false, 0],
    ]);
    assert.ok(calls.some(([action]) => action === 'inventory-grid'));
    assert.ok(calls.some(([action, value]) => action === 'auto-logout' && value === 'stop'));
    assert.ok(calls.some(([action, value]) => action === 'linked-accounts' && value === null));
    assert.ok(calls.some(([action, count]) => action === 'owned-clear' && count === 0));
    assert.equal(nodes.get('home-auth-content'), auth);
    assert.equal(nodes.get('home-unauth-content'), unauth);
  }
});

test('홈 영역이 없어도 인증 처리는 계속된다', () => {
  const { notifyAuth, context } = fixture({ withHome: false });
  assert.doesNotThrow(() => notifyAuth({ uid: 'user' }));
  assert.doesNotThrow(() => notifyAuth(null));
  assert.equal(context.window.isAuthInitialized, true);
});

test('홈 수량 갱신은 현행 통계 경로로 보유 수량·종류와 보유 현황을 함께 갱신한다', () => {
  const start = source.indexOf('function updateTotals() {');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  const total = { innerText: '' };
  const kind = { innerText: '' };
  let dashboardUpdates = 0;
  const context = vm.createContext({
    cardCacheInstance: { getAmount: () => 12, getOwnedNumbers: () => ['a', 'b', 'c'] },
    document: { getElementById: id => ({ 'total-cards': total, 'kind-cards': kind })[id] || null },
    updateDashboardStats: () => { dashboardUpdates++; },
  });
  vm.runInContext(source.slice(start, end), context);
  context.updateTotals();
  assert.equal(total.innerText, 12);
  assert.equal(kind.innerText, 3);
  assert.equal(dashboardUpdates, 1);
});

function loadAuthFunction(name, context) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}

test('로그인된 사용자의 계정 진입은 모달 조회 없이 환경설정으로 이동한다', () => {
  for (const mobile of [false, true]) {
    const routes = [];
    const context = vm.createContext({
      UserStore: { user: { uid: 'fixture-user' } },
      switchToMode: mode => routes.push(mode),
      document: {
        documentElement: { classList: { contains: () => mobile } },
        getElementById() { assert.fail('로그인 후에는 로그인창을 조회하지 않는다'); },
      },
      getAppModal() { assert.fail('로그인 후에는 로그인창을 열지 않는다'); },
    });
    loadAuthFunction('toggleAuthModal', context);
    context.toggleAuthModal();
    context.toggleAuthModal(true);
    assert.deepEqual(routes, ['settings', 'settings']);
  }
});

test('비로그인 진입은 동의 없이 로그인 수단을 선택한다', () => {
  for (const mobile of [false, true]) {
    const nodes = new Map();
    const opened = [];
    const context = vm.createContext({
      UserStore: { user: null }, loginInProgress: false, pendingRegistrationUser: null,
      switchToMode() { assert.fail('비로그인 진입으로 페이지를 이동하지 않는다'); },
      document: {
        documentElement: { classList: { contains: () => mobile } },
        getElementById(id) {
          if (!nodes.has(id)) nodes.set(id, {
            id, checked: true, style: {}, classes: new Set(),
            classList: { add(name) { nodes.get(id).classes.add(name); } },
          });
          return nodes.get(id);
        },
      },
      getAppModal: node => ({ open() { opened.push(node.id); } }),
    });
    loadAuthFunction('toggleLoginBtn', context);
    loadAuthFunction('toggleAuthModal', context);
    const prefix = '';
    context.toggleAuthModal(true);
    assert.equal(opened[0], 'auth-modal');
    assert.equal(nodes.get(`${prefix}google-login-btn`).disabled, false);
    assert.equal(nodes.get(`${prefix}twitter-login-btn`).disabled, false);
    assert.equal(nodes.get(`${prefix}login-guide-msg`).hidden, false);
    context.toggleAuthModal();
    assert.equal(nodes.get(`${prefix}login-guide-msg`).hidden, true);
    assert.equal(nodes.get('login-sub-msg').hidden, false);
  }
});

test('내 계정 이름·접근성 이름과 환경설정의 공급자 연결 상태를 함께 갱신한다', () => {
  for (const mobile of [false, true]) {
    const classes = new Set();
    const label = {}, icon = {}, verify = { dataset: {} };
    const capsule = {
      querySelector: () => icon,
      setAttribute(name, value) { this[name] = value; },
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      },
    };
    const providers = [];
    const context = vm.createContext({
      UserStore: { settings: {} },
      document: {
        documentElement: { classList: { contains: () => mobile } },
        body: { classList: { contains: () => false } },
        querySelector: () => null,
        getElementById: id => ({ 'auth-btn-text': label, 'auth-capsule-btn': capsule,
          'membership-verify-btn': verify })[id] || null,
      },
      getAccountCardElement: () => null,
      updateProviderUI: (...args) => providers.push(args),
    });
    loadAuthFunction('syncMembershipHeader', context);
    loadAuthFunction('renderLinkedAccounts', context);
    context.renderLinkedAccounts({ providerData: [{ providerId: 'google.com' }] });
    assert.equal(label.textContent, '내 계정');
    assert.equal(capsule['aria-label'], '내 계정: 환경설정으로 이동');
    assert.equal(classes.has('is-logged-in'), true);
    assert.equal(verify.hidden, false);
    assert.deepEqual(providers, [['google', true, 1], ['twitter', false, 1]]);
    context.renderLinkedAccounts(null);
    assert.equal(label.textContent, '로그인');
    assert.equal(capsule['aria-label'], '로그인');
    assert.equal(classes.has('is-logged-in'), false);
    assert.equal(verify.hidden, true);
  }
});


function membershipHeaderFixture(mobile = true) {
  const classes = new Set(['is-logged-in']);
  const auth = { width: 34, style: {}, classList: {
    toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
    contains: name => classes.has(name),
  }, setAttribute(name, value) { this[name] = value; }, focus() { document.activeElement = this; } };
  const verify = { width: 110, dataset: {}, hidden: true, style: {} };
  const notice = { width: 30, style: {} };
  const theme = { width: 55, style: { marginLeft: 'auto', marginRight: '4px' } };
  const region = { width: 88, style: {} };
  const header = { width: 440, children: [auth, notice, verify, theme, region], style: {
    paddingLeft: '16px', paddingRight: '16px', columnGap: '8px',
  }, getBoundingClientRect() { return { width: this.width }; } };
  header.children.forEach(node => { node.getBoundingClientRect = () => ({ width: node.hidden ? 0 : node.width }); });
  const document = { activeElement: null, documentElement: { classList: { contains: () => mobile } },
    getElementById: id => ({ 'auth-capsule-btn': auth, 'membership-verify-btn': verify })[id],
    querySelector: () => header };
  const context = vm.createContext({ document, getComputedStyle: node => node.style });
  loadAuthFunction('syncMembershipHeader', context);
  return { context, document, header, auth, verify, region, classes };
}

test('모바일 멤버십 버튼은 헤더 공간이 부족할 때만 점으로 대체하고 넓어지면 복원한다', () => {
  const { context: c, header, verify, classes } = membershipHeaderFixture();
  c.syncMembershipHeader(true);
  assert.equal(verify.hidden, false);
  assert.equal(classes.has('has-noti'), false);
  header.width = 320;
  c.syncMembershipHeader();
  assert.equal(verify.hidden, true);
  assert.equal(classes.has('has-noti'), true);
  header.width = 440;
  c.syncMembershipHeader();
  assert.equal(verify.hidden, false);
  assert.equal(classes.has('has-noti'), false);
});

test('같은 화면 너비에서도 지역 문구·글자 크기가 커지면 겹침을 피하고 초점을 보존한다', () => {
  const { context: c, document, auth, verify, region, classes } = membershipHeaderFixture();
  c.syncMembershipHeader(true);
  document.activeElement = verify;
  region.width = 200;
  c.syncMembershipHeader();
  assert.equal(verify.hidden, true);
  assert.equal(classes.has('has-noti'), true);
  assert.equal(document.activeElement, auth);
  assert.match(auth['aria-label'], /멤버십 인증 필요/);
  region.width = 88;
  c.syncMembershipHeader();
  assert.equal(verify.hidden, false);
  assert.equal(auth['aria-label'], '내 계정: 환경설정으로 이동');
});

test('인증 대상 해제 후 크기를 다시 측정해도 버튼과 안내 점을 되살리지 않는다', () => {
  const { context: c, header, verify, classes } = membershipHeaderFixture();
  header.width = 320;
  c.syncMembershipHeader(true);
  assert.equal(classes.has('has-noti'), true);
  c.syncMembershipHeader(false);
  header.width = 440;
  c.syncMembershipHeader();
  assert.equal(verify.hidden, true);
  assert.equal(classes.has('has-noti'), false);
});

test('데스크톱에서는 공간 부족에 따른 모바일 점 대체를 적용하지 않는다', () => {
  const { context: c, header, verify, classes } = membershipHeaderFixture(false);
  header.width = 200;
  c.syncMembershipHeader(true);
  assert.equal(verify.hidden, false);
  assert.equal(classes.has('has-noti'), false);
});


test('멤버십 상태 갱신은 인증 완료·숨기기 설정·로그아웃 여부를 공통 헤더 처리에 전달한다', () => {
  const calls = [];
  const classes = new Set();
  const context = vm.createContext({
    UserStore: { user: { uid: 'test-user' }, settings: {} },
    document: { body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
      querySelector: () => ({}) },
    syncMembershipHeader: show => calls.push(show), renderMembershipSettings: () => {},
  });
  loadAuthFunction('applyMembershipStatus', context);
  context.applyMembershipStatus({ status: 'active' });
  context.applyMembershipStatus({ status: 'inactive' });
  context.UserStore.settings.hideMembershipVerify = true;
  context.applyMembershipStatus({ status: 'inactive' });
  context.UserStore.settings.hideMembershipVerify = false;
  context.UserStore.user = null;
  context.applyMembershipStatus({ status: 'inactive' });
  assert.deepEqual(calls, [false, true, false, false]);
});


test('겹치지 않아도 추가 여유가 16px 미만이면 점으로 대체하며 자동 여백은 제외한다', () => {
  const { context: c, header, verify, classes } = membershipHeaderFixture();
  // 필수 너비 353px + 헤더 패딩 32px. CSS 자동 여백의 계산값은 남는 공간이다.
  const theme = header.children[3];
  theme.classList = { contains: name => name === 'theme-switch-wrapper' };
  theme.style.marginLeft = '40px';
  header.width = 400; // 필수 배치 뒤 남는 공간 15px
  c.syncMembershipHeader(true);
  assert.equal(verify.hidden, true);
  assert.equal(classes.has('has-noti'), true);
  header.width = 401; // 남는 공간 16px
  c.syncMembershipHeader();
  assert.equal(verify.hidden, false);
  assert.equal(classes.has('has-noti'), false);
});
