const { randomUUID } = require('node:crypto');
const { db, FieldValue } = require('../config/firebase');
const { toStoredInfo } = require('../utils/cardSchema');
const PENDING_COLLECTION = 'pendingCardIndexUpdates';

// 마이그레이션의 배치에도 추가할 수 있도록 commit은 호출자가 담당합니다.
function stageCardWrite(batch, cid, payload) {
  const id = String(cid);
  const version = randomUUID();
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
  require('./cardQueryService').invalidateCardQueries(cid);
  return version;
}

module.exports = { PENDING_COLLECTION, stageCardWrite, saveCardAndQueueIndex };
