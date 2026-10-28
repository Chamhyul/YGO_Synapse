'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, mocks, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, process: { env }, console: { error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (['../services/inventoryRequestTiming', '../services/initialWriterRoute',
        '../services/requestAccount', '../services/membershipPolicy'].includes(name)) return require(name);
      throw Error('격리되지 않은 의존성: ' + name);
    },
  });
  return module.exports;
}
function gate() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function fixture({ tokenError, appCheck = true, local = false, registered = true, prefetch } = {}) {
  const account = gate(), profile = gate(), full = gate();
  const events = [], calls = { account: 0, profile: 0, plain: 0, full: 0, summary: 0, writes: 0 };
  const snapshot = { exists: true, value: { Nickname: 'synthetic' } };
  const currentAccount = { uid: 'verified-user', disabled: false, customClaims: { role: 'admin' } };
  const auth = {
    async verifyIdToken() {
      events.push('signature');
      if (tokenError) throw Object.assign(Error('synthetic-private'), { code: tokenError });
      return { uid: 'verified-user', auth_time: 1 };
    },
    getUser(uid) { calls.account++; events.push('account'); assert.equal(uid, 'verified-user'); return account.promise; },
  };
  const env = local ? { FIRESTORE_EMULATOR_HOST: 'synthetic:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'synthetic:9199' } : {};
  if (prefetch) Object.assign(env, { USER_STORAGE_MODE: 'production', USER_STORAGE_BACKEND: 'rtdb' });
  const helpers = load('utils/auth.js', {
    '../config/firebase': { admin: { auth: () => auth } },
    './safeError': { safeErrorSummary: () => ({ type: 'internal_error' }) },
    '../services/publicReadTransport': { isLocal: () => local,
      requestProduction: async () => { events.push('remote-auth'); return { uid: 'verified-user', accountRoleVersion: 1, accountRole: 'admin' }; } },
  }, env);
  const routes = load('routes/registration.js', {
    'firebase-functions/v2/https': { onRequest: (_, handler) => handler },
    '../utils/auth': { ...helpers, verifyAppCheck: async (_, res) => {
      events.push('app-check');
      if (!appCheck) res.status(401).json({ success: false, code: 'APPCHECK_REQUIRED' });
      return appCheck;
    } },
    '../utils/safeError': { safeErrorSummary: () => ({ type: 'internal_error' }) },
    '../config/userProfileWriter': { resolveProfileWriterConfig: () => ({ mode: 'production' }) },
    '../services/userWriterSelection': { selectProductionWriter: () => ({ initialize: async () => ({ backend: 'rtdb' }), transition: {} }) },
    '../services/publicReadTransport': { isLocal: () => local },
    '../services/loginInventoryRead': require('../services/loginInventoryRead'),
    '../utils/inventoryStorage': { readLoginInventory: (...args) => prefetch(...args) },
    '../services/registrationService': {
      readRegistrationProfile(uid) {
        calls.profile++; events.push('profile'); assert.equal(uid, 'verified-user');
        return profile.promise;
      },
      isRegisteredUser(uid) {
        calls.plain++; events.push('plain'); assert.equal(uid, 'verified-user');
        return profile.promise.then(value => value.registered);
      },
      completeUserRegistration() { calls.writes++; throw Error('조회 중 쓰기 금지'); },
    },
    '../services/loginUserData': {
      async readLoginUserData(req, uid, options) {
        calls.full++; events.push('full'); assert.equal(uid, 'verified-user');
        assert.equal(options.initialProfile, snapshot);
        assert.equal(await helpers.getVerifiedAccountRole(req, uid), 'admin');
        if (options.readPreparedInventory) await options.readPreparedInventory();
        return full.promise;
      },
      async readLoginAccountData(_, uid, options) {
        calls.summary++; assert.equal(uid, 'verified-user'); assert.equal(options.initialProfile, snapshot);
        return { success: true, nickname: 'synthetic' };
      },
    },
  }, env);
  const response = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; } });
  function request(query = { includeUserData: 'true' }, extra = {}) {
    const res = response();
    const work = routes.getRegistrationStatus({ method: 'GET', headers: { authorization: 'Bearer synthetic-token' }, query, ...extra }, res);
    return { work, res };
  }
  return { request, calls, events, account, profile, full, currentAccount, snapshot,
    readyProfile() { profile.resolve({ registered, profile: snapshot }); } };
}

