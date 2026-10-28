'use strict';
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
const { measureInitialization: measure } = require('./membershipWorkerTiming');

// 같은 실제 SDK 객체에 위임한다. 검증용 메서드 존재 확인만으로 Storage를 만들지 않는다.
function deferredBucket(name, create) {
  let bucket;
  const current = () => bucket ||= create();
  const target = { name,
    file: (...args) => current().file(...args),
    getFiles: (...args) => current().getFiles(...args),
  };
  return new Proxy(target, { get(object, key, receiver) {
    if (Reflect.has(object, key)) return Reflect.get(object, key, receiver);
    const actual = current(), value = Reflect.get(actual, key, actual);
    return typeof value === 'function' ? value.bind(actual) : value;
  } });
}

function deferredFirestore(create) {
  let database;
  const current = () => database ||= create();
  const target = {
    collection: (...args) => {
      let collection;
      const reference = () => collection ||= current().collection(...args);
      const methods = { doc: (...values) => reference().doc(...values) };
      return new Proxy(methods, { get(object, key, receiver) {
        if (Reflect.has(object, key)) return Reflect.get(object, key, receiver);
        const actual = reference(), value = Reflect.get(actual, key, actual);
        return typeof value === 'function' ? value.bind(actual) : value;
      } });
    },
    runTransaction: (...args) => current().runTransaction(...args),
    terminate: () => database?.terminate(),
  };
  return new Proxy(target, { get(object, key, receiver) {
    if (Reflect.has(object, key)) return Reflect.get(object, key, receiver);
    const actual = current(), value = Reflect.get(actual, key, actual);
    return typeof value === 'function' ? value.bind(actual) : value;
  } });
}

function createUserWriterRuntime({ resolveConfig = () => resolveProfileWriterConfig(), env = process.env,
  createConnection, createProductionServices, createEmulatorServices, createBinding, createMigration } = {}) {
  let runtime;
  function getProfileWriterBinding() {
    // SDK 생성 전과 캐시 재사용 전 설정을 확인한다. 미등록 운영 대상은 연결하지 않는다.
    const config = measure('worker.config', resolveConfig);
    if (runtime) {
      if (JSON.stringify(config) !== JSON.stringify(runtime.config) || runtime.closed) {
        throw Object.assign(new Error('실행 중인 프로필 writer 연결을 교체할 수 없습니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
      }
      return runtime.binding;
    }
    const connection = measure('worker.connection', () => createConnection ? createConnection(config)
      : config.mode === 'production' ? require('../config/userStorage').createConfiguredUserStorageConnection()
        : require('../config/userStorage').createUserStorageConnection());
    const deferWorkerDependencies = config.mode === 'production' && env.K_SERVICE && env.K_REVISION
      && !env.FUNCTIONS_EMULATOR && !env.FIREBASE_EMULATOR_HUB
      && ['syncMembershipClaimsAfterProfile', 'refreshInventoryReadSnapshot', 'prepareInventoryReadSnapshot'].includes(env.FUNCTION_TARGET);
    let services;
    try { services = measure('worker.services', () => {
      if (config.mode === 'production') {
        if (createProductionServices) services = createProductionServices(connection, config);
        else {
          if (!connection.authClient) throw Object.assign(new Error('관리형 서버 인증이 필요합니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
          const firestore = () => new (require('@google-cloud/firestore').Firestore)({ projectId: config.projectId,
            authClient: connection.authClient });
          const db = deferWorkerDependencies ? deferredFirestore(firestore) : firestore();
          const bucket = () => new (require('@google-cloud/storage').Storage)({ projectId: config.projectId,
            authClient: connection.authClient }).bucket(config.storageBucket);
          services = { db, bucket: deferWorkerDependencies ? deferredBucket(config.storageBucket, bucket) : bucket(),
            auth: measure('worker.auth', () => require('firebase-admin/auth').getAuth(connection.app)), terminate: () => db.terminate() };
        }
      } else if (createEmulatorServices) services = createEmulatorServices(connection, config);
      else {
        const db = new (require('@google-cloud/firestore').Firestore)({ projectId: config.projectId, host: config.firestoreHost, ssl: false });
        const authClient = new (require('google-auth-library').OAuth2Client)();
        authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3600000 });
        const storage = new (require('@google-cloud/storage').Storage)({ projectId: config.projectId,
          apiEndpoint: `http://${config.storageHost}`, authClient, useAuthWithCustomEndpoint: true });
        const prefix = `profileWriterRuns/${config.runId}`;
        services = { db: { collection: name => db.collection(`${prefix}/${name}`), runTransaction: callback => db.runTransaction(callback) },
          bucket: storage.bucket(`${config.projectId}-${config.runId}.appspot.com`), terminate: () => db.terminate() };
      }
      return services;
    });
    } catch (error) { Promise.resolve(connection.close()).catch(() => {}); throw error; }
    const { db, bucket, auth } = services;
    // 운영 원본은 실제 컬렉션/파일 주소를 쓴다. 시험의 run scope를 운영 주소에 붙이지 않는다.
    const database = config.mode === 'production' ? connection.database
      : { ref: path => connection.database.ref(`profileWriterRuns/${config.runId}/data/${path}`) };
    let closing;
    const state = { config, closed: false,
      close() { state.closed = true; return closing ||= (async () => { await connection.close(); await services.terminate?.(); })(); } };
    try {
      const makeMigration = () => {
      const lookup = require('./card-service/services/cardReadLookup').createRemoteCardLookup(async request => {
        const collection = db.collection('cards');
        const docs = request.cids
          ? (await Promise.all(request.cids.map(cid => collection.doc(cid).get()))).filter(doc => doc.exists)
          : (await collection.where(request.field, 'array-contains', request.value).get()).docs;
        return docs.map(doc => ({ cid: doc.id, data: doc.data() }));
      });
      return (createMigration || require('./inventoryMigrationService').createInventoryMigrationService)({ lookup,
        normalizeText: require('./card-service/utils/text').normalizeText,
        updateInventoryWithRetry: (...args) => state.binding.inventoryRepository.updateInventoryWithRetry(...args),
      });
      };
      let migrationInstance;
      const migrationFor = () => migrationInstance ||= makeMigration();
      const migration = deferWorkerDependencies ? {
        prepareInventoryV2: (...args) => migrationFor().prepareInventoryV2(...args),
        inventoryMigrationStatus: (...args) => migrationFor().inventoryMigrationStatus(...args),
      } : makeMigration();
      const binding = measure('worker.binding_module', () => createBinding || require('./userInventoryWriterRepository').createUserInventoryWriterBinding);
      const FieldValue = measure('worker.firestore_types', () => require('firebase-admin/firestore').FieldValue);
      state.binding = measure('worker.binding', () => binding({ db, database, bucket,
        FieldValue, runId: config.runId, onAmbiguousWrite: () => state.close(),
        migration, config, initializeMissing: config.mode !== 'production', deferOptionalServices: deferWorkerDependencies,
        historyMaintenance: config.mode === 'production' && env.K_SERVICE && env.K_REVISION ? 'deferred' : 'inline',
      }));
    } catch (error) { state.close().catch(() => {}); throw error; }
    state.binding.auth = auth;
    runtime = state; return state.binding;
  }
  function getProfileWriterRepository() { return getProfileWriterBinding().repository; }
  async function closeProfileWriterRuntime() { if (runtime) await runtime.close(); }
  return { getProfileWriterBinding, getProfileWriterRepository, closeProfileWriterRuntime };
}
const runtime = createUserWriterRuntime();
module.exports = { ...runtime, createUserWriterRuntime, deferredBucket, deferredFirestore };
