const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function load(name, context) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(end < 0 ? rest : rest.slice(0, end + 1), context);
}
function fixture(extra = {}) {
  const nodes = new Map(), calls = [];
  for (const id of ['badge-discord-linked', 'badge-youtube-linked',
    'membership-auth-modal', 'membership-hide-footer', 'membership-hide-guide', 'never-show-membership-verify',
    'terms-agree-cb', 'privacy-agree-cb', 'signup-complete-btn', 'google-login-btn', 'twitter-login-btn']) {
    const classes = new Set();
    nodes.set(id, { id, hidden: false, disabled: false, checked: false, textContent: '', classes,
      classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
      style: new Proxy({}, { set() { assert.fail('상태 변화는 인라인 스타일을 생성하지 않는다'); } }),
    });
  }
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id) || null },
    UserStore: { user: { uid: 'fixture-user' }, settings: {} },
    getAppModal: () => ({ open() { calls.push('open'); } }),
    M: { Modal: { getInstance: () => ({ close() { calls.push('close'); } }) } },
    saveUserSetting: async (...args) => calls.push(args),
    syncMembershipHeader: eligible => calls.push(['header', eligible]),
    showToast: message => calls.push(['toast', message]),
    ...extra,
  });
  vm.runInContext('let membershipHideClickCount = 0; let loginInProgress = false; let pendingServiceAuthUser = null; let registrationCheckPending = false; let serviceLoginPending = false; let pendingRegistrationUser = {uid: "test"}; let registrationSaving = false;', context);
  for (const name of ['toggleLoginBtn', 'toggleRegistrationButton', 'signInWithProvider', 'resetMembershipVerifyModal',
    'handleNeverShowMembership', 'openMembershipAuthModal']) load(name, context);
  return { context, nodes, calls };
}
test('신규 가입 확인은 두 문서 동의를 요구하며 SNS 버튼은 동의와 무관하다', () => {
  const { context, nodes } = fixture();
  for (const [terms, privacy] of [[false, false], [true, false], [false, true], [true, true], [false, true]]) {
    nodes.get('terms-agree-cb').checked = terms;
    nodes.get('privacy-agree-cb').checked = privacy;
    context.toggleRegistrationButton();
    assert.equal(nodes.get('signup-complete-btn').disabled, !(terms && privacy));
    context.toggleLoginBtn();
    for (const id of ['google-login-btn', 'twitter-login-btn']) {
      assert.equal(nodes.get(id).disabled, false);
    }
  }
});
test('비활성 로그인 버튼은 외부 인증을 실행하지 않는다', async () => {
  const { context, nodes } = fixture({ getProviderInstance() { assert.fail('외부 공급자 조회 금지'); } });
  for (const [name, id] of [['google', 'google-login-btn'], ['twitter', 'twitter-login-btn']]) {
    nodes.get(id).disabled = true;
    await context.signInWithProvider(name);
  }
});
test('현재 상태 칩 없이도 멤버십 상태 변경에 따라 수단별 연동 배지를 갱신한다', () => {
  const { context, nodes } = fixture();
  for (const [status, type] of [['active', 'discord'], ['active', 'csv'], ['expired', 'csv']]) {
    context.UserStore.sourceMembership = { status, type };
    context.openMembershipAuthModal();
    assert.equal(nodes.get('badge-discord-linked').hidden, !(status === 'active' && type === 'discord'));
    assert.equal(nodes.get('badge-youtube-linked').hidden, !(status === 'active' && type === 'csv'));
  }
});
test('숨기기 첫 확인 후 재열기하면 안내와 단계가 초기화되고 저장하지 않는다', async () => {
  const { context, nodes, calls } = fixture();
  context.openMembershipAuthModal();
  await context.handleNeverShowMembership();
  assert.equal(nodes.get('membership-hide-guide').hidden, false);
  context.openMembershipAuthModal();
  assert.equal(nodes.get('membership-hide-guide').hidden, true);
  assert.equal(nodes.get('never-show-membership-verify').textContent, '다시 표시하지 않음');
  await context.handleNeverShowMembership();
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'hideMembershipVerify'), false);
});
test('숨기기는 두 번째 확인에만 저장하고 저장 중 중복 실행을 막는다', async () => {
  let complete, saves = 0;
  const { context, nodes, calls } = fixture({ saveUserSetting: () => {
    saves++;
    return new Promise(resolve => { complete = resolve; });
  } });
  await context.handleNeverShowMembership();
  assert.equal(saves, 0);
  const pending = context.handleNeverShowMembership();
  assert.equal(nodes.get('never-show-membership-verify').disabled, true);
  await context.handleNeverShowMembership();
  assert.equal(saves, 1);
  complete();
  await pending;
  assert.ok(calls.includes('close'));
  assert.equal(nodes.get('membership-hide-guide').hidden, true);
  assert.equal(nodes.get('never-show-membership-verify').disabled, false);
});
test('숨기기 저장 실패는 안내를 유지하고 재시도를 허용한다', async () => {
  const { context, nodes, calls } = fixture({ saveUserSetting: async () => { throw new Error('fixture'); } });
  await context.handleNeverShowMembership();
  await context.handleNeverShowMembership();
  assert.equal(nodes.get('membership-hide-guide').hidden, false);
  assert.equal(nodes.get('never-show-membership-verify').disabled, false);
  assert.equal(calls.includes('close'), false);
});

test('설정 진입은 숨기기 조작을 숨기며 헤더 재진입은 첫 단계로 복원한다', async () => {
  const { context, nodes, calls } = fixture();
  context.openMembershipAuthModal();
  await context.handleNeverShowMembership();
  context.openMembershipAuthModal('settings');
  assert.equal(nodes.get('never-show-membership-verify').hidden, true);
  assert.equal(nodes.get('membership-hide-footer').hidden, true);
  assert.equal(nodes.get('membership-hide-guide').hidden, true);
  await context.handleNeverShowMembership();
  assert.equal(nodes.get('membership-hide-guide').hidden, true);
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'hideMembershipVerify'), false);
  context.openMembershipAuthModal('header');
  assert.equal(nodes.get('never-show-membership-verify').hidden, false);
  assert.equal(nodes.get('membership-hide-footer').hidden, false);
  assert.equal(nodes.get('never-show-membership-verify').textContent, '다시 표시하지 않음');
});
