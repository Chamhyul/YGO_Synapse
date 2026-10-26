'use strict';
const { createRecordStore } = require('./user-storage/recordStore');
const { fingerprint } = require('./userMigrationRehearsal');
const fail = () => Object.assign(new Error('멤버십 영수증 보관 진행점을 대조해야 합니다.'), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
function createMembershipReceiptMaintenance({ database, runId, archivePage, timeoutMs, onAmbiguousWrite, clock = Date.now }) {
  const progress = createRecordStore({ database, path: 'membershipReceiptArchiveProgress', timeoutMs, onAmbiguousWrite });
  return async ({ limit = 32 } = {}) => {
    const before = (await progress.read(runId)).value;
    if (before && (before.format !== 1 || Object.keys(before).sort().join(',') !== 'completedAt,cursor,format'
        || !Number.isSafeInteger(before.completedAt) || before.completedAt < 0
        || before.cursor !== null && !/^[a-f0-9]{32}$/.test(before.cursor))) throw fail();
    // 신규 기록은 compact의 확정 훅이 처리한다. 구형 도구의 누락을 보충하는
    // 전체 순회는 완료 후 하루에 한 번만 하며 분마다 전체 이력을 읽지 않는다.
    const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw fail();
    if (before?.cursor === null && now - before.completedAt < 86400000) return { scanned: 0, moved: 0, complete: true };
    const result = await archivePage({ ...(before?.cursor ? { cursor: before.cursor } : {}), limit, apply: true });
    await progress.update(runId, current => {
      if (fingerprint(current ?? null) !== fingerprint(before ?? null)) throw fail();
      return { value: { format: 1, cursor: result.cursor, completedAt: result.cursor ? before?.completedAt ?? 0 : now } };
    });
    return { scanned: result.scanned, moved: result.moved, complete: result.cursor === null };
  };
}
module.exports = { createMembershipReceiptMaintenance };
