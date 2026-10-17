'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const sessionModule = require('../services/adminPageSession');
const transportModule = require('../services/adminTransport');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const storageConfig = require('../config/userStorage');
const { resolveRtdbConfig } = storageConfig;

function load(relative, mocks, env = {}) {
  const filename = path.join(__dirname, '..', relative), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${relative}: ${name}`);
    return mocks[name];
  };
  // 공유 env 객체는 실행 중 설정 변경과 캐시된 객체의 다음 호출을 검사한다.
  loaded.taskEnvironment = env;
  loaded._compile(`const process = { env: module.taskEnvironment };\n${fs.readFileSync(filename, 'utf8')}`, filename);
  return loaded.exports;
}

function response() {
  return { code: 200, headers: {}, set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(code) { this.code = code; return this; }, type(value) { this.set('Content-Type', value); return this; },
    send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
}
function request(url, options = {}) {
  return { url, originalUrl: url, method: options.method || 'GET', protocol: 'http', body: options.body || {},
    headers: { host: 'localhost:5005', origin: 'http://localhost:5005', 'content-type': 'application/json',
      ...options.headers } };
}

function firestoreFixture() {
  const rows = new Map(), operations = [];
  const reference = key => ({ key,
    async get() { operations.push(['get', key]); return { exists: rows.has(key), data: () => rows.get(key) }; },
    async set(value) { operations.push(['set', key, value]); rows.set(key, value); },
    async delete() { operations.push(['delete', key]); rows.delete(key); },
  });
  const db = {
    collection(name) { assert.equal(name, 'AdminWebSessions'); return { doc: reference }; },
    async runTransaction(callback) {
      operations.push(['transaction']);
      return callback({ get: ref => ref.get(), update(ref, value) { rows.set(ref.key, { ...rows.get(ref.key), ...value }); } });
    },
  };
  return { db, rows, operations };
}

const demoEnvironment = () => ({ USER_STORAGE_BACKEND: 'rtdb', NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-admin-sessions',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000',
  USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-admin-sessions-default-rtdb' });
function repository(env, runtime, firebase) {
  return load('services/adminSessionRepository.js', {
    './adminPageSession': sessionModule,
    '../config/userStorage': { ...storageConfig, resolveUserStorageConfig: input => storageConfig.resolveUserStorageConfig(input || env) },
    ...(runtime ? { './userStorageRuntime': runtime } : {}),
    ...(firebase ? { '../config/firebase': firebase } : {}),
  }, env);
}

test('기본·명시적 storage 관리자 세션은 기존 Firestore 문서와 트랜잭션 계약을 유지한다', async () => {
  for (const backend of [undefined, '', 'storage']) {
    const data = firestoreFixture();
    const store = repository({ USER_STORAGE_BACKEND: backend }, undefined, { db: data.db }).getAdminSessionStore();
    const value = { uid: 'synthetic-owner', lastActivity: 1000, expiresAt: 99999999 };
    assert.equal(await store.get('synthetic-hash'), undefined);
    await store.set('synthetic-hash', value);
    assert.deepEqual(await store.get('synthetic-hash'), value);
    assert.equal(await store.touch('synthetic-hash', 'another-user', 1200), false);
    assert.equal(await store.touch('synthetic-hash', value.uid, 1200), true);
    assert.equal((await store.get('synthetic-hash')).lastActivity, 1200);
    assert.equal(await store.touch('synthetic-hash', value.uid, 1200 + sessionModule.IDLE_MS), false);
    await store.remove('synthetic-hash');
    assert.equal(await store.touch('synthetic-hash', value.uid, 1300), false);
    assert.equal(await store.get('synthetic-hash'), undefined);
    assert.equal(data.rows.size, 0);
    assert.ok(data.operations.some(operation => operation[0] === 'transaction'));
  }
});

test('잘못된 관리자 backend와 RTDB 설정은 기존 Firebase 또는 메모리로 대체하지 않는다', () => {
  assert.throws(() => repository({ USER_STORAGE_BACKEND: 'unknown' }).getAdminSessionStore(), {
    code: 'USER_STORAGE_CONFIG_INVALID',
  });
  for (const change of [{ NODE_ENV: 'production' }, { GCLOUD_PROJECT: 'real-project' },
    { FIREBASE_DATABASE_EMULATOR_HOST: undefined }, { USER_DATABASE_URL: 'https://real-project.firebaseio.com' }]) {
    const env = { ...demoEnvironment(), ...change };
    const api = repository(env, { getRtdbUserStorage() { resolveRtdbConfig(env); throw Error('설정 거부 전에 저장소를 만들 수 없습니다.'); } });
    assert.throws(api.getAdminSessionStore, { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  const unavailable = repository(demoEnvironment(), { getRtdbUserStorage: () => ({}) });
  assert.throws(unavailable.getAdminSessionStore, { code: 'USER_STORAGE_CONFIG_INVALID' });
});

test('RTDB 세션 메서드는 매번 설정을 검사하고 조건부 삭제 관측값을 그대로 전달한다', async () => {
  let checks = 0;
  const calls = [], observation = { uid: 'synthetic-owner', lastActivity: 1, expiresAt: 99 };
  const adminSessions = Object.fromEntries(['get', 'set', 'remove', 'touch'].map(method => [method, async (...args) => {
    calls.push([method, ...args]); return method === 'get' ? observation : true;
  }]));
  const env = demoEnvironment();
  const store = repository(env, { getRtdbUserStorage() { checks++; resolveRtdbConfig(env); return { adminSessions }; } }).getAdminSessionStore();
  assert.equal(checks, 1);
  assert.equal(await store.get('hash'), observation);
  await store.set('hash', observation);
  await store.remove('hash', observation);
  await store.touch('hash', 'synthetic-owner', 2);
  assert.equal(checks, 5);
  assert.deepEqual(calls, [['get', 'hash'], ['set', 'hash', observation], ['remove', 'hash', observation], ['touch', 'hash', 'synthetic-owner', 2]]);
  env.NODE_ENV = 'production';
  await assert.rejects(store.get('hash'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.equal(calls.length, 4);
});

test('캐시된 세션 저장소는 backend 변경과 연결 종료 뒤 다른 저장소로 넘어가지 않는다', async () => {
  const env = demoEnvironment(), calls = [];
  let failure;
  const store = repository(env, { getRtdbUserStorage() {
    if (failure) throw failure;
    return { adminSessions: { get: async key => { calls.push(key); return undefined; } } };
  } }).getAdminSessionStore();
  await store.get('hash');
  for (const code of ['USER_STORAGE_CONNECTION_CLOSED', 'USER_STORAGE_WRITE_AMBIGUOUS']) {
    failure = Object.assign(Error('합성 연결 오류'), { code });
    await assert.rejects(store.get('hash'), { code });
  }
  failure = undefined;
  env.USER_STORAGE_BACKEND = 'storage';
  for (const method of ['get', 'set', 'remove', 'touch']) {
    await assert.rejects(store[method]('hash'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  assert.deepEqual(calls, ['hash']);
});

test('별도로 주입한 관리자 env도 실제 공유 저장소와 backend·RTDB 대상이 같아야 한다', () => {
  const env = demoEnvironment(), calls = [];
  const api = repository(env, { getRtdbUserStorage() {
    calls.push('runtime'); return { adminSessions: {} };
  } });
  api.getAdminSessionStore({ env: { ...env } });
  assert.deepEqual(calls, ['runtime']);
  const other = { ...env, GCLOUD_PROJECT: 'demo-another-admin',
    USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-another-admin-default-rtdb' };
  for (const input of [other, { USER_STORAGE_BACKEND: 'storage' }]) {
    assert.throws(() => api.getAdminSessionStore({ env: input }), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  assert.deepEqual(calls, ['runtime']);
});

function configuredFixture(backend = 'rtdb') {
  const env = backend === 'rtdb' ? demoEnvironment() : { USER_STORAGE_BACKEND: backend };
  const calls = [], now = 1000;
  let configFailure;
  const memory = sessionModule.createMemoryStore();
  const firestore = firestoreFixture();
  const api = repository(env, backend === 'rtdb' ? { getRtdbUserStorage() {
    if (configFailure) throw configFailure;
    resolveRtdbConfig(env);
    return { adminSessions: memory };
  } } : undefined, backend === 'rtdb' ? undefined : { db: firestore.db });
  const handler = api.createConfiguredAdminPageHandler({
    auth: {
      verifyIdToken: async (token, revoked) => { assert.equal(token, 'synthetic-token'); assert.equal(revoked, true); return { uid: 'synthetic-owner' }; },
      getUser: async uid => ({ uid, customClaims: { role: 'owner' } }),
      createSessionCookie: async () => 'synthetic-cookie',
      verifySessionCookie: async (cookie, revoked) => { assert.equal(cookie, 'synthetic-cookie'); assert.equal(revoked, true); return { uid: 'synthetic-owner' }; },
    },
    template: async () => '<html><title></title><body><section id="admin-login"></section><main id="admin-content" data-admin-title="관리자"><a id="admin-settings" hidden></a></main></body></html>',
    now: () => now,
    getErrorSummary: async () => { calls.push('errors'); return {}; },
    getTrafficSummary: async () => { calls.push('traffic'); return {}; },
    notices: { list: async () => { calls.push('notices'); return {}; } },
    membershipCsv: { summary: async () => { calls.push('membership'); return {}; } },
  });
  return { env, calls, firestore, failConfig(error) { configFailure = error; },
    async call(url, options) { const res = response(); await handler(request(url, options), res); return res; },
  };
}

test('RTDB 설정 handler는 CSV를 포함한 명시적 관리 서비스를 연결한다', async () => {
  const fixture = configuredFixture();
  const login = await fixture.call('/admin/session', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' } });
  assert.equal(login.code, 200);
  assert.deepEqual(login.body, { success: true, role: 'owner' });
  assert.match(login.headers['set-cookie'], /__session=synthetic-cookie; Path=\/admin; HttpOnly; SameSite=Strict$/);
  const headers = { cookie: '__session=synthetic-cookie' };
  assert.match((await fixture.call('/admin', { headers })).body, /data-admin-role="owner"/);
  assert.equal((await fixture.call('/admin/session/activity', { method: 'POST', headers, body: { uid: 'synthetic-owner' } })).code, 204);
  for (const route of ['/admin/api/errors', '/admin/api/traffic', '/admin/api/notices']) {
    const result = await fixture.call(route, { headers });
    assert.equal(result.code, 200, route);
    assert.deepEqual(result.body, { success: true });
  }
  const membership = await fixture.call('/admin/api/membership-csv', { headers });
  assert.equal(membership.code, 200);
  assert.deepEqual(membership.body, { success: true });
  assert.deepEqual(fixture.calls, ['errors', 'traffic', 'notices', 'membership']);
  assert.equal((await fixture.call('/admin/session/logout', { method: 'POST', headers })).code, 204);
});

test('기본 설정 handler는 기존 주입 관리 API와 Firestore 저장 동작을 유지한다', async () => {
  const fixture = configuredFixture('storage');
  assert.equal((await fixture.call('/admin/session', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' } })).code, 200);
  const headers = { cookie: '__session=synthetic-cookie' };
  for (const route of ['/admin/api/errors', '/admin/api/traffic', '/admin/api/notices', '/admin/api/membership-csv']) {
    assert.equal((await fixture.call(route, { headers })).code, 200, route);
  }
  assert.deepEqual(fixture.calls, ['errors', 'traffic', 'notices', 'membership']);
  assert.equal(fixture.firestore.rows.size, 1);
});

test('생성된 RTDB handler도 다음 인증 요청에서 설정 변경을 거부하고 원문을 숨긴다', async () => {
  const fixture = configuredFixture();
  await fixture.call('/admin/session', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' } });
  fixture.failConfig(Object.assign(Error('private-config-must-not-leak'), { code: 'USER_STORAGE_CONFIG_INVALID' }));
  const headers = { cookie: '__session=synthetic-cookie' };
  const page = await fixture.call('/admin', { headers });
  assert.equal(page.code, 503);
  assert.doesNotMatch(page.body, /id="admin-content"|private-config-must-not-leak/);
  const activity = await fixture.call('/admin/session/activity', { method: 'POST', headers, body: { uid: 'synthetic-owner' } });
  assert.equal(activity.code, 503);
  assert.deepEqual(activity.body, { success: false });
  assert.deepEqual(fixture.calls, []);
});

function loadRoutes(env, runtimeFactory = createAdminRouteHandlers) {
  const calls = [];
  const dependencies = [];
  const exports = load('routes/admin/pages.js', {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    'node:fs/promises': { readFile: async () => '<html></html>' },
    'node:path': path,
    '../../config/firebase': { admin: {
      auth() { calls.push('auth'); return {}; },
      storage() { calls.push('storage'); return { bucket: () => ({}) }; },
    }, db: {} },
    '../../services/adminPageRuntime': { createAdminRouteHandlers: options => runtimeFactory({ ...options, env,
      createPageHandler(options) {
        dependencies.push(options);
        calls.push('create-production'); return (_req, res) => { calls.push('production'); return res.json({ source: 'production' }); };
      },
    }) },
    '../../services/adminErrorSummary': { createErrorSummaryService: () => async () => ({}) },
    '../../services/adminTrafficSummary': { createTrafficSummaryService: () => async () => ({}) },
    '../../services/noticeService': { createNoticeService: () => ({}), createStorageNoticeStore: () => ({}) },
    get '../../services/membershipCsvService'() {
      calls.push('membership-module');
      return { createMembershipCsvService: () => { calls.push('membership'); return {}; }, createFirestoreMembershipCsvStore: () => ({}) };
    },
    '../../services/membershipCsvRepository': { getMembershipCsvStore: () => { calls.push('membership-store'); return {}; } },
    '../../services/adminTransport': {
      ...transportModule,
      createAdminBackendHandler: ({ handler }) => transportModule.createAdminBackendHandler({ handler, env }),
      createAdminProxy: () => (_req, res) => { calls.push('proxy'); return res.json({ source: 'proxy' }); },
      createLocalAdminRenderer: () => async () => '',
    },
    googleapis: { google: {} },
  }, env);
  return { calls, dependencies, async call(name, url) { const res = response(); await exports[name](request(url), res); return res; } };
}

test('일반 관리자 export는 RTDB·알 수 없는 backend를 운영 proxy와 직접 handler 앞에서 거부한다', async () => {
  for (const backend of ['rtdb', 'unknown']) {
    for (const emulator of [undefined, 'emulators:9000']) {
      const routes = loadRoutes({ USER_STORAGE_BACKEND: backend, FIREBASE_DATABASE_EMULATOR_HOST: emulator });
      for (const [name, url] of [['adminPages', '/admin'], ['adminBackend', '/adminBackend?route=%2Fadmin']]) {
        const result = await routes.call(name, url);
        assert.equal(result.code, 503);
        assert.deepEqual(result.body, { success: false });
        assert.equal(result.headers['cache-control'], 'private, no-store');
      }
      assert.deepEqual(routes.calls, []);
    }
  }
});

test('기본 관리자 export의 운영 직접 처리와 로컬 proxy 및 backend 에뮬레이터 차단은 유지된다', async () => {
  for (const backend of [undefined, '', 'storage']) {
    const production = loadRoutes({ USER_STORAGE_BACKEND: backend });
    assert.deepEqual((await production.call('adminPages', '/admin')).body, { source: 'production' });
    assert.deepEqual((await production.call('adminBackend', '/adminBackend?route=%2Fadmin')).body, { source: 'production' });
    assert.equal(production.calls.filter(value => value === 'create-production').length, 1);
    assert.equal(production.calls.filter(value => value === 'production').length, 2);
    const local = loadRoutes({ USER_STORAGE_BACKEND: backend, FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000' });
    assert.deepEqual((await local.call('adminPages', '/admin')).body, { source: 'proxy' });
    assert.equal((await local.call('adminBackend', '/adminBackend?route=%2Fadmin')).code, 503);
    assert.deepEqual(local.calls, ['proxy']);
  }
});

test('이미 생성된 관리자 export도 runtime backend 변경 뒤 운영 handler를 재호출하지 않는다', async () => {
  const env = { USER_STORAGE_BACKEND: 'storage' }, routes = loadRoutes(env);
  await routes.call('adminPages', '/admin');
  const before = [...routes.calls];
  env.USER_STORAGE_BACKEND = 'rtdb';
  assert.equal((await routes.call('adminPages', '/admin')).code, 503);
  assert.equal((await routes.call('adminBackend', '/adminBackend?route=%2Fadmin')).code, 503);
  assert.deepEqual(routes.calls, before);
});

test('일반 관리자 export의 승인된 RTDB 운영 분기는 CSV selector를 포함한 관리 서비스를 준비한다', async () => {
  // 운영 대상은 단위 검사에서만 합성 설정으로 주입하며 SDK와 서비스도 모두 모의 객체다.
  const runtimeFactory = load('services/adminPageRuntime.js', {
    '../config/userStorage': { resolveUserStorageConfig: () => ({ mode: 'production', projectId: 'synthetic-project',
      targetId: 'synthetic-target', instanceId: 'synthetic-instance', location: 'us-central1',
      databaseURL: 'https://synthetic-instance.firebaseio.com/' }) },
    './adminSessionRepository': { createConfiguredAdminPageHandler: () => assert.fail('합성 처리기를 주입해야 합니다.') },
    './adminTransport': transportModule,
  }).createAdminRouteHandlers;
  const routes = loadRoutes({ USER_STORAGE_BACKEND: 'rtdb' }, runtimeFactory);
  assert.equal((await routes.call('adminPages', '/admin')).code, 200);
  assert.equal((await routes.call('adminBackend', '/adminBackend?route=%2Fadmin')).code, 200);
  assert.equal(routes.dependencies.length, 1);
  assert.ok(routes.dependencies[0].auth);
  assert.ok(routes.dependencies[0].notices);
  assert.equal(typeof routes.dependencies[0].getErrorSummary, 'function');
  assert.equal(typeof routes.dependencies[0].getTrafficSummary, 'function');
  assert.ok(routes.dependencies[0].membershipCsv);
  assert.ok(routes.calls.includes('membership'));
  assert.ok(routes.calls.includes('membership-module'));
  assert.ok(routes.calls.includes('membership-store'));
});
