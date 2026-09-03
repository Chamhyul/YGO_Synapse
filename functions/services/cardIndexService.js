const { randomUUID } = require('node:crypto');
const { db, FieldPath } = require('../config/firebase');
const { requestCardIndexWork } = require('./cardIndexDispatchService');
const { PENDING_COLLECTION } = require('./cardWriteService');
const { createCardManifest, addCardToManifest } = require('./cardIndexBuilder');
const { writeCardManifest, readManifestGeneration } = require('../utils/indexStorage');

// 모든 진입점의 최대 실행 시간(540초)보다 길게 유지합니다.
const LEASE_MS = 15 * 60 * 1000;
const ACK_BATCH_SIZE = 100;
const lockRef = () => db.collection('system').doc('cardIndexWriter');
const stateRef = () => db.collection('system').doc('cardIndexState');

async function withIndexLock(operation) {
  const owner = randomUUID();
  const acquired = await db.runTransaction(async tx => {
    const snapshot = await tx.get(lockRef());
    if (snapshot.exists && snapshot.data().expiresAt > Date.now()) return false;
    tx.set(lockRef(), { owner, expiresAt: Date.now() + LEASE_MS, startedAt: Date.now() });
    return true;
  });
  if (!acquired) return { success: false, busy: true };
  const assertLease = async () => {
    const snapshot = await lockRef().get();
    if (!snapshot.exists || snapshot.data().owner !== owner || snapshot.data().expiresAt <= Date.now()) {
      throw new Error('카드 목록 작업 잠금이 만료되었습니다. 대기 기록을 유지합니다.');
    }
  };
  try {
    return await operation(assertLease);
  } finally {
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(lockRef());
      if (snapshot.exists && snapshot.data().owner === owner) tx.delete(lockRef());
    });
  }
}

async function acknowledge(records) {
  await db.runTransaction(async tx => {
    const snapshots = await tx.getAll(...records.map(record => record.ref));
    snapshots.forEach((snapshot, i) => {
      if (snapshot.exists && snapshot.data().version === records[i].data().version) tx.delete(snapshot.ref);
    });
  });
}

// 한 실행 시작 시의 모든 대기 기록을 묶고, DB는 한 번만 순회합니다.
async function publishCardManifest(assertLease) {
  const generation = await readManifestGeneration();
  const manifest = createCardManifest();
  let cursor = null;
  let totalCards = 0;
  while (true) {
    await assertLease();
    let query = db.collection('cards').orderBy(FieldPath.documentId())
      .select('names', 'numbers').limit(500);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    page.docs.forEach(doc => addCardToManifest(manifest, doc.data()));
    totalCards += page.size;
    cursor = page.docs[page.docs.length - 1];
  }
  await assertLease();
  const counts = await writeCardManifest([...manifest.names].sort(), [...manifest.numbers].sort(), generation);
  return { totalCards, ...counts };
}
async function rebuildManifest(force) {
  return withIndexLock(async assertLease => {
    const snapshot = await db.collection(PENDING_COLLECTION).orderBy('queuedAt').get();
    if (!force && snapshot.empty) return { success: true, processed: 0 };
    const result = await publishCardManifest(assertLease);
    for (let start = 0; start < snapshot.docs.length; start += ACK_BATCH_SIZE) {
      await assertLease();
      await acknowledge(snapshot.docs.slice(start, start + ACK_BATCH_SIZE));
    }
    await stateRef().set({ ready: true, schemaVersion: 2, rebuiltAt: Date.now(), ...result }, { merge: true });
    return { success: true, processed: snapshot.size, ...result };
  });
}
const processPendingCardIndexes = () => rebuildManifest(false);
async function rebuildAllCardIndexes() {
  const result = await rebuildManifest(true);
  if (result.success) await requestCardIndexWork();
  return result;
}
const refreshCardManifest = rebuildAllCardIndexes;
module.exports = { processPendingCardIndexes, rebuildAllCardIndexes, refreshCardManifest, withIndexLock, acknowledge };
