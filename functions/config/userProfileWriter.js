'use strict';
const { resolveRtdbConfig, resolveProductionRtdbConfig } = require('./userStorage');
function productionWriterRequested(env = process.env) {
  return env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production';
}
function resolveProfileWriterConfig(env = process.env, targets) {
  const fail = () => { throw Object.assign(new Error('사용자 writer의 실행 모드·대상·전환 ID를 확인해 주세요.'), { code: 'USER_STORAGE_CONFIG_INVALID' }); };
  if (productionWriterRequested(env)) {
    if (env.USER_PROFILE_WRITER_MODE !== 'production' || !/^[a-f0-9]{32}$/.test(env.USER_PROFILE_WRITER_RUN_ID || '') || env.CARD_SERVICE_URL) fail();
    const registry = targets === undefined ? require('./userStorageTargets').PRODUCTION_TARGETS : targets;
    const config = resolveProductionRtdbConfig(env, registry);
    const selected = registry.find(target => target.id === env.USER_STORAGE_TARGET);
    if (!/^[a-f0-9]{32}$/.test(selected.writerRunId || '') || selected.writerRunId !== env.USER_PROFILE_WRITER_RUN_ID) fail();
    const storageBucket = env.STORAGE_BUCKET || `${config.projectId}.firebasestorage.app`;
    if (![`${config.projectId}.firebasestorage.app`, `${config.projectId}.appspot.com`].includes(storageBucket)) fail();
    if (env.FIREBASE_CONFIG && JSON.parse(env.FIREBASE_CONFIG).storageBucket
        && JSON.parse(env.FIREBASE_CONFIG).storageBucket !== storageBucket) fail();
    return Object.freeze({ ...config, runId: env.USER_PROFILE_WRITER_RUN_ID, storageBucket });
  }
  if (env.USER_PROFILE_WRITER_MODE !== 'emulator' || !/^[a-f0-9]{32}$/.test(env.USER_PROFILE_WRITER_RUN_ID || '')) fail();
  const config = resolveRtdbConfig(env), base = config.emulatorHost.slice(0, config.emulatorHost.lastIndexOf(':'));
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    const host = env[key];
    if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\]|emulators):[1-9][0-9]{0,4}$/.test(host)
        || host.slice(0, host.lastIndexOf(':')) !== base || Number(host.split(':').at(-1)) > 65535) fail();
  }
  if (['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_CONFIG', 'USER_STORAGE_TARGET']
      .some(key => env[key]) || env.STORAGE_EMULATOR_HOST && env.STORAGE_EMULATOR_HOST !== `http://${env.FIREBASE_STORAGE_EMULATOR_HOST}`) fail();
  return Object.freeze({ ...config, runId: env.USER_PROFILE_WRITER_RUN_ID, firestoreHost: env.FIRESTORE_EMULATOR_HOST,
    storageHost: env.FIREBASE_STORAGE_EMULATOR_HOST, authHost: env.FIREBASE_AUTH_EMULATOR_HOST });
}
module.exports = { resolveProfileWriterConfig, productionWriterRequested };
