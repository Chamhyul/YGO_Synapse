'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { getApps } = require('firebase-admin/app');
const { resolveRtdbConfig, resolveProductionRtdbConfig, resolveUserStorageConfig,
  createUserStorageConnection, createConfiguredUserStorageConnection } = require('../config/userStorage');

const fixture = {
  NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000',
  USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb',
};
const invalid = { code: 'USER_STORAGE_CONFIG_INVALID' };

test('RTDB 준비 연결은 같은 demo namespace와 명시된 로컬 주소만 받는다', () => {
  const before = { ...fixture };
  const config = resolveRtdbConfig(fixture);
  assert.equal(config.databaseURL, 'http://emulators:9000/?ns=demo-user-storage-default-rtdb');
  assert.equal(config.projectId, fixture.GCLOUD_PROJECT);
  assert.equal(config.mode, 'emulator');
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(fixture, before);
  for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000']) {
    assert.equal(resolveRtdbConfig({ ...fixture, FIREBASE_DATABASE_EMULATOR_HOST: host,
      USER_DATABASE_URL: `http://${host}/?ns=demo-user-storage-default-rtdb` }).emulatorHost, host);
  }
});

const target = Object.freeze({ id: 'synthetic-user-data', projectId: 'synthetic-runtime',
  instanceId: 'synthetic-user-data', location: 'asia-southeast1',
  databaseURL: 'https://synthetic-user-data.asia-southeast1.firebasedatabase.app/' });
const production = () => ({ USER_STORAGE_MODE: 'production', USER_STORAGE_BACKEND: 'rtdb', NODE_ENV: 'production',
  USER_STORAGE_TARGET: target.id, GCLOUD_PROJECT: target.projectId, USER_DATABASE_URL: target.databaseURL,
  K_SERVICE: 'synthetic-function', K_REVISION: 'synthetic-function-revision' });

