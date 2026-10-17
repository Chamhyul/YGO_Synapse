'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
function extract(begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, begin); return source.slice(start, finish);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = { status: 'active', type: 'discord', levelName: '유튜브 멤버십' };
const result = (status = 'synced') => ({ success: true, uid: 'synthetic-a', settings: { membership: member },
  sourceMembership: member, membership: member, isMemberActive: true,
  membershipClaims: { status, version: 'version-current' } });

function harness({ response = result(), tokenVersion = 'version-current', readFailure = false, refreshFailure = false,
  readGate, refreshGate, apiGate, mode = 'refresh' } = {}) {
  const events = [], forced = [], applied = [], toasts = [];
  let reads = 0, reloads = 0;
  const user = { uid: 'synthetic-a', async getIdTokenResult() {
    reads++; events.push('token-read'); if (readGate) await readGate.promise;
    if (readFailure) throw new Error('synthetic-private-token-error');
    return { claims: tokenVersion === undefined ? {} : { ygoMembership: { version: tokenVersion } } };
  }, async getIdToken(force) {
    forced.push(force); events.push('token-refresh'); if (refreshGate) await refreshGate.promise;
    if (refreshFailure) throw new Error('synthetic-private-token-error'); return 'synthetic-refreshed-token';
  } };
  let currentUser = user;
  const session = new Map([['discord_membership_verification', JSON.stringify({ uid: user.uid, state: 'a'.repeat(64), expiresAt: Date.now() + 300000 })]]);
  const ctx = { UserStore: { user, settings: {} }, authStateRevision: 5, UIStore: {},
    firebase: { auth: () => ({ currentUser }) },
    callApi: async name => {
      events.push(name);
      if (name === 'startYoutubeMembershipVerification') return { success: true, uid: user.uid, verificationId: 'synthetic-challenge' };
      if (apiGate) await apiGate.promise; return response;
    },
    applyMembershipStatus(value) { events.push('apply'); applied.push(value); }, showToast(message) { toasts.push(message); },
    showLoading() {}, updateAuthUI() {}, updateUserInfoCard() {}, applyUserData() {}, loadUserTheme() {},
    checkAndHideInitialLoading() {}, console: { error() {} }, getYoutubeAccessTokenViaSecondaryApp: async () => 'synthetic-oauth-token',
    M: { Modal: { getInstance: () => ({ close() {} }) } }, document: { title: '시험', getElementById: () => ({}) },
    resetMembershipVerifyModal() {}, waitForDiscordServiceUser: async () => user,
    URL, URLSearchParams, Date, location: { search: '?code=synthetic-oauth-code&state=' + 'a'.repeat(64),
      href: 'http://localhost:5005/?code=synthetic-oauth-code&state=' + 'a'.repeat(64) },
    sessionStorage: { getItem: key => session.get(key), removeItem: key => session.delete(key) },
    window: { history: { replaceState() {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function refreshMembershipClaims(', 'async function loadUserData()'), ctx);
  if (mode === 'load') vm.runInContext(extract('async function loadUserData()', 'function applyMembershipStatus('), ctx);
  else {
    ctx.loadUserData = async () => { reloads++; events.push('reload'); };
    if (mode === 'youtube') vm.runInContext(extract('let youtubeMembershipVerificationPending = false;', '/**'), ctx);
    if (mode === 'discord') vm.runInContext(extract('async function handleDiscordOAuthCallback()', '/**'), ctx);
  }
  return { ctx, user, events, forced, applied, toasts, reads: () => reads, reloads: () => reloads,
    run: () => mode === 'load' ? ctx.loadUserData() : mode === 'youtube' ? ctx.startYoutubeMembershipVerify()
      : mode === 'discord' ? ctx.handleDiscordOAuthCallback() : ctx.refreshMembershipClaims(user, response),
    changeAccount(uid = user.uid) { ctx.authStateRevision++; ctx.UserStore.user = { ...user, uid }; currentUser = ctx.UserStore.user; },
    changeFirebaseAccount(uid) { currentUser = { uid }; },
  };
}

test('서버와 토큰의 멤버십 버전이 같으면 강제 갱신 없이 현재 계정을 확인한다', async () => {
  const f = harness(); assert.equal(await f.run(), true); assert.equal(f.reads(), 1); assert.deepEqual(f.forced, []);
});

test('토큰의 멤버십 버전이 다르면 ID 토큰을 한 번 강제로 갱신한다', async () => {
  const f = harness({ tokenVersion: 'version-old' }); assert.equal(await f.run(), true);
  assert.equal(f.reads(), 1); assert.deepEqual(f.forced, [true]);
});

test('서버 claims가 pending이거나 구버전 응답이면 토큰을 읽거나 갱신하지 않는다', async () => {
  for (const response of [result('pending'), { success: true }, { membershipClaims: { status: 'synced' } }]) {
    const f = harness({ response }); assert.equal(await f.run(), false); assert.equal(f.reads(), 0); assert.deepEqual(f.forced, []);
  }
});

test('토큰 조회·강제 갱신 실패는 원문을 노출하지 않고 false로 끝낸다', async () => {
  for (const options of [{ readFailure: true }, { tokenVersion: 'old', refreshFailure: true }]) {
    const f = harness(options); assert.equal(await f.run(), false); assert.deepEqual(f.toasts, []);
  }
});

test('토큰 조회 대기 중 같은 UID 재로그인은 이전 Auth revision의 갱신을 중단한다', async () => {
  const gate = deferred(), f = harness({ tokenVersion: 'old', readGate: gate });
  const running = f.run(); assert.equal(f.reads(), 1); f.changeAccount(); gate.resolve();
  assert.equal(await running, false); assert.deepEqual(f.forced, []);
});

test('토큰 강제 갱신 대기 중 계정이 바뀌면 완료를 현재 계정 성공으로 처리하지 않는다', async () => {
  const gate = deferred(), f = harness({ tokenVersion: 'old', refreshGate: gate });
  const running = f.run(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.forced, [true]); f.changeAccount('synthetic-b'); gate.resolve(); assert.equal(await running, false);
});

test('Firebase 실제 계정과 UserStore 계정이 다르면 토큰에 접근하지 않는다', async () => {
  const f = harness(); f.changeFirebaseAccount('synthetic-b'); assert.equal(await f.run(), false); assert.equal(f.reads(), 0);
});

test('사용자 조회는 토큰 갱신 후에도 API 멤버십을 화면의 기준으로 사용한다', async () => {
  const f = harness({ mode: 'load', tokenVersion: 'old' }); await f.run();
  assert.deepEqual(f.forced, [true]); assert.deepEqual(f.applied, [member]);
  assert.ok(f.events.indexOf('token-refresh') < f.events.indexOf('apply'));
  assert.equal(f.ctx.UserStore.isUserDataSyncDone, true);
});

test('사용자 조회에서 claims pending·토큰 오류는 확정된 API 회원 표시를 버리지 않는다', async () => {
  for (const options of [{ response: result('pending') }, { readFailure: true }, { tokenVersion: 'old', refreshFailure: true }]) {
    const f = harness({ ...options, mode: 'load' }); await f.run(); assert.deepEqual(f.applied, [member]);
    assert.equal(f.ctx.UserStore.sourceMembership, member); assert.deepEqual(f.toasts, []);
  }
});

test('사용자 API 응답 대기 중 같은 UID의 Auth revision이 바뀌면 이전 화면 갱신을 버린다', async () => {
  const gate = deferred(), f = harness({ mode: 'load', apiGate: gate });
  const running = f.run(); f.changeAccount(); gate.resolve(); await running;
  assert.equal(f.applied.length, 0); assert.equal(f.reads(), 0); assert.equal(f.ctx.UserStore.isUserDataSyncDone, false);
});

test('사용자 조회의 토큰 갱신 대기 중 같은 UID 재로그인은 이전 응답을 적용하지 않는다', async () => {
  const gate = deferred(), f = harness({ mode: 'load', tokenVersion: 'old', readGate: gate });
  const running = f.run(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.reads(), 1);
  f.changeAccount(); gate.resolve(); await running;
  assert.equal(f.applied.length, 0); assert.deepEqual(f.forced, []); assert.equal(f.ctx.UserStore.isUserDataSyncDone, false);
});

for (const mode of ['youtube', 'discord']) {
  test(`${mode} 검증 성공은 claims 갱신 뒤 API 결과를 표시하고 사용자 데이터를 다시 조회한다`, async () => {
    const f = harness({ mode, tokenVersion: 'old' }); await f.run();
    assert.deepEqual(f.forced, [true]); assert.deepEqual(f.applied, [member]); assert.equal(f.reloads(), 1);
    assert.ok(f.events.indexOf('token-refresh') < f.events.indexOf('apply'));
    assert.ok(f.events.indexOf('apply') < f.events.indexOf('reload'));
  });

  test(`${mode} 검증의 claims pending·토큰 장애에서도 API 결과를 보존하고 재조회한다`, async () => {
    for (const options of [{ response: result('pending') }, { readFailure: true }, { tokenVersion: 'old', refreshFailure: true }]) {
      const f = harness({ ...options, mode }); await f.run(); assert.deepEqual(f.applied, [member]); assert.equal(f.reloads(), 1);
      assert.ok(f.toasts.every(message => !message.includes('synthetic-private')));
    }
  });

  test(`${mode} 성공 후 토큰 조회 대기 중 Auth revision이 바뀌면 표시·후속 조회를 중단한다`, async () => {
    const gate = deferred(), f = harness({ mode, tokenVersion: 'old', readGate: gate });
    const running = f.run(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.reads(), 1);
    f.changeAccount(); gate.resolve(); await running;
    assert.deepEqual(f.forced, []); assert.equal(f.applied.length, 0); assert.equal(f.reloads(), 0);
  });
}
