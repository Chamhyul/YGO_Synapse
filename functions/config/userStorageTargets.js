'use strict';

// 운영 RTDB는 아직 선택·생성하지 않았다. 실제 프로젝트 소속·위치·정확한 URL을
// 별도로 확인하고 승인한 대상만 코드 검토를 거쳐 등록한다. 환경변수는 등록을 대신하지 않는다.
// 항목: { id, projectId, instanceId, location, databaseURL, writerRunId }
// writerRunId는 같은 DB의 모든 함수/관리 도구가 공유하는 고정 전환 ID다.
const PRODUCTION_TARGETS = Object.freeze([]);

module.exports = { PRODUCTION_TARGETS };
