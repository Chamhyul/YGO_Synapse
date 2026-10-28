'use strict';
const { decodeKey, encodeKey } = require('./user-storage/codec');
const unavailable = () => Object.assign(new Error('인벤토리 조회 복사본의 실행 대상을 확인할 수 없습니다.'), { code: 'INVENTORY_READ_SNAPSHOT_UNAVAILABLE' });
function selectInventorySnapshotRuntime() {
  const config = require('../config/userProfileWriter').resolveProfileWriterConfig();
  if (config.mode !== 'production') throw unavailable();
  const binding = require('./userWriterSelection').selectProductionWriter();
  if (binding.transition?.runId !== config.runId || typeof binding.rebuildInventoryReadSnapshot !== 'function') throw unavailable();
  return { config, binding };
}
function createInventorySnapshotWorker({ select = selectInventorySnapshotRuntime } = {}) {
  return async event => {
    const { config, binding } = select();
    if (event.instance !== config.instanceId || event.location !== config.location) throw unavailable();
    if (event.params?.runKey && event.params.runKey !== encodeKey(config.runId)) return;
    if (event.data.after.val() === null) return;
    let uid;
    try { uid = decodeKey(event.params?.userKey); } catch (_) { throw unavailable(); }
    if (!uid || uid.length > 128 || /[/\u0000-\u001f\u007f]/.test(uid)) throw unavailable();
    // 이벤트 본문의 과거 카드/수량은 사용하지 않는다. 현재 원본에서 재구축하고
    // 파생 경로만 갱신한다. 오류는 영속 이벤트 재배달로 넘기며 원문을 출력하지 않는다.
    try { return await binding.rebuildInventoryReadSnapshot(uid); }
    catch (_) { throw unavailable(); }
  };
}
module.exports = { createInventorySnapshotWorker, selectInventorySnapshotRuntime };
