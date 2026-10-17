'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const storageConfig = require('../config/userStorage');
const transport = require('../services/adminTransport');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');

const demoEnvironment = () => ({ USER_STORAGE_BACKEND: 'rtdb', NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-admin-runtime',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000',
  USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-admin-runtime-default-rtdb' });
function response() {
  return { code: 200, headers: {}, set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
}
async function call(handlers, name = 'adminPages', url = '/admin') {
  const req = { url, originalUrl: url, method: 'GET', protocol: 'http', headers: { host: 'localhost:5005' } };
  const res = response(); await handlers[name](req, res); return { req, res };
}
function loadRuntime(resolveUserStorageConfig, validateAdminSessionEnvironment = () => {}) {
  const filename = path.join(__dirname, '../services/adminPageRuntime.js');
  const loaded = new Module(filename, module);
  const mocks = {
    '../config/userStorage': { resolveUserStorageConfig },
    './adminSessionRepository': { validateAdminSessionEnvironment,
      createConfiguredAdminPageHandler: () => assert.fail('저장소는 이 시험에 명시적으로 주입해야 합니다.') },
    './adminTransport': transport,
  };
  loaded.filename = filename;
  loaded.require = name => { assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 모듈: ${name}`); return mocks[name]; };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.createAdminRouteHandlers;
}

test('일반 export 구성의 RTDB 에뮬레이터·미등록 운영 설정은 SDK 의존성과 proxy 생성 전에 닫힌다', async () => {
  const forbidden = () => assert.fail('운영 서비스 또는 proxy를 호출할 수 없습니다.');
  for (const env of [demoEnvironment(), { USER_STORAGE_BACKEND: 'unknown' },
    { USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production', NODE_ENV: 'production',
      GCLOUD_PROJECT: 'synthetic-project', USER_DATABASE_URL: 'https://synthetic-project.firebaseio.com' }]) {
    const handlers = createAdminRouteHandlers({ env, productionDependencies: forbidden, proxy: forbidden, createPageHandler: forbidden });
    for (const [name, url] of [['adminPages', '/admin'], ['adminBackend', '/adminBackend?route=%2Fadmin']]) {
      const { res } = await call(handlers, name, url);
      assert.equal(res.code, 503); assert.deepEqual(res.body, { success: false });
      assert.equal(res.headers['cache-control'], 'private, no-store');
    }
  }
});

test('RTDB 관리자 공용 factory는 합성 의존성만 사용하며 backend의 허용 경로와 고정 출처를 유지한다', async () => {
  let created = 0, handled = 0;
  const env = demoEnvironment(), dependencies = { synthetic: true };
  const handlers = createAdminRouteHandlers({ env, emulatorDependencies: dependencies,
    productionDependencies: () => assert.fail('운영 서비스 생성 금지'), proxy: () => assert.fail('운영 proxy 금지'),
    createPageHandler(actual, options) {
      assert.equal(actual, dependencies); assert.equal(options.env, env); created++;
      return (_req, res) => { handled++; return res.json({ success: true }); };
    },
  });
  for (const url of ['/adminBackend?route=%2Fadmin&route=%2Fadmin', '/adminBackend?route=%2Fnot-admin',
    '/adminBackend?route=%2Fadmin&uid=owner']) {
    assert.equal((await call(handlers, 'adminBackend', url)).res.code, 404);
  }
  assert.equal(created, 0);
  const { req, res } = await call(handlers, 'adminBackend', '/adminBackend?route=%2Fadmin%2Fapi%2Fnotices');
  assert.equal(req.originalUrl, '/admin/api/notices');
  assert.equal(req.headers['x-forwarded-host'], new URL(transport.BACKEND_URL).host);
  assert.equal(req.headers['x-forwarded-proto'], 'https');
  assert.equal(res.headers[transport.BACKEND_HEADER.toLowerCase()], '1');
  assert.equal((await call(handlers)).res.code, 200);
  assert.equal(created, 1); assert.equal(handled, 2);
});

test('캐시된 관리자 factory는 backend·모드·프로젝트·URL·운영 대상 변경을 거부한다', async () => {
  const initial = { mode: 'production', projectId: 'synthetic-project', databaseURL: 'https://synthetic-project.firebaseio.com/',
    instanceId: 'synthetic-project', targetId: 'synthetic-target', location: 'us-central1' };
  for (const change of [{ backend: 'storage' }, { mode: 'emulator' }, { projectId: 'synthetic-other' },
    { databaseURL: 'https://synthetic-other.firebaseio.com/' }, { instanceId: 'synthetic-other' },
    { targetId: 'synthetic-other' }, { location: 'europe-west1' }]) {
    let config = { ...initial }, calls = 0;
    const factory = loadRuntime(() => config), env = { USER_STORAGE_BACKEND: 'rtdb' };
    const handlers = factory({ env, productionDependencies: () => ({}), emulatorDependencies: {},
      createPageHandler: () => (_req, res) => { calls++; return res.json({ success: true }); } });
    assert.equal((await call(handlers)).res.code, 200);
    config = { ...config, ...change };
    if (change.backend) env.USER_STORAGE_BACKEND = change.backend;
    const { res } = await call(handlers);
    assert.equal(res.code, 503); assert.deepEqual(res.body, { success: false }); assert.equal(calls, 1);
  }
});

test('관리자 의존성·handler·proxy의 비동기 실패도 원문 없이 503으로 닫힌다', async () => {
  const fail = async () => { throw new Error('synthetic-private-failure'); };
  const configurations = [
    { env: {}, productionDependencies: fail },
    { env: {}, productionDependencies: () => ({}), createPageHandler: () => fail },
    { env: { FUNCTIONS_EMULATOR: 'true' }, proxy: fail },
    { env: demoEnvironment(), emulatorDependencies: {}, createPageHandler: () => fail },
  ];
  for (const configuration of configurations) {
    const handlers = createAdminRouteHandlers(configuration);
    const { res } = await call(handlers);
    assert.equal(res.code, 503); assert.deepEqual(res.body, { success: false });
    assert.doesNotMatch(JSON.stringify(res), /synthetic-private-failure/);
  }
});

test('동시 관리자 요청은 의존성을 한 번만 준비하고 환경 검증을 매번 실행한다', async () => {
  let created = 0, checked = 0;
  const factory = loadRuntime(env => { checked++; return storageConfig.resolveUserStorageConfig(env); });
  const env = demoEnvironment();
  const handlers = factory({ env, emulatorDependencies: {}, createPageHandler: async () => {
    created++; return (_req, res) => res.json({ success: true });
  } });
  const responses = await Promise.all([call(handlers), call(handlers), call(handlers)]);
  assert.deepEqual(responses.map(({ res }) => res.code), [200, 200, 200]);
  assert.equal(created, 1); assert.ok(checked >= 3);
  env.USER_DATABASE_URL = 'https://synthetic.invalid';
  assert.equal((await call(handlers)).res.code, 503);
});

test('실제 공유 저장소와 주입 env의 불일치는 운영 서비스 준비 전에 거부한다', async () => {
  let checked = 0, prepared = 0;
  const factory = loadRuntime(() => ({ mode: 'production' }), () => {
    checked++;
    throw Object.assign(new Error('synthetic-private-environment-mismatch'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  });
  const handlers = factory({ env: { USER_STORAGE_BACKEND: 'rtdb' }, productionDependencies() { prepared++; return {}; } });
  const { res } = await call(handlers);
  assert.equal(res.code, 503); assert.deepEqual(res.body, { success: false });
  assert.equal(checked, 1); assert.equal(prepared, 0);
});
