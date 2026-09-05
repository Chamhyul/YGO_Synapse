const { db, FieldPath } = require('../config/firebase');
const { getFunctions } = require('firebase-admin/functions');

const BATCH_SIZE = 1;
const STALE_AFTER_MS = 10 * 60 * 1000;
const LOCALES = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
const STATE_DOC = db.collection('system').doc('cardIllustrationsMigration');

function extractIllustrationIds(html) {
  const start = String(html || '').search(/<div\b[^>]*\bid=["']thumbnail["'][^>]*>/i);
  if (start < 0) return null;
  const end = html.indexOf('</div>', start);
  if (end < 0) return null;
  const thumbnail = html.slice(start, end);
  const ids = [];
  for (const match of thumbnail.matchAll(/(?:[?&](?:amp;)?)ciid=(\d+)|thumbnail_card_image_(\d+)/gi)) {
    const id = Number(match[1] || match[2]);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

async function fetchIllustrationIds(cid, locale) {
  try {
    const url = `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=${encodeURIComponent(cid)}&request_locale=${locale}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': locale },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { status: 'notReleased' };
    if (response.status === 429 || response.status >= 500) return { status: 'retryableError', httpStatus: response.status };
    if (!response.ok) return { status: 'notReleased', httpStatus: response.status };
    const html = await response.text();
    if (!/id=["']cardname["']/i.test(html)) return { status: 'notReleased' };
    const ids = extractIllustrationIds(html);
    return ids && ids.length ? { status: 'success', ids } : { status: 'parseError' };
  } catch (error) {
    return { status: 'retryableError', error: error.name || error.message };
  }
}

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
  let activeRunId = runId;
  let resumed = false;
  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(STATE_DOC);
      const state = snapshot.exists ? snapshot.data() : null;
      if (state?.status === 'running') {
        if (Date.now() - Number(state.lastUpdatedAt || 0) < STALE_AFTER_MS) throw new Error('MIGRATION_ALREADY_RUNNING');
        activeRunId = state.runId;
        resumed = true;
        transaction.set(STATE_DOC, { batchSize: BATCH_SIZE, lastUpdatedAt: Date.now(), lastError: null }, { merge: true });
        return;
      }
      transaction.set(STATE_DOC, {
        status: 'running', runId, batchSize: BATCH_SIZE, lastDocId: null,
        processedCount: 0, updatedCount: 0, failedCount: 0,
        startedAt: Date.now(), lastUpdatedAt: Date.now(), completedAt: null,
        lastError: null,
      });
    });
    await enqueue(activeRunId);
    return { httpStatus: 202, success: true, status: 'running', runId: activeRunId, resumed,
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
  const existingInfo = cardDoc.data().info || {};
  const info = {};
  const failedLocales = [];

  for (let index = 0; index < LOCALES.length; index++) {
    const locale = LOCALES[index];
    const result = await fetchIllustrationIds(cardDoc.id, locale);
    if (result.status !== 'success') {
      if (result.status !== 'notReleased') failedLocales.push({ locale, status: result.status });
      continue;
    }
    const langInfo = existingInfo[index] || existingInfo[String(index)];
    if (!Array.isArray(langInfo) || !langInfo[0]) continue;
    info[index] = langInfo.slice();
    info[index][1] = result.ids;
  }

  if (!Object.keys(info).length) {
    throw new Error(`갱신 가능한 언어 없음: ${failedLocales.map(item => item.locale).join(',')}`);
  }
  return { info, failedLocales };
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
    return;
  }

  let updated = 0;
  let failed = 0;
  let lastError = null;
  for (const cardDoc of snapshot.docs) {
    try {
      const result = await recrawlCardIllustrations(cardDoc);
      const updates = { updatedAt: Date.now() };
      for (const [index, slot] of Object.entries(result.info)) updates[`info.${index}`] = slot;
      await cardDoc.ref.update(updates);
      updated++;
      if (result.failedLocales.length) {
        console.warn(`[CardIllustrationsMigration] ${cardDoc.id} 일부 언어 실패: ${JSON.stringify(result.failedLocales)}`);
      }
    } catch (error) {
      failed++;
      lastError = `${cardDoc.id}: ${error.message || error}`;
      console.error('[CardIllustrationsMigration]', lastError);
    }
  }
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

module.exports = { BATCH_SIZE, LOCALES, extractIllustrationIds, fetchIllustrationIds,
  startCardIllustrationsMigration, processCardIllustrationsMigration, recrawlCardIllustrations };
