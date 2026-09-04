const { db, FieldPath, FieldValue } = require('../config/firebase');
const { getFunctions } = require('firebase-admin/functions');
const { crawlCardInPack, LOCALE_TO_INDEX } = require('../scrapers/cardScraper');
const { stageCardWrite } = require('./cardWriteService');
const { requestCardIndexWork } = require('./cardIndexDispatchService');

// 상세 HTML은 크기가 크므로 한 Task에서 소수의 카드만 순차 처리합니다.
const BATCH_SIZE = 2;
const LOCALES = Object.keys(LOCALE_TO_INDEX);
const STATE_DOC = db.collection('system').doc('cardIllustrationsMigration');

async function enqueue(runId) {
  const queue = getFunctions().taskQueue(
    'locations/asia-northeast3/functions/migrateCardIllustrationsTask'
  );
  await queue.enqueue(
    { runId },
    { id: `card-illustrations-migration-${runId}-${Date.now()}` }
  );
}

async function startCardIllustrationsMigration() {
  const runId = String(Date.now());
  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(STATE_DOC);
      if (snapshot.exists && snapshot.data().status === 'running') {
        throw new Error('MIGRATION_ALREADY_RUNNING');
      }
      transaction.set(STATE_DOC, {
        status: 'running', runId, batchSize: BATCH_SIZE, lastDocId: null,
        processedCount: 0, updatedCount: 0, failedCount: 0,
        startedAt: Date.now(), lastUpdatedAt: Date.now(), completedAt: null,
        lastError: null,
      });
    });
    await enqueue(runId);
    return { httpStatus: 202, success: true, status: 'running', runId,
      batchSize: BATCH_SIZE, message: `일러스트 재크롤링을 시작했습니다. 카드 ${BATCH_SIZE}개씩 순차 처리합니다.` };
  } catch (error) {
    if (error.message === 'MIGRATION_ALREADY_RUNNING') {
      return { httpStatus: 409, success: false, message: '이미 일러스트 마이그레이션이 진행 중입니다.' };
    }
    await STATE_DOC.set({ status: 'failed', lastError: error.message || String(error),
      lastUpdatedAt: Date.now() }, { merge: true }).catch(() => {});
    throw error;
  }
}

async function recrawlCardIllustrations(cardDoc) {
  const info = {};
  const names = new Set();
  const numbers = new Set();
  const failedLocales = [];

  // 언어별 HTML을 동시에 보관하지 않도록 반드시 순차 호출합니다.
  for (const locale of LOCALES) {
    const result = await crawlCardInPack(cardDoc.id, locale);
    if (!result || result.isError) {
      failedLocales.push(locale);
      continue;
    }
    const index = LOCALE_TO_INDEX[locale];
    const langInfo = result.mergedInfoSlot?.[index];
    if (!Array.isArray(langInfo) || !langInfo[0]) continue;
    info[index] = langInfo;
    names.add(langInfo[0]);
    Object.keys(langInfo[2] || {}).forEach(number => numbers.add(String(number).trim().toUpperCase()));
  }

  if (!Object.keys(info).length) {
    throw new Error(`모든 언어 크롤링 실패: ${failedLocales.join(',')}`);
  }
  return { info, names: [...names], numbers: [...numbers], failedLocales };
}

async function processCardIllustrationsMigration(data) {
  const runId = data?.runId;
  const stateSnapshot = await STATE_DOC.get();
  const state = stateSnapshot.exists ? stateSnapshot.data() : null;
  if (!runId || !state || state.status !== 'running' || state.runId !== runId) return;

  let query = db.collection('cards').orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
  if (state.lastDocId) query = query.startAfter(state.lastDocId);
  const snapshot = await query.get();
  if (snapshot.empty) {
    await STATE_DOC.set({ status: 'completed', completedAt: Date.now(),
      lastUpdatedAt: Date.now() }, { merge: true });
    await requestCardIndexWork();
    return;
  }

  const batch = db.batch();
  let updated = 0;
  let failed = 0;
  let lastError = null;
  for (const cardDoc of snapshot.docs) {
    try {
      const result = await recrawlCardIllustrations(cardDoc);
      const payload = { info: result.info, updatedAt: Date.now() };
      if (result.names.length) payload.names = FieldValue.arrayUnion(...result.names);
      if (result.numbers.length) payload.numbers = FieldValue.arrayUnion(...result.numbers);
      stageCardWrite(batch, cardDoc.id, payload);
      updated++;
      if (result.failedLocales.length) {
        console.warn(`[CardIllustrationsMigration] ${cardDoc.id} 일부 언어 실패: ${result.failedLocales.join(',')}`);
      }
    } catch (error) {
      failed++;
      lastError = `${cardDoc.id}: ${error.message || error}`;
      console.error('[CardIllustrationsMigration]', lastError);
    }
  }
  if (updated) await batch.commit();

  const lastDocId = snapshot.docs[snapshot.docs.length - 1].id;
  await STATE_DOC.set({
    lastDocId,
    processedCount: (state.processedCount || 0) + snapshot.size,
    updatedCount: (state.updatedCount || 0) + updated,
    failedCount: (state.failedCount || 0) + failed,
    lastBatchProcessed: snapshot.size, lastBatchUpdated: updated,
    lastUpdatedAt: Date.now(), lastError,
  }, { merge: true });
  await enqueue(runId);
}

module.exports = { BATCH_SIZE, LOCALES, startCardIllustrationsMigration,
  processCardIllustrationsMigration, recrawlCardIllustrations };