for (const first of ['account', 'profile']) test(`${first} 선완료도 두 검사와 기존 전체 본문 완료까지 응답을 기다린다`, async () => {
  const f = fixture(), { work, res } = f.request({ includeUserData: 'true', uid: 'untrusted', initialProfile: 'untrusted' });
  await flush();
  assert.deepEqual(f.events.slice(0, 4), ['app-check', 'signature', 'account', 'profile']);
  assert.equal(f.calls.full, 0); assert.equal(res.body, undefined);
  if (first === 'account') f.account.resolve(f.currentAccount); else f.readyProfile();
  await flush(); assert.equal(f.calls.full, 0); assert.equal(res.body, undefined);
  if (first === 'account') f.readyProfile(); else f.account.resolve(f.currentAccount);
  await flush(); assert.equal(f.calls.full, 1); assert.equal(res.body, undefined);
  f.full.resolve({ success: true, allCards: [['synthetic-card']], membershipClaims: { status: 'pending' } });
  await work;
  assert.equal(res.code, 200); assert.equal(res.body.registered, true);
  assert.equal(res.body.initialData.allCards.length, 1);
  assert.equal(res.body.initialData.membershipClaims.status, 'pending');
  assert.equal(f.calls.account, 1); assert.equal(f.calls.profile, 1); assert.equal(f.calls.writes, 0);
});

