'use strict';
const { createHash } = require('node:crypto');
const { measure } = require('./inventoryRequestTiming');
const { canReuseSyncMigration, inventorySyncMigration } = require('./user-storage/inventoryApiSummary');
const validToken = value => typeof value === 'string' && /^i1:[a-f0-9]{64}$/.test(value);
const stable = (a, b) => a.backend === b.backend && a.epoch === b.epoch
  && a.phase === 'accepting' && b.phase === 'accepting';
function snapshotToken(uid, writer, record) {
  if (writer.backend !== 'rtdb' || writer.phase !== 'accepting' || !record.exists
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !Number.isSafeInteger(record.generation) || record.generation < 0) return;
  return 'i1:' + createHash('sha256').update(JSON.stringify([
    'inventory-sync-v3', uid, writer.backend, writer.epoch, record.revision, record.generation,
  ])).digest('hex');
}
function createInventorySyncReader({ route, metadata, snapshot, migrationStatus, now = Date.now }) {
  return async (uid, knownToken) => {
    const writer = await route();
    // legacy·전환 중에는 기존 전체 조회/이관/복구 경로를 사용한다.
    if (writer.backend !== 'rtdb' || writer.phase !== 'accepting') return;
    if (validToken(knownToken)) {
      const current = await measure('inventory.sync_head', () => metadata(uid));
      if (current.storageFormat === 'parts' && canReuseSyncMigration(current.syncMigration, now()) && snapshotToken(uid, writer, current) === knownToken) {
        if (!stable(writer, await route())) throw Object.assign(new Error('인벤토리 조회 경계가 변경되었습니다.'), { code: 'WRITER_FENCED' });
        // 전환 상태 조회를 기다리는 사이 기한이 도래했어도 전체 준비를 수행한다.
        if (canReuseSyncMigration(current.syncMigration, now()))
          return measure('inventory.sync_unchanged', () => ({ unchanged: true, token: knownToken }));
      }
    }
    const record = await measure('inventory.sync_full', () => snapshot(uid, writer)), data = record.value;
    if (!stable(writer, await route())) throw Object.assign(new Error('인벤토리 조회 경계가 변경되었습니다.'), { code: 'WRITER_FENCED' });
    const migration = data ? migrationStatus(data) : undefined;
    // null CID도 검증된 재확인 기한 전까지 재사용한다. 요청 본문의 기한은
    // 받지 않으며 다음 요청의 DB 메타정보와 서버 시계로 만료를 다시 판단한다.
    const complete = data?.version === 3 && migration?.status === 'complete' && canReuseSyncMigration(inventorySyncMigration(data), now())
      && !Array.isArray(data.locations) && !Array.isArray(data.rarities);
    return { data, ...(complete ? { token: snapshotToken(uid, writer, record) } : {}) };
  };
}
module.exports = { createInventorySyncReader, snapshotToken, validToken };
