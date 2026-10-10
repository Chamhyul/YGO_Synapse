'use strict';

// 저장소는 기존 DB·버킷을 사용한다. 실행 계정의 실제 권한은 IAM에서 별도로 관리한다.
function resolveCardWorkerOptions(env = process.env) {
  const serviceAccount = env.CARD_WORKER_SERVICE_ACCOUNT;
  if (serviceAccount === undefined || serviceAccount === '') return {};
  if (typeof serviceAccount !== 'string'
      || serviceAccount !== serviceAccount.trim()
      || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) {
    throw new Error('CARD_WORKER_SERVICE_ACCOUNT에는 유효한 서비스 계정 이메일이 필요합니다.');
  }
  return { serviceAccount };
}

// 미설정 상태에서는 Firebase의 기존 기본 실행 계정을 유지한다.
const CARD_WORKER_OPTIONS = resolveCardWorkerOptions();
module.exports = { CARD_WORKER_OPTIONS, resolveCardWorkerOptions };
