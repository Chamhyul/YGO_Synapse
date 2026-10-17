'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Compute } = require('google-auth-library');
const { Storage } = require('@google-cloud/storage');
const { grpc } = require('google-gax');

const TOKEN = 'synthetic-sdk-header-token';
const PROJECT = 'synthetic-runtime';
const target = { id: 'synthetic-user-data', projectId: PROJECT, instanceId: 'synthetic-user-data',
  location: 'asia-southeast1', databaseURL: 'https://synthetic-user-data.asia-southeast1.firebasedatabase.app/' };
const envFor = () => ({ NODE_ENV: 'production', USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production',
  USER_PROFILE_WRITER_MODE: 'production', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
  USER_STORAGE_TARGET: target.id, USER_DATABASE_URL: target.databaseURL, GCLOUD_PROJECT: PROJECT,
  STORAGE_BUCKET: `${PROJECT}.firebasestorage.app`, K_SERVICE: 'synthetic-service', K_REVISION: 'synthetic-revision' });

function seed(client) {
  client.setCredentials({ access_token: TOKEN, expiry_date: Date.now() + 3600000 });
  // 실제 Compute의 헤더/토큰 경로를 사용하되 metadata 통신은 반드시 실패시킨다.
  client.refreshTokenNoCache = async () => assert.fail('시험에서 metadata 요청 금지');
  return client;
}

function consumers(client) {
  const storage = new Storage({ projectId: PROJECT, authClient: client });
  const callCredential = grpc.credentials.createFromGoogleCredential(client);
  return {
    storageAuth: storage.authClient,
    storageHeaders: () => storage.authClient.authorizeRequest({ uri: `https://storage.googleapis.com/storage/v1/b/${PROJECT}.firebasestorage.app/o` }),
    grpcMetadata: () => callCredential.generateMetadata({ service_url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore' }),
  };
}

function productionConnection() {
  const env = envFor(), filename = path.join(__dirname, '../config/userStorage.js');
  const loaded = new Module(filename, module);
  let appOptions, actualClient, closed = 0;
  loaded.filename = filename;
  loaded.require = name => {
    if (name === '__synthetic_env__') return env;
    if (name === './userStorageTargets') return { PRODUCTION_TARGETS: [target] };
    if (name === 'google-auth-library') return { Compute: class extends Compute {
      constructor(options) { super(options); actualClient = seed(this); }
    } };
    if (name === 'firebase-admin/app') return {
      initializeApp(options) { appOptions = options; return {}; },
      deleteApp: async () => { closed++; },
    };
    if (name === 'firebase-admin/database') return { getDatabase: () => ({ goOffline() {} }) };
    if (name === 'node:crypto') return require(name);
    assert.fail(`예상하지 않은 연결 의존성: ${name}`);
  };
  loaded._compile(`const process = { env: require('__synthetic_env__') };\n${fs.readFileSync(filename, 'utf8')}`, filename);
  const connection = loaded.exports.createConfiguredUserStorageConnection();
  assert.equal(connection.authClient, actualClient);
  assert.ok(actualClient instanceof Compute);
  return { connection, env, credential: appOptions.credential, closed: () => closed };
}

test('현재 SDK 조합은 원본 auth v10 Headers에서 Storage와 gRPC의 Authorization을 누락한다', async () => {
  const client = seed(new Compute({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }));
  const native = await client.getRequestHeaders();
  assert.equal(native.get('authorization'), `Bearer ${TOKEN}`);
  const actual = consumers(client);
  assert.equal(actual.storageAuth.cachedCredential, client);
  assert.equal((await actual.storageHeaders()).headers.authorization, undefined);
  assert.deepEqual((await actual.grpcMetadata()).get('authorization'), []);
});

test('실제 운영 연결 wrapper는 같은 Compute의 인증 헤더를 Storage와 Firestore gRPC에 전달한다', async () => {
  const f = productionConnection();
  try {
    assert.equal(Object.keys(require.cache).some(filename => /[\\/]node_modules[\\/]googleapis[\\/]/.test(filename)), false);
    const actual = consumers(f.connection.authClient);
    assert.equal(actual.storageAuth.cachedCredential, f.connection.authClient);
    assert.equal((await actual.storageHeaders()).headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual((await actual.grpcMetadata()).get('authorization'), [`Bearer ${TOKEN}`]);
    const token = await f.credential.getAccessToken();
    assert.equal(token.access_token, TOKEN);
    assert.ok(token.expires_in > 3500 && token.expires_in <= 3600);
  } finally { await f.connection.close(); }
  assert.equal(f.closed(), 1);
});

test('실제 SDK 헤더 소비와 Admin 토큰 경로 모두 실행 중 run·버킷 변경을 거부한다', async () => {
  const f = productionConnection(), original = { ...f.env };
  try {
    const actual = consumers(f.connection.authClient), invalid = { code: 'USER_STORAGE_CONFIG_INVALID' };
    for (const patch of [{ USER_PROFILE_WRITER_RUN_ID: 'b'.repeat(32) }, { STORAGE_BUCKET: 'other.firebasestorage.app' }]) {
      Object.assign(f.env, original, patch);
      await assert.rejects(actual.storageHeaders(), invalid);
      await assert.rejects(actual.grpcMetadata(), invalid);
      await assert.rejects(f.credential.getAccessToken(), invalid);
    }
  } finally { await f.connection.close(); }
});
