'use strict';

// 완료된 hot 기록이 영구 대기 목록이다. 성공 응답 뒤 프로세스에 남긴 비동기
// 작업에 의존하지 않고, 매 예약 실행이 실제 journal에서 재개한다.
function createWriterHistoryMaintenanceHandler({
  createRuntime = () => require('./userProfileWriterRuntime').createUserWriterRuntime(),
  clock = Date.now, log = value => console.log(JSON.stringify(value)),
} = {}) {
  return async () => {
    const started = clock(), runtime = createRuntime();
    let passes = 0, moved = 0, removedEvents = 0;
    try {
      const { transition, maintainMembershipReceipts } = runtime.getProfileWriterBinding();
      do {
        // 각 묶음은 새 SDK 조회 범위다. 다른 writer/복구와의 경합은 기존
        // historyVersion/본문 대조/CAS가 보호하고 미확정 작업은 보관하지 않는다.
        const result = await transition.withSession(() => transition.compact({ limit: 4 }));
        passes++; moved += result.moved; removedEvents += result.removedEvents;
        if (!result.moved && !result.removedEvents) break;
      } while (passes < 4 && clock() - started < 45000);
      let nativePages = 0, nativeScanned = 0, nativeMoved = 0;
      if (typeof maintainMembershipReceipts === 'function') {
        while (nativePages < 4 && clock() - started < 45000) {
          const archived = await maintainMembershipReceipts({ limit: 32 });
          nativePages++; nativeScanned += archived.scanned; nativeMoved += archived.moved;
          if (archived.complete) break;
        }
      }
      const result = { event: 'writer_history_maintenance', passes, moved, removedEvents,
        ...(nativePages ? { nativePages, nativeScanned, nativeMoved } : {}), durationMs: clock() - started };
      log(result); return result;
    } catch (error) {
      // 사용자 자료/ID/오류 원문은 로그에 남기지 않는다. 실패는 Scheduler가
      // 재시도하고, 보관 승인 전에 hot을 지우지 않는 기존 계약을 유지한다.
      const code = /^(WRITER_|USER_STORAGE_)[A-Z_]+$/.test(error?.code || '') ? error.code : 'WRITER_MAINTENANCE_FAILED';
      throw Object.assign(new Error(code), { code });
    } finally {
      await runtime.closeProfileWriterRuntime();
    }
  };
}

module.exports = { createWriterHistoryMaintenanceHandler };