test('가입 읽기 오류는 계정 검사 완료 뒤 기존 가입 조회503으로 처리한다', async () => {
  const f = fixture(), { work, res } = f.request(); await flush();
  f.profile.reject(Error('synthetic-private')); await flush();
  assert.equal(res.body, undefined);
  f.account.resolve(f.currentAccount); await work;
  assert.equal(res.code, 503); assert.equal(res.body.message, '가입 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
  assert.equal(f.calls.full, 0); assert.equal(f.calls.writes, 0);
});

for (const kind of ['disabled', 'revoked', 'account-error']) test(`${kind}는 병렬 프로필이 있어도 본문·쓰기를 허용하지 않고 읽기를 회수한다`, async () => {
  const f = fixture(), { work, res } = f.request(); await flush();
  if (kind === 'account-error') f.account.reject(Error('synthetic-private'));
  else f.account.resolve({ ...f.currentAccount, disabled: kind === 'disabled',
    ...(kind === 'revoked' ? { tokensValidAfterTime: new Date(2000).toISOString() } : {}) });
  await flush(); assert.equal(f.calls.full, 0);
  let ended = false; work.then(() => { ended = true; }); await flush(); assert.equal(ended, false);
  f.profile.reject(Error('profile-private')); await work;
  assert.equal(res.code, kind === 'account-error' ? 503 : 401);
  assert.equal(res.body.success, false); assert.equal(f.calls.writes, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('토큰·App Check·메서드 거부는 프로필 읽기를 시작하지 않는다', async () => {
  for (const [opts, extra, expected] of [
    [{ tokenError: 'auth/invalid-id-token' }, {}, 401], [{ appCheck: false }, {}, 401],
    [{}, { headers: {} }, 401], [{}, { method: 'POST' }, 405], [{}, { method: 'OPTIONS' }, 204],
  ]) {
    const f = fixture(opts), { work, res } = f.request(undefined, extra); await work;
    assert.equal(res.code, expected); assert.equal(f.calls.profile + f.calls.plain + f.calls.account + f.calls.full, 0);
  }
});

test('미가입은 계정 검사 후 가입 필요만 반환하고 전체 본문을 읽지 않는다', async () => {
  const f = fixture({ registered: false }), { work, res } = f.request(); await flush();
  f.readyProfile(); f.account.resolve(f.currentAccount); await work;
  assert.equal(res.body.registered, false); assert.equal(f.calls.full, 0); assert.equal(f.calls.writes, 0);
});

test('기존 옵션 없는 조회와 선택 계정 요약 계약을 보존한다', async () => {
  for (const query of [{}, { includeAccountData: 'true' }]) {
    const f = fixture(), { work, res } = f.request(query); await flush();
    f.readyProfile(); f.account.resolve(f.currentAccount); await work;
    assert.equal(res.body.registered, true); assert.equal(f.calls.full, 0);
    assert.equal(f.calls.summary, query.includeAccountData ? 1 : 0);
    assert.equal(f.calls.plain, query.includeAccountData ? 0 : 1);
  }
});

test('로컬 고정 운영 인증은 확인된 UID를 받은 뒤 기존 순서로 읽는다', async () => {
  const f = fixture({ local: true }), { work, res } = f.request(); await flush();
  assert.deepEqual(f.events.slice(0, 3), ['app-check', 'remote-auth', 'profile']);
  f.readyProfile(); f.full.resolve({ success: true, allCards: [] }); await work;
  assert.equal(res.code, 200); assert.equal(f.calls.account, 0); assert.equal(f.calls.profile, 1);
});


test('운영 가입 선완료는 인증 중 순수 보유 읽기를 시작하되 계정 확인 뒤에만 소비한다', async () => {
  let entered = false, allowed = false;
  const f = fixture({ prefetch: async (uid, authorize) => {
    assert.equal(uid, 'verified-user'); entered = true;
    allowed = await authorize(); return allowed ? { value: { cards: {} } } : undefined;
  } });
  const { work, res } = f.request(); await flush(); f.readyProfile(); await flush();
  assert(entered); assert.equal(allowed, false); assert.equal(f.calls.full, 0); assert.equal(res.body, undefined);
  f.account.resolve(f.currentAccount); f.full.resolve({ success: true, allCards: [] }); await work;
  assert(allowed); assert.equal(f.calls.full, 1); assert.equal(res.body.initialData.success, true); assert.equal(f.calls.writes, 0);
});
for (const kind of ['disabled', 'revoked', 'account-error']) test(`운영 선행 보유 읽기의 ${kind}는 결과를 폐기하고 작업을 회수한다`, async () => {
  let entered = false, allowed;
  const f = fixture({ prefetch: async (_uid, authorize) => { entered = true; allowed = await authorize(); return { value: { secret: true } }; } });
  const { work, res } = f.request(); await flush(); f.readyProfile(); await flush(); assert(entered);
  if (kind === 'account-error') f.account.reject(Error('synthetic'));
  else f.account.resolve({ ...f.currentAccount, disabled: kind === 'disabled',
    ...(kind === 'revoked' ? { tokensValidAfterTime: new Date(2000).toISOString() } : {}) });
  await work; assert.equal(allowed, false); assert.equal(f.calls.full, 0); assert.equal(res.body.success, false);
  assert.equal(res.code, kind === 'account-error' ? 503 : 401); assert(!JSON.stringify(res.body).includes('secret'));
});
test('운영 선행 읽기 실패는 인증을 실패시키지 않고 기존 본문 조회로 복귀한다', async () => {
  const f = fixture({ prefetch: async () => { throw Error('synthetic'); } });
  const { work, res } = f.request(); await flush(); f.readyProfile(); await flush();
  f.account.resolve(f.currentAccount); f.full.resolve({ success: true, allCards: [] }); await work;
  assert.equal(res.code, 200); assert.equal(f.calls.full, 1);
});
test('미가입·요약·로컬은 선행 보유 읽기를 실행하지 않는다', async () => {
  for (const options of [{ registered: false }, { local: true }, { query: { includeAccountData: 'true' } }]) {
    let starts = 0;
    const f = fixture({ ...options, prefetch: async () => { starts++; } });
    const { work } = f.request(options.query); await flush(); f.readyProfile();
    f.account.resolve(f.currentAccount); f.full.resolve({ success: true }); await work; assert.equal(starts, 0);
  }
});
test('운영 계정 조회 오류가 먼저 끝나면 늦은 가입 완료로 보유 읽기를 새로 시작하지 않는다', async () => {
  let starts = 0; const f = fixture({ prefetch: async () => { starts++; } });
  const { work } = f.request(); await flush(); f.account.reject(Error('synthetic-account-error'));
  await flush(); f.readyProfile(); await work; assert.equal(starts, 0);
});


test('운영 App Check·서명·헤더·메서드 거부는 선행 보유 읽기를 시작하지 않는다', async () => {
  for (const [options, extra] of [[{ appCheck: false }, {}], [{ tokenError: 'auth/invalid-id-token' }, {}],
    [{}, { headers: {} }], [{}, { method: 'POST' }], [{}, { method: 'OPTIONS' }]]) {
    let starts = 0;
    const f = fixture({ ...options, prefetch: async () => { starts++; } });
    await f.request(undefined, extra).work; assert.equal(starts, 0); assert.equal(f.calls.full, 0);
  }
});
