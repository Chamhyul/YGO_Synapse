'use strict';

// 실제 등록/제거 인스턴스에서만 동기 준비를 앞당긴다. SDK의 ref/get을 호출하지
// 않으므로 비동기 DB 작업을 응답 밖에 남기거나 배포 탐색 중 운영에 접속하지 않는다.
function prepareUserStorageStartup({ env = process.env,
  select = () => require('./userWriterSelection').selectProductionWriter() } = {}) {
  if (env.NODE_ENV !== 'production' || env.USER_STORAGE_MODE !== 'production'
      || env.USER_PROFILE_WRITER_MODE !== 'production' || !env.K_SERVICE || !env.K_REVISION
      || !['addCards', 'discardCards'].includes(env.FUNCTION_TARGET)) return false;
  try { select(); return true; }
  // 시작 준비 실패를 다른 DB/인증으로 대체하지 않는다. 요청 guard가 설정을 다시
  // 검사하고 기존503을 반환한다. 초기화/경로 조회/미확정 연결 교체는 하지 않는다.
  catch (_) { return false; }
}

module.exports = { prepareUserStorageStartup };
