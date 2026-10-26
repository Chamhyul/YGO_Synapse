'use strict';
// 검증된 기존 운영 대상의 고정 등록이다. 접속 키·토큰·사용자 데이터가 아니다.
// 환경변수는 이 등록과 일치해야 하며 관리형 런타임·IAM 검사는 별도로 유지한다.
const PRODUCTION_TARGETS = Object.freeze([
  {
    "id": "user-data",
    "projectId": "ygo-synapse",
    "instanceId": "ygo-synapse-default-rtdb",
    "location": "asia-southeast1",
    "databaseURL": "https://ygo-synapse-default-rtdb.asia-southeast1.firebasedatabase.app/",
    "writerRunId": "f7581980072e404fb8f250d377e55097"
  }
].map(Object.freeze));
module.exports = { PRODUCTION_TARGETS };
