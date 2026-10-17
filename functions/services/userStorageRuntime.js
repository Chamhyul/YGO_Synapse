'use strict';

let storage;
function getRtdbUserStorage() {
  if ((process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production')) {
    return require('./userWriterSelection').selectProductionWriter().claimsStorage;
  }
  // 캐시가 있어도 매 요청 설정을 검사한다. 미확정/종료 연결을 자동 교체하지 않는다.
  const { resolveUserStorageConfig, sameConnectionConfig } = require('../config/userStorage');
  const config = resolveUserStorageConfig();
  if (storage) {
    if (!sameConnectionConfig(storage.config, config)) {
      throw Object.assign(new Error('실행 중인 사용자 저장소의 연결 설정을 바꿀 수 없습니다.'), {
        code: 'USER_STORAGE_CONFIG_INVALID',
      });
    }
    return storage;
  }
  storage = require('./user-storage').createConfiguredUserStorage();
  return storage;
}

async function closeRtdbUserStorage() {
  if ((process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production')) {
    return require('./userProfileWriterRuntime').closeProfileWriterRuntime();
  }
  if (storage) await storage.close();
}

module.exports = { getRtdbUserStorage, closeRtdbUserStorage };
