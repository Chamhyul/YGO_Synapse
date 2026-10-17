'use strict';

const { measure } = require('./inventoryRequestTiming');
const { resolveUserStorageConfig } = require('../config/userStorage');
require('./userStorageStartup').prepareUserStorageStartup();

// 일반 사용자 export는 저장소 설정이 확정되기 전에 Auth·운영 프록시에 접근하지 않는다.
// 시험 통합 검사는 이 바깥 경계를 합성 handler로 명시적으로 대체한다.
function withUserStorageRequestGuard(handler, { env = process.env, allowWarmup = false } = {}) {
  return (req, res) => {
    const backend = env.USER_STORAGE_BACKEND;
    const warmup = allowWarmup && (req.query?.warmup === 'true' || req.body?.warmup === 'true');
    if (req.method !== 'OPTIONS' && !warmup && (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production')) {
      return Promise.resolve().then(async () => {
        try {
          await measure('storage.initialize', () => {
            const binding = require('./userWriterSelection').selectProductionWriter({ env });
            return binding.initialize();
          });
        } catch (_) {
          res.set('Cache-Control', 'no-store');
          return res.status(503).json({ success: false, code: 'USER_STORAGE_FEATURE_UNAVAILABLE',
            message: '이 환경에서는 사용자 저장소에 접근할 수 없습니다.' });
        }
        return handler(req, res);
      });
    }
    if (req.method !== 'OPTIONS' && !warmup && env.USER_PROFILE_WRITER_MODE) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ success: false, code: 'USER_STORAGE_FEATURE_UNAVAILABLE',
        message: '이 환경에서는 사용자 저장소에 접근할 수 없습니다.' });
    }
    if (req.method === 'OPTIONS' || warmup || backend === undefined || backend === '' || backend === 'storage') {
      return handler(req, res);
    }
    try {
      if (backend !== 'rtdb' || resolveUserStorageConfig(env).mode !== 'production') throw new Error();
    } catch (_) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ success: false, code: 'USER_STORAGE_FEATURE_UNAVAILABLE',
        message: '이 환경에서는 사용자 저장소에 접근할 수 없습니다.' });
    }
    return handler(req, res);
  };
}

module.exports = { withUserStorageRequestGuard };
