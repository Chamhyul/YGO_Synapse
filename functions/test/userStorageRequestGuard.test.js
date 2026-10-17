'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const demo = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-guard',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-guard-default-rtdb' };
const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
  status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; }, send() { return this; } });

test('일반 사용자 경로는 RTDB 시험·잘못된 운영 설정을 Auth·운영 프록시보다 먼저 차단한다', async () => {
  for (const env of [demo, { ...demo, FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199' },
    { USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production', NODE_ENV: 'production' }, { USER_STORAGE_BACKEND: 'unknown' }]) {
    const handler = withUserStorageRequestGuard(() => assert.fail('인증·프록시 접근 금지'), { env });
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = response(); await handler({ method, query: {}, body: {} }, res);
      assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'USER_STORAGE_FEATURE_UNAVAILABLE');
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
  }
});

test('기존 backend·OPTIONS·명시적으로 허용한 warmup은 기존 handler 계약을 유지한다', async () => {
  let calls = 0;
  const handler = (_req, res) => { calls++; return res.json({ success: true }); };
  for (const backend of [undefined, '', 'storage']) {
    const res = response(); await withUserStorageRequestGuard(handler, { env: { USER_STORAGE_BACKEND: backend } })({ method: 'POST' }, res);
    assert.equal(res.statusCode, 200);
  }
  await withUserStorageRequestGuard(handler, { env: demo })({ method: 'OPTIONS' }, response());
  for (const req of [{ method: 'POST', body: { warmup: 'true' } }, { method: 'GET', query: { warmup: 'true' } }]) {
    await withUserStorageRequestGuard(handler, { env: demo, allowWarmup: true })(req, response());
  }
  const res = response(); await withUserStorageRequestGuard(handler, { env: demo })({ method: 'POST', body: { warmup: 'true' } }, res);
  assert.equal(res.statusCode, 503); assert.equal(calls, 6);
});

test('코드에 등록된 production 설정 검증이 성공해야만 실제 handler를 실행한다', async () => {
  let checks = 0, calls = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/userStorageRequestGuard.js'), 'utf8'), {
    module, process: { env: {} }, require(name) { if (['../services/inventoryRequestTiming', './inventoryRequestTiming'].includes(name)) return require('../services/inventoryRequestTiming'); 
      if (name === './userStorageStartup') return { prepareUserStorageStartup() {} };
      assert.equal(name, '../config/userStorage'); return { resolveUserStorageConfig(env) {
        checks++; assert.equal(env.USER_STORAGE_BACKEND, 'rtdb'); return { mode: 'production' };
      } };
    },
  });
  const handler = module.exports.withUserStorageRequestGuard(() => { calls++; }, { env: { USER_STORAGE_BACKEND: 'rtdb' } });
  await handler({ method: 'POST' }, response()); assert.equal(checks, 1); assert.equal(calls, 1);
});

test('user 실제 export는 저장소 guard를 publicRead wrapper 바깥에 적용하고 getUserData만 warmup을 허용한다', async () => {
  const forbidden = () => assert.fail('실제 사용자·인벤토리·인증 접근 금지');
  let transportCalls = 0;
  const exports = {};
  const mocks = {
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    'firebase-functions/v2/https': { onRequest: (_, handler) => handler },
    '../services/publicReadTransport': { withPublicReadRequest: handler => (req, res) => { transportCalls++; return handler(req, res); } },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: (handler, options) =>
      withUserStorageRequestGuard(handler, { ...options, env: demo }) },
    '../services/userProfileRepository': { getUserProfileRepository: forbidden },
    '../utils/auth': { setCors() {}, verifyRegisteredUser: forbidden, getVerifiedAccountRole: forbidden, verifyAppCheck: forbidden },
    '../utils/inventoryStorage': { downloadInventory: forbidden, updateInventoryWithRetry: forbidden, deleteInventory: forbidden },
    '../services/inventoryMigrationService': { ensureInventoryV2: forbidden, inventoryMigrationStatus: forbidden },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8'), {
    exports, require(name) { if (['../services/inventoryRequestTiming', './inventoryRequestTiming'].includes(name)) return require('../services/inventoryRequestTiming');  assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; },
  });
  for (const name of ['getUserData', 'clearUserData', 'updateUserSettings', 'updateNickname']) {
    for (const method of ['GET', 'POST']) {
      const res = response(); await exports[name]({ method, query: {}, body: {} }, res); assert.equal(res.statusCode, 503);
    }
    if (name !== 'getUserData') {
      const res = response(); await exports[name]({ method: 'POST', query: {}, body: { warmup: 'true' } }, res); assert.equal(res.statusCode, 503);
    }
  }
  assert.equal(transportCalls, 0);
  const warmup = response(); await exports.getUserData({ method: 'POST', query: {}, body: { warmup: 'true' } }, warmup);
  assert.equal(warmup.statusCode, 200); assert.equal(warmup.body.message, 'warmed up');
  const options = response(); await exports.getUserData({ method: 'OPTIONS', query: {}, body: {} }, options);
  assert.equal(options.statusCode, 204); assert.equal(transportCalls, 2);
});
test('프로필 writer 플래그는 기본 backend에서도 일반 export의 Auth/운영 전달 전에 거부한다', () => {
  for (const backend of [undefined, 'storage', 'rtdb']) {
    let calls = 0; const result = response();
    withUserStorageRequestGuard(() => { calls++; }, { env: { USER_STORAGE_BACKEND: backend, USER_PROFILE_WRITER_MODE: 'emulator' } })({ method: 'POST' }, result);
    assert.equal(calls, 0); assert.equal(result.statusCode, 503);
  }
});

test('인벤토리·이식 실제 export도 시험 writer에서 Auth·카드·외부 문서 접근 전에 거부한다', async () => {
  const forbidden = () => assert.fail('인증·업무·운영 전달 금지');
  for (const route of ['inventory', 'migration']) {
    const exports = {}, noop = {};
    const mocks = {
      'firebase-functions/v2/https': { onRequest: (_, handler) => handler },
      '../services/publicReadTransport': { withPublicReadRequest: handler => (req, res) => forbidden() },
      '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => withUserStorageRequestGuard(handler,
        { env: { USER_PROFILE_WRITER_MODE: 'emulator' } }) },
      '../utils/auth': { setCors() {}, verifyRegisteredUser: forbidden }, '../services/inventoryCardLookup': noop,
      '../utils/inventoryStorage': noop, '../services/inventoryMigrationService': noop,
      '../services/migrationService': noop, '../integrations/googleSheets': noop, '../utils/safeError': noop,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../routes/${route}.js`), 'utf8'), {
      exports, require(name) { if (['../services/inventoryRequestTiming', './inventoryRequestTiming'].includes(name)) return require('../services/inventoryRequestTiming');  assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; },
    });
    assert.ok(Object.keys(exports).length > 0);
    for (const handler of Object.values(exports)) { const res = response(); await handler({ method: 'POST', query: {}, body: {} }, res); assert.equal(res.statusCode, 503); }
  }
});
