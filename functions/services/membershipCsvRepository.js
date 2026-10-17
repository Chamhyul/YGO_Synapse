'use strict';

const invalid = () => Object.assign(new Error('멤버십 목록 저장소 설정이 올바르지 않습니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
function backendOf() {
  if (process.env.USER_PROFILE_WRITER_MODE) throw invalid();
  const value = process.env.USER_STORAGE_BACKEND;
  if (value === 'rtdb') return value;
  if (value === undefined || value === '' || value === 'storage') return 'storage';
  throw invalid();
}
function getMembershipCsvStore({ db, env = process.env, writerBinding } = {}) {
  if (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production') {
    writerBinding = require('./userWriterSelection').selectProductionWriter({ env, writerBinding });
  }
  if (env.USER_PROFILE_WRITER_MODE && writerBinding) {
    const resolve = () => require('../config/userProfileWriter').resolveProfileWriterConfig(env);
    const initial = JSON.stringify(resolve());
    const check = () => { const config = resolve();
      if (initial !== JSON.stringify(config) || config.runId !== writerBinding.transition?.runId || !writerBinding.membershipCsv) throw invalid();
      return writerBinding.membershipCsv;
    };
    check();
    return Object.fromEntries(['read', 'readMember', 'status', 'begin', 'stage', 'commit', 'fail', 'expire', 'withRequest']
      .map(method => [method, async (...args) => check()[method](...args)]));
  }
  if (env !== process.env) throw invalid();
  const backend = backendOf(); let firestore;
  function selected() {
    if (backendOf() !== backend) throw invalid();
    if (backend === 'rtdb') {
      const store = require('./userStorageRuntime').getRtdbUserStorage().membershipCsv;
      if (!store) throw invalid();
      return store;
    }
    if (!firestore) firestore = require('./membershipCsvService').createFirestoreMembershipCsvStore(db || require('../config/firebase').db);
    return firestore;
  }
  selected();
  return Object.fromEntries(['read', 'readMember', 'status', 'begin', 'stage', 'commit', 'fail', 'expire']
    .map(method => [method, async (...args) => selected()[method](...args)]));
}
module.exports = { getMembershipCsvStore };
