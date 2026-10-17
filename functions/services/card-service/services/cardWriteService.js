const { randomUUID } = require('node:crypto');
const { db, FieldValue } = require('../config/firebase');
const { toStoredInfo } = require('../utils/cardSchema');
const PENDING_COLLECTION = 'pendingCardIndexUpdates';

// DB 전용 계약. 카드와 대기 기록을 한 배치로 저장하며 파일/큐 처리를 수행하지 않는다.
function createCardWriteService({ db, FieldValue, invalidateCardQueries, createVersion = randomUUID }) {
  // 마이그레이션의 배치에도 추가할 수 있도록 commit은 호출자가 담당합니다.
  function stageCardWrite(batch, cid, payload) {
    const id = String(cid);
    const version = createVersion();
    const stored = payload.info ? { ...payload, info: toStoredInfo(payload.info), schemaVersion: 2 } : payload;
    batch.set(db.collection('cards').doc(id), stored, { merge: true });
    batch.set(db.collection(PENDING_COLLECTION).doc(id), {
      version, queuedAt: FieldValue.serverTimestamp(),
    });
    return version;
  }

  async function saveCardAndQueueIndex(cid, payload) {
    const batch = db.batch();
    const version = stageCardWrite(batch, cid, payload);
    await batch.commit();
    invalidateCardQueries(cid);
    return version;
  }

  return { stageCardWrite, saveCardAndQueueIndex };
}
const current = createCardWriteService({ db, FieldValue,
  invalidateCardQueries: cid => require('./cardQueryService').invalidateCardQueries(cid) });
module.exports = { PENDING_COLLECTION, createCardWriteService, ...current };