test('기본 선택기는 기존 emulator를 유지하고 실제 운영 대상 미등록 상태에서는 SDK 연결을 거부한다', () => {
  assert.equal(resolveUserStorageConfig(fixture).mode, 'emulator');
  assert.equal(resolveUserStorageConfig({ ...fixture, USER_STORAGE_MODE: 'emulator' }).mode, 'emulator');
  assert.throws(() => resolveUserStorageConfig({ ...fixture, USER_STORAGE_MODE: 'invalid' }), invalid);
  assert.throws(() => resolveUserStorageConfig(production()), invalid);
  assert.throws(() => resolveProductionRtdbConfig(production()), invalid);
  const original = { ...process.env }, before = getApps().map(app => app.name);
  try {
    Object.assign(process.env, production());
    assert.throws(createConfiguredUserStorageConnection, invalid);
    assert.deepEqual(getApps().map(app => app.name), before);
  } finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test('합성 registry로 순수 운영 설정을 검사하고 정확한 프로젝트·인스턴스·위치를 반환한다', () => {
  const env = production(), before = { ...env };
  const config = resolveProductionRtdbConfig(env, [target]);
  assert.deepEqual(config, { mode: 'production', targetId: target.id, projectId: target.projectId,
    instanceId: target.instanceId, location: target.location, databaseURL: target.databaseURL });
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(env, before);
  assert.equal(resolveProductionRtdbConfig({ ...env, GOOGLE_CLOUD_PROJECT: target.projectId,
    FIREBASE_CONFIG: JSON.stringify({ projectId: target.projectId }), USER_DATABASE_URL: target.databaseURL.slice(0, -1) }, [target]).databaseURL,
  target.databaseURL);
  const central = { ...target, location: 'us-central1', databaseURL: `https://${target.instanceId}.firebaseio.com/` };
  assert.equal(resolveProductionRtdbConfig({ ...env, USER_DATABASE_URL: central.databaseURL }, [central]).location, 'us-central1');
});

test('운영 모드의 누락·다른 프로젝트·다른 URL·에뮬레이터·파일 자격증명은 모의 SDK 접근 전 거부한다', () => {
  for (const key of Object.keys(production())) {
    const env = production(); delete env[key];
    assert.throws(() => resolveProductionRtdbConfig(env, [target]), invalid, `누락: ${key}`);
  }
  const cases = [
    { USER_STORAGE_MODE: 'emulator' }, { USER_STORAGE_BACKEND: 'storage' }, { NODE_ENV: 'test' },
    { GCLOUD_PROJECT: 'another-project' }, { GOOGLE_CLOUD_PROJECT: 'another-project' },
    { USER_STORAGE_TARGET: 'another-target' }, { K_SERVICE: ' ' }, { K_REVISION: ' ' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000' }, { FIRESTORE_EMULATOR_HOST: 'emulators:8080' },
    { FUNCTIONS_EMULATOR: 'true' }, { FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' },
    { GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/credential.json' }, { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/synthetic/login.json' },
    { GCE_METADATA_HOST: 'synthetic.invalid' }, { GCE_METADATA_IP: '127.0.0.1' }, { METADATA_SERVER_DETECTION: 'assume-present' },
    { FIREBASE_CONFIG: '/synthetic/firebase.json' }, { FIREBASE_CONFIG: '[]' }, { FIREBASE_CONFIG: 'null' },
    { FIREBASE_CONFIG: JSON.stringify({ projectId: 'another-project' }) },
    { USER_DATABASE_URL: target.databaseURL.replace('https:', 'http:') },
    { USER_DATABASE_URL: target.databaseURL.replace('synthetic-user-data.', 'another-instance.') },
    { USER_DATABASE_URL: target.databaseURL.replace('asia-southeast1.', 'europe-west1.') },
    { USER_DATABASE_URL: target.databaseURL.replace('https://', 'https://synthetic@') },
    { USER_DATABASE_URL: target.databaseURL.replace('.app/', '.app:444/') },
    { USER_DATABASE_URL: `${target.databaseURL}path` }, { USER_DATABASE_URL: `${target.databaseURL}?ns=other` },
    { USER_DATABASE_URL: `${target.databaseURL}#fragment` }, { USER_DATABASE_URL: `${target.databaseURL} ` },
  ];
  for (const change of cases) assert.throws(() => resolveProductionRtdbConfig({ ...production(), ...change }, [target]), invalid);
  for (const change of [{ projectId: 'demo-runtime' }, { instanceId: '../other' }, { instanceId: 'another-instance' },
    { location: 'other-location' }, { location: 'europe-west1' }, { databaseURL: 'https://synthetic.invalid/' }]) {
    assert.throws(() => resolveProductionRtdbConfig(production(), [{ ...target, ...change }]), invalid);
  }
  assert.throws(() => resolveProductionRtdbConfig(production(), [target, target]), invalid);
  assert.throws(() => resolveProductionRtdbConfig(production(), {}), invalid);
});

function connectionFixture(env = production(), targets = [target], { failDatabase = false, nativeHeaders = false } = {}) {
  const calls = { app: 0, database: 0, credential: 0, tokens: 0, offline: 0, deleted: 0, dependencies: [] };
  const now = 1000000, app = {}, database = { goOffline() { calls.offline++; } };
  let options, tokenNumber = 0, currentClient;
  const filename = path.join(__dirname, '../config/userStorage.js'), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    if (name === '__synthetic_env__') return env;
    calls.dependencies.push(name);
    if (name === './userStorageTargets') return { PRODUCTION_TARGETS: targets };
    if (name === 'node:crypto') return { randomUUID: () => 'synthetic-unique-app' };
    if (name === 'firebase-admin/app') return {
      initializeApp(value, name) { calls.app++; options = value; calls.name = name; return app; },
      deleteApp(value) { assert.equal(value, app); calls.deleted++; return Promise.resolve(); },
    };
    if (name === 'firebase-admin/database') return { getDatabase(value) {
      assert.equal(value, app); calls.database++;
      if (failDatabase) throw new Error('합성 SDK 실패');
      return database;
    } };
    if (name === 'google-auth-library') return { Compute: class {
      constructor(value) { calls.credential++; calls.credentialOptions = value; currentClient = this; }
      async getAccessToken() { calls.tokens++; this.credentials = {
        access_token: `synthetic-token-${++tokenNumber}`, expiry_date: now + 3600999,
      }; }
      async getRequestHeaders() {
        calls.headers = (calls.headers || 0) + 1;
        return nativeHeaders ? new Headers({ Authorization: 'Bearer synthetic' }) : { Authorization: 'Bearer synthetic' };
      }
    } };
    assert.fail(`SDK 또는 인증 의존성 추가 접근 금지: ${name}`);
  };
  loaded._compile(`const process = { env: require('__synthetic_env__') };\n` +
    `const Date = { now: () => ${now} };\n${fs.readFileSync(filename, 'utf8')}`, filename);
  // 별도 모듈 closure에 살아 있는 env를 제공하고 실제 process 환경/SDK는 사용하지 않는다.
  return { calls, env, loaded: loaded.exports, getOptions: () => options, getClient: () => currentClient };
}

function syntheticConnection(callback, env = production(), targets = [target], options) {
  return callback(connectionFixture(env, targets, options));
}

test('운영 연결은 metadata 전용 인증을 주입하고 토큰 만료·갱신과 idempotent 종료를 보존한다', async () => {
  await syntheticConnection(async ({ calls, loaded, getOptions }) => {
    const connection = loaded.createConfiguredUserStorageConnection();
    assert.equal(connection.config.mode, 'production');
    assert.equal(calls.tokens, 0);
    assert.equal(calls.credential, 1);
    assert.equal(calls.dependencies.includes('google-auth-library'), true);
    assert.equal(calls.dependencies.includes('googleapis'), false);
    assert.equal(calls.name, 'user-storage-production-synthetic-unique-app');
    assert.deepEqual(calls.credentialOptions.scopes, ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email']);
    assert.equal(getOptions().projectId, target.projectId);
    assert.equal(getOptions().databaseURL, target.databaseURL);
    assert.deepEqual(await getOptions().credential.getAccessToken(), { access_token: 'synthetic-token-1', expires_in: 3600 });
    assert.deepEqual(await getOptions().credential.getAccessToken(), { access_token: 'synthetic-token-2', expires_in: 3600 });
    const closing = connection.close(); assert.equal(connection.close(), closing); await closing;
    assert.equal(calls.offline, 1); assert.equal(calls.deleted, 1);
  });
});
test('공통 writer의 클라우드 인증도 같은 Compute를 사용하고 run·버킷 변경을 토큰/요청 전에 거부한다', async () => {
  const env = { ...production(), USER_PROFILE_WRITER_MODE: 'production', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32) };
  await syntheticConnection(async ({ calls, loaded, getOptions }) => {
    const connection = loaded.createConfiguredUserStorageConnection();
    assert.deepEqual(calls.credentialOptions.scopes, ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/cloud-platform']);
    await connection.authClient.getRequestHeaders(); assert.equal(calls.headers, 1);
    env.USER_PROFILE_WRITER_RUN_ID = 'b'.repeat(32);
    await assert.rejects(connection.authClient.getRequestHeaders(), invalid);
    await assert.rejects(getOptions().credential.getAccessToken(), invalid);
    assert.equal(calls.headers, 1); assert.equal(calls.tokens, 0);
    env.USER_PROFILE_WRITER_RUN_ID = 'a'.repeat(32); env.STORAGE_BUCKET = 'other';
    await assert.rejects(connection.authClient.getRequestHeaders(), invalid); await connection.close();
  }, env);
});

test('운영 요청 헤더는 Headers와 기존 객체형 모두 인증값을 보존하고 변경된 설정을 거부한다', async () => {
  for (const nativeHeaders of [false, true]) {
    await syntheticConnection(async ({ calls, env, loaded }) => {
      const connection = loaded.createConfiguredUserStorageConnection();
      assert.deepEqual(await connection.authClient.getRequestHeaders(),
        nativeHeaders ? { authorization: 'Bearer synthetic' } : { Authorization: 'Bearer synthetic' });
      env.USER_DATABASE_URL = 'https://other.invalid/';
      await assert.rejects(connection.authClient.getRequestHeaders(), invalid);
      assert.equal(calls.headers, 1);
      await connection.close();
    }, production(), [target], { nativeHeaders });
  }
});

test('운영 설정 변경과 불완전·만료된 metadata 토큰은 인증 결과로 전달하지 않는다', async () => {
  await syntheticConnection(async ({ calls, env, loaded, getOptions, getClient }) => {
    loaded.createConfiguredUserStorageConnection();
    const credential = getOptions().credential;
    env.USER_DATABASE_URL = 'https://other.invalid/';
    await assert.rejects(credential.getAccessToken(), invalid); assert.equal(calls.tokens, 0);
    env.USER_DATABASE_URL = target.databaseURL;
    for (const values of [{}, { access_token: 'synthetic-token', expiry_date: 1000000 },
      { access_token: '', expiry_date: 4600000 }, { access_token: 'synthetic-token', expiry_date: NaN }]) {
      getClient().getAccessToken = async () => { getClient().credentials = values; };
      await assert.rejects(credential.getAccessToken(), invalid);
    }
  });
});

test('시험 전용 생성기는 production을 거부하고 미등록 운영 대상은 SDK·인증 의존성을 로드하지 않는다', () => {
  syntheticConnection(({ calls, loaded }) => {
    assert.throws(loaded.createConfiguredUserStorageConnection, invalid);
    assert.deepEqual(calls.dependencies, ['./userStorageTargets']);
  }, production(), []);
  syntheticConnection(({ calls, loaded }) => {
    assert.throws(loaded.createUserStorageConnection, invalid);
    assert.deepEqual(calls.dependencies, ['./userStorageTargets']);
  });
  syntheticConnection(({ calls, loaded }) => {
    const connection = loaded.createConfiguredUserStorageConnection();
    assert.equal(connection.config.mode, 'emulator'); assert.equal(calls.credential, 0);
    assert.equal(calls.name, 'user-storage-test-synthetic-unique-app');
    assert.equal(calls.dependencies.includes('googleapis'), false);
    assert.equal(calls.dependencies.includes('google-auth-library'), false);
  }, { ...fixture });
});

test('SDK DB 생성 실패 때 생성한 별도 앱을 정리한다', () => {
  syntheticConnection(({ calls, loaded }) => {
    assert.throws(loaded.createConfiguredUserStorageConnection, /합성 SDK 실패/);
    assert.equal(calls.app, 1); assert.equal(calls.deleted, 1);
  }, production(), [target], { failDatabase: true });
});

test('운영 URL·실프로젝트·잘못된 namespace·불완전한 격리 설정은 거부한다', () => {
  const before = getApps().map(app => app.name);
  for (const key of Object.keys(fixture)) {
    const env = { ...fixture }; delete env[key];
    assert.throws(() => resolveRtdbConfig(env), invalid, `누락: ${key}`);
  }
  const cases = [
    { USER_STORAGE_MODE: 'production' }, { USER_STORAGE_MODE: 'unknown' },
    { NODE_ENV: 'production' }, { USER_STORAGE_BACKEND: 'legacy' },
    { GCLOUD_PROJECT: 'ygo-synapse' }, { GOOGLE_CLOUD_PROJECT: 'different-project' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'https://emulators:9000' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:65536' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'remote.example:9000' },
    { USER_DATABASE_URL: 'https://ygo-synapse-default-rtdb.asia-southeast1.firebasedatabase.app' },
    { USER_DATABASE_URL: 'https://emulators:9000/?ns=demo-user-storage-default-rtdb' },
    { USER_DATABASE_URL: 'http://emulators:9001/?ns=demo-user-storage-default-rtdb' },
    { USER_DATABASE_URL: 'http://emulators:9000/?ns=wrong-default-rtdb' },
    { USER_DATABASE_URL: 'http://owner@emulators:9000/?ns=demo-user-storage-default-rtdb' },
    { USER_DATABASE_URL: 'http://emulators:9000/path?ns=demo-user-storage-default-rtdb' },
    { USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-user-storage-default-rtdb&ns=other' },
    { USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-user-storage-default-rtdb&auth=token' },
    { USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-user-storage-default-rtdb#extra' },
  ];
  for (const change of cases) assert.throws(() => resolveRtdbConfig({ ...fixture, ...change }), invalid);
  assert.deepEqual(getApps().map(app => app.name), before);
});

test('설정 거부는 기본 Firebase 앱 생성이나 운영 자격증명 조회보다 먼저 일어난다', () => {
  const original = process.env.USER_STORAGE_BACKEND;
  const before = getApps().map(app => app.name);
  try {
    delete process.env.USER_STORAGE_BACKEND;
    assert.throws(createUserStorageConnection, invalid);
    assert.deepEqual(getApps().map(app => app.name), before);
  } finally {
    if (original === undefined) delete process.env.USER_STORAGE_BACKEND;
    else process.env.USER_STORAGE_BACKEND = original;
  }
});
