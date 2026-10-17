'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { resolveRtdbConfig, resolveUserStorageConfig } = require('../config/userStorage');
const { readSourceFile } = require('./sourceFile');

function load(relative, env, mocks) {
  const filename = path.join(__dirname, '..', relative), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${name}`);
    return mocks[name];
  };
  loaded.environment = env;
  loaded._compile(`const process = { env: module.environment };\n${readSourceFile(filename, 'utf8')}`, filename);
  return loaded.exports;
}
const demo = () => ({ NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' });
const methods = ['authenticate', 'allowsPreflight', 'consume', 'register', 'disable', 'rotate'];
function fixture(env, backend) {
  let calls = 0, checks = 0;
  const passed = [];
  const access = Object.fromEntries(methods.map(method => [method, async (...args) => { passed.push([method, ...args]); return method; }]));
  const db = {};
  const api = load('services/cardApiAccessRepository.js', env, {
    './cardApiAccess': { createCardApiAccess(actual) { assert.equal(backend, 'storage'); assert.equal(actual, db); calls++; return access; } },
    './userStorageRuntime': { getRtdbUserStorage() { assert.equal(backend, 'rtdb'); checks++; resolveRtdbConfig(env); return { apiAccess: access }; } },
  });
  return { api, db, passed, counts: () => ({ calls, checks }) };
}

test('API 접근의 기본·storage 선택은 기존 Firestore 어댑터와 메서드를 유지한다', async () => {
  for (const backend of [undefined, '', 'storage']) {
    const f = fixture({ USER_STORAGE_BACKEND: backend }, 'storage'), access = f.api.getCardApiAccess({ db: f.db });
    for (const method of methods) assert.equal(await access[method]('synthetic'), method);
    assert.deepEqual(f.passed, methods.map(method => [method, 'synthetic']));
    assert.deepEqual(f.counts(), { calls: 1, checks: 0 });
  }
});
test('RTDB 선택은 Firestore 생성 없이 모든 호출을 현재 설정으로 검사한다', async () => {
  const env = demo(), f = fixture(env, 'rtdb'), access = f.api.getCardApiAccess();
  for (const method of methods) assert.equal(await access[method]('synthetic', 'argument'), method);
  assert.deepEqual(f.counts(), { calls: 0, checks: 7 });
  env.NODE_ENV = 'production';
  for (const method of methods) await assert.rejects(access[method]('synthetic'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.equal(f.passed.length, 6);
});
test('잘못된 설정·backend 변경·미제공 저장소는 자동 대체하지 않는다', async () => {
  for (const change of [{ USER_STORAGE_BACKEND: 'unknown' }, { NODE_ENV: 'production' },
    { GCLOUD_PROJECT: 'real-project' }, { USER_DATABASE_URL: 'https://real-project.firebaseio.com' }]) {
    const f = fixture({ ...demo(), ...change }, 'rtdb');
    assert.throws(() => f.api.getCardApiAccess(), { code: 'USER_STORAGE_CONFIG_INVALID' });
    assert.equal(f.counts().calls, 0);
  }
  for (const initial of ['storage', 'rtdb']) {
    const env = { ...demo(), USER_STORAGE_BACKEND: initial }, f = fixture(env, initial);
    const access = f.api.getCardApiAccess({ db: f.db });
    env.USER_STORAGE_BACKEND = initial === 'storage' ? 'rtdb' : 'storage';
    for (const method of methods) await assert.rejects(access[method](), { code: 'USER_STORAGE_CONFIG_INVALID' });
    assert.equal(f.passed.length, 0);
  }
  const missing = load('services/cardApiAccessRepository.js', demo(), {
    './cardApiAccess': {}, './userStorageRuntime': { getRtdbUserStorage: () => ({}) },
  });
  assert.throws(() => missing.getCardApiAccess(), { code: 'USER_STORAGE_CONFIG_INVALID' });
});
test('공유 연결의 종료·미확정 오류는 모든 API 접근 메서드에서 전달된다', async () => {
  for (const code of ['USER_STORAGE_CONNECTION_CLOSED', 'USER_STORAGE_WRITE_AMBIGUOUS']) {
    const store = Object.fromEntries(methods.map(method => [method, async () => { throw Object.assign(Error('합성'), { code }); }]));
    const api = load('services/cardApiAccessRepository.js', demo(), {
      './cardApiAccess': {}, './userStorageRuntime': { getRtdbUserStorage: () => ({ apiAccess: store }) },
    }).getCardApiAccess();
    for (const method of methods) await assert.rejects(api[method](), { code });
  }
});

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } };
}
function readGuard(env, resolve = () => resolveUserStorageConfig(env)) {
  return load('services/cardApiAccessRepository.js', env, {
    './cardApiAccess': {}, '../config/userStorage': { resolveUserStorageConfig: resolve },
    '../config/userProfileWriter': { resolveProfileWriterConfig: () => {
      const value = resolve(env); if (env.CARD_SERVICE_URL) throw Object.assign(Error('invalid'), { code: 'USER_STORAGE_CONFIG_INVALID' }); return value;
    } },
  }).validateCardApiReadEnvironment;
}
test('공개 카드 경로는 저장소 초기화 실패를503으로 숨기고 RTDB-only 카드조회는 차단한다', async () => {
  for (const env of [demo(), { ...demo(), FIRESTORE_EMULATOR_HOST: 'emulators:8080' }]) {
    let selected = 0, handled = 0;
    const route = load('routes/cardInfo.js', env, {
      'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
      '../config/firebase': { db: {} },
      '../services/cardApiAccessRepository': { validateCardApiReadEnvironment: readGuard(env),
        getCardApiAccess() { selected++; throw Error('private-error'); } },
      '../services/cardInfoApi': { createCardInfoHandler() { handled++; assert.fail('설정 실패 후 처리 금지'); } },
      '../services/illustrationDelivery': { createLimiter: () => () => true },
    });
    const res = response();
    await route.getCardInfo({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { success: false, code: 'API_UNAVAILABLE' });
    assert.equal(selected, env.FIRESTORE_EMULATOR_HOST ? 1 : 0); assert.equal(handled, 0);
  }
});

test('RTDB 시험 카드 경로는 외부 읽기 서버와 잘못된 Firestore 호스트를 키 조회 전에 거부한다', async () => {
  for (const change of [{ CARD_SERVICE_URL: 'https://synthetic-production.invalid' },
    { CARD_SERVICE_URL: 'http://card:8080', CARD_SERVICE_AUTH: 'fixture' },
    { FIRESTORE_EMULATOR_HOST: 'synthetic-production.invalid:8080' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:65536' }]) {
    const env = { ...demo(), FIRESTORE_EMULATOR_HOST: 'emulators:8080', ...change };
    const route = load('routes/cardInfo.js', env, {
      'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
      '../config/firebase': { db: {} },
      '../services/cardApiAccessRepository': { validateCardApiReadEnvironment: readGuard(env),
        getCardApiAccess() { assert.fail('키 접근 금지'); } },
      '../services/cardInfoApi': { createCardInfoHandler() { assert.fail('카드 접근 금지'); } },
      '../services/illustrationDelivery': { createLimiter: () => () => true },
    });
    const res = response(); await route.getCardInfo({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { success: false, code: 'API_UNAVAILABLE' });
  }
});

test('운영 준비 카드 경로는 매 요청 대상을 검증하고 같은 프로젝트의 직접 카드 읽기만 허용한다', async () => {
  const env = { USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production' };
  assert.throws(readGuard(env), { code: 'USER_STORAGE_CONFIG_INVALID' });
  let checks = 0, handled = 0;
  const guard = readGuard(env, () => { checks++; return { mode: 'production' }; });
  const route = load('routes/cardInfo.js', env, {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../config/firebase': { db: {} },
    '../services/cardApiAccessRepository': { validateCardApiReadEnvironment: guard, getCardApiAccess: () => ({}), withCardApiRequest: handler => handler },
    '../services/cardInfoApi': { createCardInfoHandler: () => (_req, res) => { handled++; return res.json({ success: true }); } },
    '../services/illustrationDelivery': { createLimiter: () => () => true },
  });
  const request = { method: 'GET', headers: {} };
  const first = response(); await route.getCardInfo(request, first);
  assert.equal(first.statusCode, 200); assert.equal(handled, 1);
  env.CARD_SERVICE_URL = 'https://synthetic.invalid';
  const blocked = response(); await route.getCardInfo(request, blocked);
  assert.equal(blocked.statusCode, 503); assert.equal(handled, 1); assert.equal(checks, 2);
});
