'use strict';

// Firebase CLI의 함수 분석 프로세스는 일반 CI 환경변수를 전달하지 않는다.
// CLI가 직접 전달하는 프로젝트 ID로 배포 계정을 선택한다. 이메일은 비밀값이 아니다.
const CARD_WORKER_ACCOUNTS = Object.freeze({
  'ygo-synapse': 'card-worker@ygo-synapse.iam.gserviceaccount.com',
});

function resolveCardWorkerOptions(env = process.env) {
  if (env.FUNCTIONS_EMULATOR === 'true' || env.FIREBASE_EMULATOR_HUB
      || env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST) return {};
  const serviceAccount = Object.hasOwn(CARD_WORKER_ACCOUNTS, env.GCLOUD_PROJECT)
    ? CARD_WORKER_ACCOUNTS[env.GCLOUD_PROJECT] : undefined;
  return serviceAccount ? { serviceAccount } : {};
}

// 로컬 에뮬레이터와 미등록 프로젝트는 기존 기본 동작을 유지한다.
const CARD_WORKER_OPTIONS = resolveCardWorkerOptions();
module.exports = { CARD_WORKER_OPTIONS, resolveCardWorkerOptions };
