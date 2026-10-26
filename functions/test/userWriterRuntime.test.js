'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
const { createUserWriterRuntime } = require('../services/userProfileWriterRuntime');
const target = { id: 'synthetic-user-data', projectId: 'synthetic-runtime', instanceId: 'synthetic-user-data', location: 'asia-southeast1', databaseURL: 'https://synthetic-user-data.asia-southeast1.firebasedatabase.app/', writerRunId: 'a'.repeat(32) };
const production = () => ({ NODE_ENV: 'production', USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production', USER_PROFILE_WRITER_MODE: 'production', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
  GCLOUD_PROJECT: target.projectId, USER_STORAGE_TARGET: target.id, USER_DATABASE_URL: target.databaseURL, K_SERVICE: 'synthetic-service', K_REVISION: 'synthetic-revision' });
test('지연 버킷은 존재 검사에서 생성하지 않고 실제 사용 때 같은 인증의 SDK 객체에 위임한다', () => {
  const { deferredBucket } = require('../services/userProfileWriterRuntime'); let created = 0;
  const actual = { marker: 'same', file(name) { assert.equal(this, actual); return { name }; }, getFiles() { return [this.marker]; },
    extra() { return this.marker; }, storage: { sameCredential: true } };
  const bucket = deferredBucket('synthetic-bucket', () => { created++; return actual; });
  assert.equal(bucket.name, 'synthetic-bucket'); assert.equal(typeof bucket.file, 'function'); assert.equal(typeof bucket.getFiles, 'function');
  assert.equal(created, 0); assert.deepEqual(bucket.file('synthetic-file'), { name: 'synthetic-file' });
  assert.deepEqual(bucket.getFiles(), ['same']); assert.equal(bucket.extra(), 'same'); assert.equal(bucket.storage, actual.storage);
  assert.equal(created, 1);
});
test('worker의 legacy Firestore 참조는 필요할 때만 생성하고 실제 SDK 메서드·종료를 보존한다', async () => {
  const { deferredFirestore } = require('../services/userProfileWriterRuntime'); let created = 0, closed = 0;
  const collection = { path: 'synthetic', doc(id) { assert.equal(this, collection); return { id }; },
    where(...args) { assert.equal(this, collection); return args; } };
  const actual = { collection(name) { assert.equal(name, 'synthetic'); return collection; },
    runTransaction(action) { assert.equal(this, actual); return action('transaction'); }, terminate() { closed++; } };
  const db = deferredFirestore(() => { created++; return actual; });
  const ref = db.collection('synthetic'); assert.equal(typeof ref.doc, 'function'); assert.equal(typeof db.runTransaction, 'function');
  await db.terminate(); assert.equal(created, 0); assert.equal(closed, 0);
  assert.deepEqual(ref.doc('preserved'), { id: 'preserved' }); assert.equal(ref.path, 'synthetic');
  assert.deepEqual(ref.where('x', '==', 1), ['x', '==', 1]);
  assert.equal(db.runTransaction(value => value), 'transaction'); assert.equal(created, 1);
  await db.terminate(); assert.equal(closed, 1);
});
test('관리형 worker만 인벤토리 변환기를 지연하고 실패·재사용·일반 실행 계약을 보존한다', async () => {
  for (const targetName of ['syncMembershipClaimsAfterProfile', 'getUserData']) {
    let created = 0, options; const env = { ...production(), FUNCTION_TARGET: targetName };
    const runtime = createUserWriterRuntime({ env, resolveConfig: () => resolveProfileWriterConfig(env, [target]),
      createConnection: () => ({ database: {}, close: async () => {} }), createProductionServices: () => ({ db: {}, bucket: {}, auth: {} }),
      createMigration: () => { created++; return { prepareInventoryV2: value => value, inventoryMigrationStatus: () => 'synthetic' }; },
      createBinding: value => { options = value; return {}; } });
    runtime.getProfileWriterBinding(); assert.equal(created, targetName === 'syncMembershipClaimsAfterProfile' ? 0 : 1);
    assert.equal(options.deferOptionalServices, targetName === 'syncMembershipClaimsAfterProfile');
    assert.equal(options.migration.prepareInventoryV2('preserved'), 'preserved');
    assert.equal(options.migration.inventoryMigrationStatus(), 'synthetic'); assert.equal(created, 1);
    await runtime.closeProfileWriterRuntime();
  }
});
test('운영 공통 writer 설정은 같은 프로젝트·명시 run·버킷·등록 대상만 허용한다', () => {
  const env = production(), config = resolveProfileWriterConfig(env, [target]);
  assert.equal(config.mode, 'production'); assert.equal(config.runId, env.USER_PROFILE_WRITER_RUN_ID);
  assert.equal(config.storageBucket, 'synthetic-runtime.firebasestorage.app');
  const job = { ...env, K_SERVICE: undefined, K_REVISION: undefined, CLOUD_RUN_JOB: 'synthetic-job', CLOUD_RUN_EXECUTION: 'synthetic-execution' };
  assert.equal(resolveProfileWriterConfig(job, [target]).mode, 'production');
  assert.throws(() => resolveProfileWriterConfig({ ...job, CLOUD_RUN_EXECUTION: undefined }, [target]), { code: 'USER_STORAGE_CONFIG_INVALID' });
  for (const patch of [{ USER_PROFILE_WRITER_MODE: undefined }, { USER_PROFILE_WRITER_RUN_ID: '' }, { USER_STORAGE_BACKEND: 'storage' }, { STORAGE_BUCKET: 'other.appspot.com' },
    { CARD_SERVICE_URL: 'https://synthetic.invalid' }, { FIREBASE_CONFIG: JSON.stringify({ storageBucket: 'other' }) }, { GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/credential' }]) {
    assert.throws(() => resolveProfileWriterConfig({ ...env, ...patch }, [target]), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  assert.throws(() => resolveProfileWriterConfig(env), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.throws(() => resolveProfileWriterConfig({ ...env, USER_PROFILE_WRITER_RUN_ID: 'b'.repeat(32) }, [target]), { code: 'USER_STORAGE_CONFIG_INVALID' });
});
test('미등록 운영 대상은 SDK/metadata 생성 전에 거부한다', () => {
  let created = 0;
  const runtime = createUserWriterRuntime({ resolveConfig: () => resolveProfileWriterConfig(production()), createConnection: () => { created++; assert.fail('SDK 금지'); } });
  assert.throws(runtime.getProfileWriterBinding, { code: 'USER_STORAGE_CONFIG_INVALID' }); assert.equal(created, 0);
});
test('공통 운영 연결은 실제 주소·같은 인증·단일 binding을 사용하고 설정 교체/미확정 연결 재사용을 거부한다', async () => {
  let config = resolveProfileWriterConfig(production(), [target]), connected = 0, created = 0, closed = 0, options;
  const database = {}, db = { collection: () => assert.fail('조회 미실시') }, bucket = {}, auth = {};
  const binding = { inventoryRepository: {}, repository: {} };
  const runtime = createUserWriterRuntime({ resolveConfig: () => config,
    createConnection: () => { connected++; return { database, close: async () => { closed++; } }; },
    createProductionServices: () => ({ db, bucket, auth }), createMigration: () => ({}),
    createEmulatorServices: () => assert.fail('운영에서 시험 서비스 생성 금지'),
    createBinding: value => { options = value; created++; return binding; } });
  assert.equal(runtime.getProfileWriterBinding(), binding); assert.equal(runtime.getProfileWriterBinding(), binding);
  assert.equal(connected, 1); assert.equal(created, 1); assert.equal(binding.auth, auth);
  assert.equal(options.database, database); assert.equal(options.db, db); assert.equal(options.bucket, bucket); assert.equal(options.initializeMissing, false);
  const saved = config; config = { ...config, runId: 'b'.repeat(32) };
  assert.throws(runtime.getProfileWriterBinding, { code: 'USER_STORAGE_CONFIG_INVALID' }); config = saved;
  await options.onAmbiguousWrite(); assert.equal(closed, 1);
  assert.throws(runtime.getProfileWriterBinding, { code: 'USER_STORAGE_CONFIG_INVALID' });
  await runtime.closeProfileWriterRuntime(); assert.equal(closed, 1);
});
test('binding 생성 실패는 만든 연결을 닫고 원본 오류를 기존 저장소로 대체하지 않는다', async () => {
  let closed = 0;
  const runtime = createUserWriterRuntime({ resolveConfig: () => resolveProfileWriterConfig(production(), [target]),
    createConnection: () => ({ database: {}, close: async () => { closed++; } }), createProductionServices: () => ({ db: {}, bucket: {}, auth: {} }),
    createMigration: () => ({}), createBinding: () => { throw Object.assign(Error('synthetic'), { code: 'SYNTHETIC_FAILURE' }); } });
  assert.throws(runtime.getProfileWriterBinding, { code: 'SYNTHETIC_FAILURE' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1);
});
test('실제 설치된 Firestore/Storage/Auth SDK는 metadata 클라이언트를 공유하여 네트워크 없이 생성된다', async () => {
  const { initializeApp, deleteApp } = require('firebase-admin/app'), config = resolveProfileWriterConfig(production(), [target]);
  let requested = 0, parameters;
  const client = new (require('google-auth-library').Compute)({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  client.getAccessToken = async () => { requested++; assert.fail('실제 metadata 접근 금지'); };
  client.getRequestHeaders = async () => { requested++; assert.fail('실제 인증 요청 금지'); };
  const app = initializeApp({ projectId: config.projectId, credential: { getAccessToken: client.getAccessToken } }, 'synthetic-writer-sdk-construction');
  const runtime = createUserWriterRuntime({ resolveConfig: () => config, createConnection: () => ({ database: {}, app, authClient: client, close: () => deleteApp(app) }),
    createMigration: () => ({}), createBinding: options => { parameters = options; return {}; } });
  try {
    const binding = runtime.getProfileWriterBinding(); assert.equal(binding.auth.app, app);
    assert.equal(parameters.db.projectId, config.projectId); assert.equal(parameters.bucket.name, config.storageBucket);
    assert.equal(parameters.db._settings.authClient, client); assert.equal(parameters.bucket.storage.authClient.cachedCredential, client);
    assert.equal(requested, 0);
  } finally { await runtime.closeProfileWriterRuntime(); }
});

test('관리형 운영 함수는 요청 밖 보관을 사용하고 관리 Job·시험은 inline 기본값을 보존한다',async()=>{
  for(const [functionTarget,managed,mode,expected] of [['addCards',true,'production','deferred'],['discardCards',true,'production','deferred'],
    ['moveCards',true,'production','deferred'],['adminBackend',true,'production','deferred'],['getUserData',true,'production','deferred'],
    ['compactUserWriterHistory',true,'production','deferred'],['writer',false,'production','inline'],['synthetic',true,'emulator','inline']]){
    let options;const config=resolveProfileWriterConfig(production(),[target]);
    const runtime=createUserWriterRuntime({env:{FUNCTION_TARGET:functionTarget,...(managed?{K_SERVICE:'synthetic',K_REVISION:'synthetic'}:{})},resolveConfig:()=>({...config,mode}),
      createConnection:()=>({database:{},close:async()=>{}}),createProductionServices:()=>({db:{},bucket:{},auth:{}}),
      createEmulatorServices:()=>({db:{},bucket:{},auth:{}}),createMigration:()=>({}),createBinding:value=>{options=value;return {};}});
    try{runtime.getProfileWriterBinding();assert.equal(options.historyMaintenance,expected);}finally{await runtime.closeProfileWriterRuntime();}
  }
});
