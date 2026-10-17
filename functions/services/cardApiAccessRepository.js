'use strict';

const { createCardApiAccess } = require('./cardApiAccess');
const invalid = () => Object.assign(new Error('API 접근 저장소 설정이 올바르지 않습니다.'), {
  code: 'USER_STORAGE_CONFIG_INVALID',
});
function backendOf() {
  if (process.env.USER_PROFILE_WRITER_MODE) throw invalid();
  const backend = process.env.USER_STORAGE_BACKEND;
  if (backend === 'rtdb') return backend;
  if (backend === undefined || backend === '' || backend === 'storage') return 'storage';
  throw invalid();
}

function validateCardApiReadEnvironment() {
  if ((process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production')) {
    require('../config/userProfileWriter').resolveProfileWriterConfig(); return;
  }
  if (backendOf() !== 'rtdb') return;
  const config = require('../config/userStorage').resolveUserStorageConfig();
  // 같은 프로젝트의 카드 Firestore를 유지한다. 시험은 로컬 Firestore만 허용한다.
  if (process.env.CARD_SERVICE_URL || (config.mode === 'emulator'
      && (!/^(localhost|127\.0\.0\.1|\[::1\]|emulators):[1-9][0-9]{0,4}$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')
      || Number(process.env.FIRESTORE_EMULATOR_HOST.split(':').at(-1)) > 65535))) throw invalid();
}

function getCardApiAccess({ db, env = process.env, writerBinding } = {}) {
  if (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production') {
    writerBinding = require('./userWriterSelection').selectProductionWriter({ env, writerBinding });
  }
  if (env.USER_PROFILE_WRITER_MODE && writerBinding) {
    const resolve = () => require('../config/userProfileWriter').resolveProfileWriterConfig(env);
    const initial = JSON.stringify(resolve());
    const check = () => {
      const config = resolve();
      if (JSON.stringify(config) !== initial || env.CARD_SERVICE_URL || writerBinding.transition?.runId !== config.runId || !writerBinding.apiAccess) throw invalid();
      return writerBinding.apiAccess;
    };
    check();
    return Object.fromEntries(['authenticate', 'allowsPreflight', 'consume', 'register', 'disable', 'rotate', 'withRequest']
      .map(method => [method, async (...args) => check()[method](...args)]));
  }
  if (env !== process.env) throw invalid();
  const backend = backendOf();
  let firestore;
  function selected() {
    if (backendOf() !== backend) throw invalid();
    if (backend === 'rtdb') {
      const access = require('./userStorageRuntime').getRtdbUserStorage().apiAccess;
      if (!access) throw invalid();
      return access;
    }
    if (!firestore) firestore = createCardApiAccess(db || require('../config/firebase').db);
    return firestore;
  }
  // 초기 선택과 캐시된 객체의 매 호출을 검증한다. 실패 시 다른 저장소로 우회하지 않는다.
  selected();
  return Object.fromEntries(['authenticate', 'allowsPreflight', 'consume', 'register', 'disable', 'rotate']
    .map(method => [method, async (...args) => selected()[method](...args)]));
}

function withCardApiRequest(handler, access) {
  if (typeof access.withRequest !== 'function') return handler;
  return async (req, res) => {
    const replies = [], buffered = new Proxy(res, { get(target, property) {
      if (['set', 'status', 'json', 'send'].includes(property)) return (...args) => { replies.push([property, args]); return buffered; };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await access.withRequest(req, () => handler(req, buffered));
      for (const [method, args] of replies) res[method](...args);
      return res;
    } catch (_) { return res.status(503).set('Cache-Control', 'private, no-store').json({ success: false, code: 'API_UNAVAILABLE' }); }
  };
}
module.exports = { getCardApiAccess, validateCardApiReadEnvironment, withCardApiRequest };
