'use strict';
function createBackend(env) {
  if (env.CARD_READ_BACKEND === 'fixture') {
    if (env.NODE_ENV !== 'test') throw new Error('합성 저장소는 검사 환경에서만 사용합니다.');
    return require('../test/fixture-backend').createFixtureBackend();
  }
  if (env.CARD_READ_BACKEND !== 'firestore' || !env.CARD_PROJECT_ID || !env.CARD_STORAGE_BUCKET) {
    throw new Error('독립 카드 프로젝트와 버킷을 명시해야 합니다.');
  }
  // 기존 서비스의 기본 DB·버킷·인증 구현을 가져오지 않는다.
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');
  const app = initializeApp({ projectId: env.CARD_PROJECT_ID, storageBucket: env.CARD_STORAGE_BUCKET });
  return {
    db: getFirestore(app, env.CARD_DATABASE_ID || '(default)'),
    resources: { getBucket: () => getStorage(app).bucket(),
      isEmulator: () => !!env.FIREBASE_STORAGE_EMULATOR_HOST,
      getStorageEmulatorBaseUrl: () => `http://${env.CARD_STORAGE_PUBLIC_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST}` },
  };
}
module.exports = { createBackend };
