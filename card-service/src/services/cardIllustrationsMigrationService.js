const { db, FieldPath } = require('../config/firebase');
const { getFunctions } = require('firebase-admin/functions');
const { toStoredInfo, toRuntimeInfo } = require('../utils/cardSchema');

const BATCH_SIZE = 1;
const STALE_AFTER_MS = 10 * 60 * 1000;
const LOCALES = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
const LANGUAGE_NAMES = ['한국어', '일본어', '아시아 영어', '중국어', '영어', '독일어', '프랑스어', '이탈리아어', '스페인어', '포르투갈어'];
const STATE_DOC = db.collection('system').doc('cardIllustrationsMigration');

function logProgress(event, details = {}) {
  const counts = `누적 ${details.processedCount || 0}장 처리 / 저장 ${details.updatedCount || 0}장 / 실패 ${details.failedCount || 0}장`;
  const messages = {
    start_requested: '일러스트 마이그레이션 시작 요청을 받았습니다.',
    run_created: 'cards 컬렉션의 첫 문서부터 문서 구조 변환과 일러스트 수집을 시작합니다.',
    run_resumed: '저장된 마지막 처리 위치부터 일러스트 수집을 재개합니다.',
    task_enqueued: '다음 카드 처리 작업을 큐에 등록했습니다.',
    task_received: '카드 처리 작업이 실행되었습니다. 진행 상태를 읽습니다.',
    task_ignored: `작업을 건너뜁니다. 현재 상태: ${details.stateStatus || '상태 문서 없음'}, 실행 ID 일치 여부: ${details.runId === details.stateRunId}`,
    batch_loaded: `문서 조회 완료: ${details.documentIds?.map(id => `cards/${id}`).join(', ') || '남은 문서 없음'} (이전 처리 문서: ${details.afterDocId || '없음'})`,
    card_started: `문서 cards/${details.cid} «${details.cardName}» 처리 시작 — ${details.ordinal}번째 카드`,
    card_crawled: `문서 cards/${details.cid} 언어별 조회 완료. DB 저장을 시작합니다.`,
    card_updated: `문서 cards/${details.cid} 새 구조(schemaVersion 2) 저장 완료 — 일러스트 갱신: ${details.updatedLanguageIndexes?.map(index => LANGUAGE_NAMES[index]).join(', ') || '해당 언어 없음'}`,
    card_failed: `문서 cards/${details.cid} 처리 실패 — ${details.error}`,
    checkpoint_saved: `${counts}. 마지막 처리 문서: cards/${details.lastDocId}. 진행 위치를 저장했습니다.`,
    run_completed: `일러스트 마이그레이션 순회 완료 — ${counts}`,
  };
  console.info(`[일러스트 마이그레이션] ${messages[event] || event} (실행 ID: ${details.runId || details.requestedRunId || '없음'})`);
}

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
  logProgress('task_enqueued', { runId });
}

async function startCardIllustrationsMigration() {
  const runId = String(Date.now());
  let activeRunId = runId;
  let resumed = false;
  try {
    logProgress('start_requested', { requestedRunId: runId });
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(STATE_DOC);
      const state = snapshot.exists ? snapshot.data() : null;
      if (state?.targetSchemaVersion === 2 && ['running', 'failed'].includes(state.status)) {
        if (state.status === 'running' && Date.now() - Number(state.lastUpdatedAt || 0) < STALE_AFTER_MS) throw new Error('MIGRATION_ALREADY_RUNNING');
        activeRunId = state.runId;
        resumed = true;
        transaction.set(STATE_DOC, { status: 'running', batchSize: BATCH_SIZE, lastUpdatedAt: Date.now(), lastError: null }, { merge: true });
        return;
      }
      transaction.set(STATE_DOC, {
        status: 'running', runId, targetSchemaVersion: 2, batchSize: BATCH_SIZE, lastDocId: null,
        processedCount: 0, updatedCount: 0, failedCount: 0,
        startedAt: Date.now(), lastUpdatedAt: Date.now(), completedAt: null,
        lastError: null,
      });
    });
    logProgress(resumed ? 'run_resumed' : 'run_created', { runId: activeRunId, batchSize: BATCH_SIZE });
    await enqueue(activeRunId);
    return { httpStatus: 202, success: true, status: 'running', runId: activeRunId, resumed,
      batchSize: BATCH_SIZE, message: `문서 구조 변환과 일러스트 재크롤링을 시작했습니다. 카드 ${BATCH_SIZE}개씩 순차 처리합니다.` };
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
  const existingInfo = toRuntimeInfo(cardDoc.data().info);
  const info = {};
  const failedLocales = [];
  const localeResults = [];

  for (let index = 0; index < LOCALES.length; index++) {
    const locale = LOCALES[index];
    const label = `[일러스트 마이그레이션] cards/${cardDoc.id} · ${LANGUAGE_NAMES[index]}`;
    console.info(`${label} — 공식 페이지 조회 중`);
    const result = await fetchIllustrationIds(cardDoc.id, locale);
    localeResults.push({ locale, status: result.status, illustrationCount: result.ids?.length || 0 });
    if (result.status !== 'success') {
      const reason = result.status === 'notReleased' ? '해당 언어 카드 페이지를 확인하지 못함'
        : result.status === 'parseError' ? '페이지에서 일러스트 번호를 추출하지 못함'
          : `요청 실패 (${result.httpStatus || result.error || '네트워크 오류'})`;
      console.warn(`${label} — ${reason}. 기존 DB 값을 유지합니다.`);
      if (existingInfo[index]?.[0] || result.status !== 'notReleased') failedLocales.push({ locale, status: result.status });
      continue;
    }
    const langInfo = existingInfo[index] || existingInfo[String(index)];
    if (!Array.isArray(langInfo) || !langInfo[0]) {
      console.warn(`${label} — ciid [${result.ids.join(', ')}] 확인. 기존 언어 정보가 없어 저장에서 제외합니다.`);
      continue;
    }
    console.info(`${label} — ciid ${JSON.stringify(langInfo[1])} → [${result.ids.join(', ')}] (${result.ids.length}종), 저장 예정`);
    info[index] = langInfo.slice();
    info[index][1] = result.ids;
  }

  return { info, failedLocales, localeResults };
}

