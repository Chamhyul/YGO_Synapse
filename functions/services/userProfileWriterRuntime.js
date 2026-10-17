'use strict';
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');

function createUserWriterRuntime({ resolveConfig = () => resolveProfileWriterConfig(), env = process.env,
  createConnection, createProductionServices, createEmulatorServices, createBinding, createMigration } = {}) {
  let runtime;
  function getProfileWriterBinding() {
    // SDK 생성 전과 캐시 재사용 전 설정을 확인한다. 미등록 운영 대상은 연결하지 않는다.
    const config = resolveConfig();
    if (runtime) {
      if (JSON.stringify(config) !== JSON.stringify(runtime.config) || runtime.closed) {
        throw Object.assign(new Error('실행 중인 프로필 writer 연결을 교체할 수 없습니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
      }
      return runtime.binding;
    }
    const connection = createConnection ? createConnection(config)
      : config.mode === 'production' ? require('../config/userStorage').createConfiguredUserStorageConnection()
        : require('../config/userStorage').createUserStorageConnection();
    let services;
    try {
      if (config.mode === 'production') {
        if (createProductionServices) services = createProductionServices(connection, config);
        else {
          if (!connection.authClient) throw Object.assign(new Error('관리형 서버 인증이 필요합니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
          const db = new (require('@google-cloud/firestore').Firestore)({ projectId: config.projectId, authClient: connection.authClient });
          const storage = new (require('@google-cloud/storage').Storage)({ projectId: config.projectId, authClient: connection.authClient });
          services = { db, bucket: storage.bucket(config.storageBucket), auth: require('firebase-admin/auth').getAuth(connection.app), terminate: () => db.terminate() };
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
    } catch (error) { Promise.resolve(connection.close()).catch(() => {}); throw error; }
    const { db, bucket, auth } = services;
    // 운영 원본은 실제 컬렉션/파일 주소를 쓴다. 시험의 run scope를 운영 주소에 붙이지 않는다.
    const database = config.mode === 'production' ? connection.database
      : { ref: path => connection.database.ref(`profileWriterRuns/${config.runId}/data/${path}`) };
    let closing;
    const state = { config, closed: false,
      close() { state.closed = true; return closing ||= (async () => { await connection.close(); await services.terminate?.(); })(); } };
    try {
      const lookup = require('./card-service/services/cardReadLookup').createRemoteCardLookup(async request => {
        const collection = db.collection('cards');
        const docs = request.cids
          ? (await Promise.all(request.cids.map(cid => collection.doc(cid).get()))).filter(doc => doc.exists)
          : (await collection.where(request.field, 'array-contains', request.value).get()).docs;
        return docs.map(doc => ({ cid: doc.id, data: doc.data() }));
      });
      const migration = (createMigration || require('./inventoryMigrationService').createInventoryMigrationService)({ lookup,
        normalizeText: require('./card-service/utils/text').normalizeText,
        updateInventoryWithRetry: (...args) => state.binding.inventoryRepository.updateInventoryWithRetry(...args),
      });
      state.binding = (createBinding || require('./userInventoryWriterRepository').createUserInventoryWriterBinding)({ db, database, bucket,
        FieldValue: require('firebase-admin/firestore').FieldValue, runId: config.runId, onAmbiguousWrite: () => state.close(),
        migration, config, initializeMissing: config.mode !== 'production',
        historyMaintenance: config.mode === 'production' && ['addCards', 'discardCards'].includes(env.FUNCTION_TARGET)
          && env.K_SERVICE && env.K_REVISION ? 'deferred' : 'inline',
      });
    } catch (error) { state.close().catch(() => {}); throw error; }
    state.binding.auth = auth;
    runtime = state; return state.binding;
  }
  function getProfileWriterRepository() { return getProfileWriterBinding().repository; }
  async function closeProfileWriterRuntime() { if (runtime) await runtime.close(); }
  return { getProfileWriterBinding, getProfileWriterRepository, closeProfileWriterRuntime };
}
const runtime = createUserWriterRuntime();
module.exports = { ...runtime, createUserWriterRuntime };
