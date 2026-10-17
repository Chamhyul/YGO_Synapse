const { processPendingCardIndexes } = require('./cardIndexService');
const { claimCardIndexTask, finishCardIndexTask, retryCardIndexTask } = require('./cardIndexDispatchService');

// 최초 직접 실행 또는 후속 Tasks가 현재 대기분을 처리합니다. 처리 중 새 대기분이
// 생기면 다음 Tasks를 예약하고, 대기열이 비면 idle로 바꾼 뒤 종료합니다.
async function runCardIndexTask(runId) {
  if (!(await claimCardIndexTask(runId))) return { success: true, superseded: true };
  try {
    const result = await processPendingCardIndexes();
    if (result.busy) throw new Error('다른 카드 목록 작업 진행 중. 대기 기록을 유지합니다.');
    const continuation = await finishCardIndexTask(runId);
    console.log('[CardManifest]', { ...result, ...continuation });
    return { ...result, ...continuation };
  } catch (error) {
    await retryCardIndexTask(runId, error);
    throw error;
  }
}

module.exports = { runCardIndexTask };
