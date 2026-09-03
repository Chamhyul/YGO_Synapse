const { onSchedule } = require('firebase-functions/v2/scheduler');
const { ensureCardIndexWorker } = require('../services/cardIndexDispatchService');

// 정상 처리는 카드 저장 직후 Tasks로 시작합니다.
// 이 예약 함수는 제출 실패·비정상 종료로 남은 대기열만 복구하며 JSON을 직접 갱신하지 않습니다.
exports.processCardIndexUpdates = onSchedule({
  schedule: 'every 5 minutes', timeZone: 'Asia/Seoul',
  memory: '256MiB', timeoutSeconds: 60, maxInstances: 1,
}, async () => {
  console.log('[CardIndexes] 대기열 복구 확인', await ensureCardIndexWorker());
});
