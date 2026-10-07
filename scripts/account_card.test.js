const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} is missing`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

function setup(extra = {}) {
  const elements = Object.fromEntries([
    'nickname', 'joined', 'membership', 'nickname-display', 'nickname-edit',
    'nickname-input', 'nickname-edit-button',
  ].map(role => [role, { textContent: '', value: '', hidden: false, focus() { this.focused = true; } }]));
  const classes = new Set();
  const card = {
    classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
    querySelector(selector) { return elements[selector.match(/data-account="([^"]+)"/)[1]]; },
  };
  const ctx = vm.createContext({
    document: { querySelector: () => card },
    UserStore: { user: { uid: 'account-uid' }, settings: {} },
    showToast() {}, loadUserData() {}, console,
    ...extra,
  });
  for (const name of ['getAccountCardElement', 'renderMembershipSettings', 'updateUserInfoCard',
    'toggleNicknameEdit', 'confirmNicknameEdit', 'updateNickname', 'syncYoutubeMembership']) {
    vm.runInContext(functionSource(name), ctx);
  }
  return { ctx, elements, classes };
}

test('membership updates replace the previous account label and premium border', () => {
  const { ctx, elements, classes } = setup();
  for (const [membership, expected, premium] of [
    [{ status: 'active', levelName: '대원' }, '대원', true],
    [{ status: 'active', levelName: '관리자' }, '관리자', true],
    [{ status: 'active', levelName: '소유자' }, '관리자', true],
    [{ status: 'expired', levelName: '대원' }, '일반', false],
    [{ status: 'active', levelName: '디스코드 멤버십 회원' }, '유튜브 멤버십', true],
    [{ status: 'active' }, '유튜브 멤버십', true],
    [null, '일반', false],
  ]) {
    ctx.renderMembershipSettings(membership);
    assert.equal(elements.membership.textContent, expected);
    assert.equal(classes.has('border-theme'), premium);
  }
});

test('new account data does not retain the previous joined date or nickname', () => {
  const { ctx, elements } = setup();
  ctx.updateUserInfoCard({ uid: 'one' }, { Nickname: '첫 사용자', createdAt: '2020-01-02T03:04:00' });
  assert.match(elements.joined.textContent, /2020-01-02/);
  ctx.updateUserInfoCard({ uid: 'two' }, {});
  assert.equal(elements.nickname.textContent, 'two');
  assert.equal(elements.joined.textContent, '가입일: -');
  ctx.updateUserInfoCard({ uid: 'two' }, { createdAt: 'invalid' });
  assert.equal(elements.joined.textContent, '가입일: -');
});

test('nickname edit opens the input and cancel returns focus without changing the name', () => {
  const { ctx, elements } = setup();
  elements.nickname.textContent = '기존 이름';
  ctx.toggleNicknameEdit(true);
  assert.equal(elements['nickname-display'].hidden, true);
  assert.equal(elements['nickname-edit'].hidden, false);
  assert.equal(elements['nickname-input'].placeholder, '기존 이름');
  assert.equal(elements['nickname-input'].focused, true);
  elements['nickname-input'].value = '수정 중';
  ctx.toggleNicknameEdit(false);
  assert.equal(elements.nickname.textContent, '기존 이름');
  assert.equal(elements['nickname-edit'].hidden, true);
  assert.equal(elements['nickname-edit-button'].focused, true);
});

test('blank and unchanged nickname submissions close without an API call', () => {
  const { ctx, elements } = setup({ callApi() { assert.fail('unexpected save'); } });
  elements.nickname.textContent = '기존 이름';
  for (const value of ['', '   ', ' 기존 이름 ']) {
    ctx.toggleNicknameEdit(true);
    elements['nickname-input'].value = value;
    ctx.confirmNicknameEdit();
    assert.equal(elements['nickname-edit'].hidden, true);
  }
});

test('nickname save uses the existing API and returns focus only after success', async () => {
  const calls = [];
  let reloads = 0;
  const { ctx, elements } = setup({
    callApi(...args) { calls.push(args); return { success: true }; },
    loadUserData() { reloads++; },
  });
  ctx.toggleNicknameEdit(true);
  await ctx.updateNickname('새 이름');
  assert.equal(calls[0][0], 'updateNickname');
  assert.equal(calls[0][2].nickname, '새 이름');
  assert.equal(reloads, 1);
  assert.equal(elements['nickname-edit'].hidden, true);
  assert.equal(elements['nickname-edit-button'].focused, true);
});

test('failed nickname save retains the entered value and editing state', async () => {
  const messages = [];
  const { ctx, elements } = setup({
    callApi() { return { success: false, message: '저장 실패' }; },
    showToast(message) { messages.push(message); },
    loadUserData() { assert.fail('unexpected reload'); },
  });
  ctx.toggleNicknameEdit(true);
  elements['nickname-input'].value = '수정 중';
  await ctx.updateNickname('수정 중');
  assert.equal(elements['nickname-edit'].hidden, false);
  assert.equal(elements['nickname-input'].value, '수정 중');
  assert.equal(messages[0], '저장 실패');
});

test('membership check enters settings before opening authentication and guards signed-out users', async () => {
  const actions = [];
  const { ctx } = setup({
    switchToMode(mode) { actions.push(['route', mode]); },
    openMembershipAuthModal(source) { actions.push(['modal', source]); },
  });
  await ctx.syncYoutubeMembership();
  assert.deepEqual(actions, [['route', 'settings'], ['modal', 'header']]);
  actions.length = 0;
  await ctx.syncYoutubeMembership('settings');
  assert.deepEqual(actions, [['route', 'settings'], ['modal', 'settings']]);
  actions.length = 0;
  ctx.UserStore.user = null;
  await ctx.syncYoutubeMembership();
  assert.deepEqual(actions, []);
});
