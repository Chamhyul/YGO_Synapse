const { processPendingCardIndexes } = require('./cardIndexService');
const { claimCardIndexTask, finishCardIndexTask, retryCardIndexTask } = require('./cardIndexDispatchService');

// 크롤링 요청과 후속 Tasks가 같은 실제 처리 함수를 호출합니다.
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
