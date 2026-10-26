'use strict';

const { createAdminPageHandler, createFirestoreStore } = require('./adminPageSession');
const invalid = () => Object.assign(new Error('관리자 세션 저장소 설정이 올바르지 않습니다.'), {
  code: 'USER_STORAGE_CONFIG_INVALID',
});
function backendOf(env = process.env) {
  if (env.USER_PROFILE_WRITER_MODE) throw invalid();
  const backend = env.USER_STORAGE_BACKEND;
  if (backend === 'rtdb') return backend;
  if (backend === undefined || backend === '' || backend === 'storage') return 'storage';
  throw invalid();
}

function validateAdminSessionEnvironment(env = process.env) {
  const backend = backendOf(env);
  if (env !== process.env) {
    if (backendOf() !== backend) throw invalid();
    if (backend === 'rtdb') {
      const { resolveUserStorageConfig, sameConnectionConfig } = require('../config/userStorage');
      if (!sameConnectionConfig(resolveUserStorageConfig(env), resolveUserStorageConfig())) throw invalid();
    }
  }
  return backend;
}

function getAdminSessionStore({ env = process.env, writerBinding } = {}) {
  if (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production') {
    writerBinding = require('./userWriterSelection').selectProductionWriter({ env, writerBinding });
  }
  if (env.USER_PROFILE_WRITER_MODE && writerBinding) {
    const check = () => {
      const config = require('../config/userProfileWriter').resolveProfileWriterConfig(env);
      if (writerBinding.transition?.runId !== config.runId || !writerBinding.adminSessions) throw invalid();
      return writerBinding.adminSessions;
    };
    check();
    return Object.fromEntries(['get', 'set', 'remove', 'touch', 'withRequest', 'withReadRequest', 'beginLogin'].map(method =>
      [method, async (...args) => check()[method](...args)]));
  }
  const backend = validateAdminSessionEnvironment(env);
  let firestore;
  function selected() {
    if (validateAdminSessionEnvironment(env) !== backend) throw invalid();
    if (backend === 'rtdb') {
      const store = require('./userStorageRuntime').getRtdbUserStorage().adminSessions;
      if (!store) throw invalid();
      return store;
    }
    if (!firestore) firestore = createFirestoreStore(require('../config/firebase').db);
    return firestore;
  }
  // 설정은 handler 생성 시와 캐시된 저장소의 매 메서드 호출에서 검사한다.
  selected();
  return Object.fromEntries(['get', 'set', 'remove', 'touch'].map(method =>
    [method, async (...args) => selected()[method](...args)]));
}

function createConfiguredAdminPageHandler(options, { env = process.env, writerBinding } = {}) {
  if (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production') {
    writerBinding = require('./userWriterSelection').selectProductionWriter({ env, writerBinding });
  }
  const store = getAdminSessionStore({ env, writerBinding });
  // CSV를 포함한 관리 기능은 검증된 실행 환경에서 명시적으로 주입한다.
  const membershipCsv = env.USER_PROFILE_WRITER_MODE && writerBinding
    ? require('./membershipCsvService').createMembershipCsvService({ store: require('./membershipCsvRepository').getMembershipCsvStore({ env, writerBinding }), now: options.now }) : options.membershipCsv;
  return createAdminPageHandler({ ...options, store, membershipCsv,
    ...(env.USER_PROFILE_WRITER_MODE && writerBinding?.notices ? { notices: writerBinding.notices } : {}) });
}

module.exports = { getAdminSessionStore, createConfiguredAdminPageHandler, validateAdminSessionEnvironment };