async function processCardIllustrationsMigration(data) {
  const runId = data?.runId;
  logProgress('task_received', { runId: runId || null });
  const stateSnapshot = await STATE_DOC.get();
  const state = stateSnapshot.exists ? stateSnapshot.data() : null;
  if (!runId || !state || state.targetSchemaVersion !== 2 || state.status !== 'running' || state.runId !== runId) {
    logProgress('task_ignored', {
      runId: runId || null,
      stateExists: Boolean(state),
      stateRunId: state?.runId || null,
      stateStatus: state?.status || null,
    });
    return;
  }

  let query = db.collection('cards').orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
  if (state.lastDocId) query = query.startAfter(state.lastDocId);
  const snapshot = await query.get();
  logProgress('batch_loaded', {
    runId,
    afterDocId: state.lastDocId || null,
    documentCount: snapshot.size,
    documentIds: snapshot.docs.map(doc => doc.id),
  });
  if (snapshot.empty) {
    await STATE_DOC.set({ status: 'completed', completedAt: Date.now(),
      lastUpdatedAt: Date.now() }, { merge: true });
    logProgress('run_completed', {
      runId,
      processedCount: state.processedCount || 0,
      updatedCount: state.updatedCount || 0,
      failedCount: state.failedCount || 0,
    });
    return;
  }

  let updated = 0;
  let failed = 0;
  let lastError = null;
  for (const cardDoc of snapshot.docs) {
    try {
      const cardInfo = toRuntimeInfo(cardDoc.data().info);
      const cardName = cardInfo[0]?.[0] || Object.values(cardInfo).find(slot => Array.isArray(slot) && slot[0])?.[0] || '이름 없음';
      logProgress('card_started', { runId, cid: cardDoc.id, cardName, ordinal: (state.processedCount || 0) + updated + failed + 1 });
      const result = await recrawlCardIllustrations(cardDoc);
      logProgress('card_crawled', { runId, cid: cardDoc.id, locales: result.localeResults });
      if (result.failedLocales.length) throw new Error(`언어 수집 실패: ${result.failedLocales.map(item => `${item.locale} (${item.status})`).join(', ')}`);
      // 네트워크 대기 중 일반 크롤러가 저장한 이름/팩/효과를 보존합니다.
      // info 전체를 교체해야 기존 숫자 키가 DB에서 제거됩니다.
      await db.runTransaction(async transaction => {
        const latest = await transaction.get(cardDoc.ref);
        if (!latest.exists) throw new Error('처리 중 카드 문서가 삭제되었습니다.');
        const storedInfo = toStoredInfo(latest.data().info);
        for (const [index, slot] of Object.entries(result.info)) {
          if (storedInfo[LOCALES[index]]) storedInfo[LOCALES[index]].ciid = slot[1];
        }
        transaction.update(cardDoc.ref, { info: storedInfo, schemaVersion: 2, updatedAt: Date.now() });
      });
      updated++;
      logProgress('card_updated', {
        runId,
        cid: cardDoc.id,
        updatedLanguageIndexes: Object.keys(result.info),
      });
      if (result.failedLocales.length) {
        console.warn(`[CardIllustrationsMigration] ${cardDoc.id} 일부 언어 실패: ${JSON.stringify(result.failedLocales)}`);
      }
    } catch (error) {
      failed++;
      lastError = `${cardDoc.id}: ${error.message || error}`;
      console.error('[CardIllustrationsMigration]', lastError);
      logProgress('card_failed', { runId, cid: cardDoc.id, error: error.message || String(error) });
      await STATE_DOC.set({ status: 'failed', failedDocId: cardDoc.id, lastError,
        lastUpdatedAt: Date.now() }, { merge: true });
      console.error(`[일러스트 마이그레이션] cards/${cardDoc.id}에서 중단했습니다. 커서를 이동하지 않았습니다. 다시 시작하면 이 문서부터 재시도합니다.`);
      return;
    }
  }
  const lastDocId = snapshot.docs[snapshot.docs.length - 1].id;
  await STATE_DOC.set({
    lastDocId,
    processedCount: (state.processedCount || 0) + snapshot.size,
    updatedCount: (state.updatedCount || 0) + updated,
    failedCount: (state.failedCount || 0) + failed,
    lastBatchProcessed: snapshot.size, lastBatchUpdated: updated,
    lastUpdatedAt: Date.now(), lastError, failedDocId: null,
  }, { merge: true });
  logProgress('checkpoint_saved', {
    runId,
    lastDocId,
    processedCount: (state.processedCount || 0) + snapshot.size,
    updatedCount: (state.updatedCount || 0) + updated,
    failedCount: (state.failedCount || 0) + failed,
  });
  await enqueue(runId);
}

module.exports = { BATCH_SIZE, LOCALES, extractIllustrationIds, fetchIllustrationIds,
  startCardIllustrationsMigration, processCardIllustrationsMigration, recrawlCardIllustrations };
