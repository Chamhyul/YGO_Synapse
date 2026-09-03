const { randomUUID } = require('node:crypto');
const { db, admin } = require('../config/firebase');
const { requestCardIndexWork } = require('./cardIndexDispatchService');
const { PENDING_COLLECTION } = require('./cardWriteService');
const { emptyIndexes, applyCardChanges } = require('./cardIndexBuilder');
const { readIndexFile, readIndexGeneration, writeIndexFile, writeCardManifest, readManifestGeneration, invalidateCache } = require('../utils/indexStorage');

// 모든 진입점의 최대 실행 시간(540초)보다 길게 유지합니다.
const LEASE_MS = 15 * 60 * 1000;
const BATCH_SIZE = 100;
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
      throw new Error('인덱스 작업 잠금이 만료되었습니다. 대기 기록을 유지합니다.');
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

async function readIndexes() {
  const files = await Promise.all(['byName', 'byNumber', 'cid'].map(readIndexFile));
  const result = Object.fromEntries(['byName', 'byNumber', 'cid'].map((type, i) => [type, files[i]]));
  result.manifest = { generation: await readManifestGeneration() };
  return result;
}

async function publishIndexes(indexes, files, assertLease) {
  // 실패하면 후속 처리를 멈추고 대기 기록을 보존합니다. 파일 버전이 일치할 때만 저장합니다.
  for (const type of ['byName', 'byNumber', 'cid']) {
    await assertLease();
    await writeIndexFile(type, indexes[type], files[type].generation);
  }
  await assertLease();
  await writeCardManifest(indexes.byName, indexes.byNumber, files.manifest.generation);
  invalidateCache();
}

async function acknowledge(records) {
  await db.runTransaction(async tx => {
    const snapshots = await tx.getAll(...records.map(record => record.ref));
    snapshots.forEach((snapshot, i) => {
      if (snapshot.exists && snapshot.data().version === records[i].data().version) tx.delete(snapshot.ref);
    });
  });
}

async function processPendingCardIndexes() {
  return withIndexLock(async assertLease => {
    const snapshot = await db.collection(PENDING_COLLECTION).orderBy('queuedAt').limit(BATCH_SIZE).get();
    if (snapshot.empty) return { success: true, processed: 0 };
    const cards = await db.getAll(...snapshot.docs.map(doc => db.collection('cards').doc(doc.id)));
    const files = await readIndexes();
    // 없는 파일은 빈 인덱스와 generation 0으로 읽어 최초 저장합니다.
    const indexes = Object.fromEntries(['byName', 'byNumber', 'cid'].map(type => [type, files[type].data]));
    applyCardChanges(indexes, cards.map(card => ({ cid: card.id, data: card.exists ? card.data() : null })));
    await publishIndexes(indexes, files, assertLease);
    await assertLease();
    await acknowledge(snapshot.docs);
    return { success: true, processed: snapshot.size };
  });
}

async function rebuildAllCardIndexes() {
  const result = await withIndexLock(async assertLease => {
    await stateRef().set({ ready: false, rebuildStartedAt: Date.now() }, { merge: true });
    // 대기 기록은 삭제하지 않습니다. 스캔 도중의 변경은 이후 증분 작업이 다시 반영합니다.
    const files = Object.fromEntries(await Promise.all(['byName', 'byNumber', 'cid'].map(async type =>
      [type, { generation: await readIndexGeneration(type) }])));
    files.manifest = { generation: await readManifestGeneration() };
    const indexes = emptyIndexes();
    let cursor = null;
    let totalCards = 0;
    while (true) {
      await assertLease();
      let query = db.collection('cards').orderBy(admin.firestore.FieldPath.documentId()).limit(500);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      applyCardChanges(indexes, page.docs.map(card => ({ cid: card.id, data: card.data() })), { replace: false });
      totalCards += page.size;
      cursor = page.docs[page.docs.length - 1];
    }
    await publishIndexes(indexes, files, assertLease);
    await assertLease();
    await stateRef().set({ ready: true, schemaVersion: 1, rebuiltAt: Date.now(), totalCards }, { merge: true });
    return { success: true, totalCards, nameCount: Object.keys(indexes.byName).length, numberCount: Object.keys(indexes.byNumber).length };
  });
  if (result.success) await requestCardIndexWork();
  return result;
}

async function refreshCardManifest() {
  return withIndexLock(async assertLease => {
    const files = await readIndexes();
    await assertLease();
    return { success: true, ...await writeCardManifest(files.byName.data, files.byNumber.data, files.manifest.generation) };
  });
}

module.exports = { processPendingCardIndexes, rebuildAllCardIndexes, refreshCardManifest, withIndexLock, acknowledge };
