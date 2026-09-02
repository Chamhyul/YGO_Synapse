/**
 * scheduler.js
 * 자동 크롤링 스케줄 트리거 + 수동 HTTP 엔드포인트 + Cloud Tasks 핸들러
 *
 * 스케줄:
 *  - autoCrawlFull:  매일 04:00 KST → 10개 언어 전체 스캔
 *  - autoCrawlQuick: 매일 12:00, 22:00 KST → 주요 3개 언어(ko, ja, en)만 스캔
 *
 * 수동 트리거:
 *  - triggerAutoCrawl: HTTP GET/POST → ?locale=ko,ja 또는 ?full=true
 *
 * 재실행 핸들러:
 *  - autoCrawlTask: Cloud Tasks에 의해 호출됨 (5~10분 딜레이 후 자동 실행)
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { getFunctions } = require("firebase-admin/functions");
const { db, admin, FieldValue } = require("../config/firebase");
const { setCors, verifyUser, verifyAppCheck } = require("../utils/auth");
const { runAutoCrawl } = require("../services/autoCrawlerService");

const ALL_LOCALES = ["ko", "ja", "ae", "cn", "en", "de", "fr", "it", "es", "pt"];
const MAIN_LOCALES = ["ko", "ja", "en"];

// ─── 스케줄된 함수 ───

/**
 * 매일 04:00 KST - 10개 언어 전체 스캔
 */
exports.autoCrawlFull = onSchedule({
  schedule: "0 4 * * *",
  timeZone: "Asia/Seoul",
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (event) => {
  console.log("[Scheduler] 전체 언어 자동 크롤링 시작 (04:00 KST)");
  const result = await runAutoCrawl(ALL_LOCALES);
  console.log("[Scheduler] 전체 언어 크롤링 결과:", JSON.stringify(result));
});

/**
 * 매일 12:00, 22:00 KST - 주요 3개 언어만 스캔
 */
exports.autoCrawlQuick = onSchedule({
  schedule: "0 12,22 * * *",
  timeZone: "Asia/Seoul",
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (event) => {
  console.log("[Scheduler] 주요 언어 자동 크롤링 시작 (12:00/22:00 KST)");
  const result = await runAutoCrawl(MAIN_LOCALES);
  console.log("[Scheduler] 주요 언어 크롤링 결과:", JSON.stringify(result));
});

// ─── Cloud Tasks 핸들러 (재실행용) ───

/**
 * autoCrawlerService에서 미처리 팩이 남아있을 때 Cloud Tasks로 예약되어 호출됨
 * 5~10분 랜덤 딜레이 후 자동 실행
 */
exports.autoCrawlTask = onTaskDispatched({
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 60,
  },
  rateLimits: {
    maxConcurrentDispatches: 1,
  },
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (req) => {
  const { locales = MAIN_LOCALES, epoch } = req.data;

  // ─── 세션 검증 (Epoch Check) ───
  // 새로운 스케줄러나 수동 크롤링이 시작되면 system/crawler의 currentEpoch가 갱신됨
  // 전달받은 epoch가 현재 최신 세션과 다르면 구식 작업으로 보고 즉시 종료
  const statusDoc = await db.collection("system").doc("crawler").get();
  const currentEpoch = statusDoc.exists ? statusDoc.data().currentEpoch : null;

  if (!epoch || epoch !== currentEpoch) {
    console.log(`[TaskQueue] 구식 세션 감지 (전달 Epoch: ${epoch}, 최신 Epoch: ${currentEpoch}). 작업을 취소합니다.`);
    return;
  }

  console.log(`[TaskQueue] 자동 크롤링 재실행 (언어: ${locales.join(", ")}, Epoch: ${epoch})`);
  const result = await runAutoCrawl(locales);
  console.log("[TaskQueue] 크롤링 결과:", JSON.stringify(result));
});

// ─── 수동 트리거 HTTP 엔드포인트 ───

/**
 * 관리자가 수동으로 호출 가능한 HTTP 엔드포인트
 *
 * 사용법:
 *  - 주요 3개 언어: GET /triggerAutoCrawl
 *  - 특정 언어 지정: GET /triggerAutoCrawl?locale=ko
 *  - 복수 언어 지정: GET /triggerAutoCrawl?locale=ko,ja,en
 *  - 전체 10개 언어: GET /triggerAutoCrawl?full=true
 *  - 중지 명령: GET /triggerAutoCrawl?action=stop
 *  - 강제 실행: GET /triggerAutoCrawl?force=true
 */
exports.triggerAutoCrawl = onRequest({
  invoker: "public",
  memory: "1GiB",
  timeoutSeconds: 540,
  region: "asia-northeast3",
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  // 관리자 권한 검증 (Custom Claims)
  const uid = await verifyUser(req, res);
  if (!uid) return;

  let isAdmin = false;
  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    if (claims.admin === true || claims.role === "owner" || claims.role === "admin") {
      isAdmin = true;
    }
  } catch (e) {
    console.error("Scheduler auth error:", e);
  }

  if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden: 관리자 권한이 필요합니다." });

  const { action, locale, full, force } = req.query;

  // 1. 중지 명령 처리
  if (action === "stop") {
    await db.collection("system").doc("crawler").set({
      stopRequest: true,
      stoppedAt: Date.now(),
    }, { merge: true });
    return res.json({ success: true, message: "크롤링 중지 요청이 수신되었습니다. 현재 처리 중인 팩까지만 완료 후 중단됩니다." });
  }

  // 2. 실행 언어 결정
  let locales;
  if (locale) {
    locales = locale.split(",").map(l => l.trim()).filter(Boolean);
  } else if (full === "true") {
    locales = ALL_LOCALES;
  } else {
    locales = MAIN_LOCALES;
  }

  // 3. 실행
  const isForce = force === "true";
  console.log(`[Manual] 수동 자동 크롤링 시작 (언어: ${locales.join(", ")}, 강제실행: ${isForce})`);
  const result = await runAutoCrawl(locales, isForce);

  return res.json({ success: true, ...result });
});

const CARD_NUMBERS_MIGRATION_BATCH_SIZE = 100;
const CARD_NUMBERS_MIGRATION_DOC = db.collection("system").doc("cardNumbersMigration");

function getNumbersFromCardInfo(info) {
  const numbers = new Set();

  for (const [key, langInfo] of Object.entries(info || {})) {
    const localeIndex = Number(key);
    if (!Number.isInteger(localeIndex) || localeIndex < 0 || localeIndex >= 10) continue;
    if (!Array.isArray(langInfo) || !langInfo[2] || typeof langInfo[2] !== "object") continue;

    for (const cardNo of Object.keys(langInfo[2])) {
      const normalized = String(cardNo || "").trim().toUpperCase();
      if (normalized) numbers.add(normalized);
    }
  }

  return numbers;
}

async function enqueueCardNumbersMigration(runId) {
  const queue = getFunctions().taskQueue(
    "locations/asia-northeast3/functions/migrateCardNumbersTask"
  );
  await queue.enqueue(
    { runId },
    { id: `card-numbers-migration-${runId}-${Date.now()}` }
  );
}

/**
 * [관리자 전용] numbers 필드 백필 작업을 시작합니다.
 * 실제 처리는 Cloud Tasks가 문서 ID 순서대로 100개씩 이어서 수행합니다.
 */
exports.migrateCardNumbersField = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed. Use POST." });
  }

  const uid = await verifyUser(req, res);
  if (!uid) return;

  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    const isAdmin = claims.admin === true || claims.role === "owner" || claims.role === "admin";
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden: 관리자 권한이 필요합니다." });
    }
  } catch (e) {
    console.error("Card-number migration authorization error:", e);
    return res.status(403).json({ success: false, message: "Forbidden: 사용자 권한 확인 실패" });
  }

  const runId = String(Date.now());
  try {
    await db.runTransaction(async (transaction) => {
      const stateSnapshot = await transaction.get(CARD_NUMBERS_MIGRATION_DOC);
      const state = stateSnapshot.exists ? stateSnapshot.data() : {};
      if (state.status === "running") {
        throw new Error("MIGRATION_ALREADY_RUNNING");
      }

      transaction.set(CARD_NUMBERS_MIGRATION_DOC, {
        status: "running",
        runId,
        batchSize: CARD_NUMBERS_MIGRATION_BATCH_SIZE,
        lastDocId: null,
        processedCount: 0,
        updatedCount: 0,
        startedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        completedAt: null,
        error: null,
      }, { merge: true });
    });

    await enqueueCardNumbersMigration(runId);
    return res.status(202).json({
      success: true,
      status: "running",
      runId,
      batchSize: CARD_NUMBERS_MIGRATION_BATCH_SIZE,
      message: "카드 번호 마이그레이션을 시작했습니다. Cloud Tasks가 100개씩 자동으로 처리합니다.",
    });
  } catch (e) {
    if (e.message === "MIGRATION_ALREADY_RUNNING") {
      return res.status(409).json({ success: false, message: "이미 카드 번호 마이그레이션이 진행 중입니다." });
    }
    await CARD_NUMBERS_MIGRATION_DOC.set({
      status: "failed",
      error: e.message || String(e),
      lastUpdatedAt: Date.now(),
    }, { merge: true }).catch(() => {});
    console.error("migrateCardNumbersField start error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

/**
 * Cloud Tasks 전용 작업자: cards 문서를 100개씩 순서대로 처리하고 다음 작업을 예약합니다.
 */
exports.migrateCardNumbersTask = onTaskDispatched({
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
  rateLimits: { maxConcurrentDispatches: 1 },
  region: "asia-northeast3",
  memory: "512MiB",
  timeoutSeconds: 120,
}, async (req) => {
  const { runId } = req.data || {};
  const stateSnapshot = await CARD_NUMBERS_MIGRATION_DOC.get();
  const state = stateSnapshot.exists ? stateSnapshot.data() : null;

  if (!runId || !state || state.status !== "running" || state.runId !== runId) {
    console.log(`[CardNumbersMigration] Ignoring stale task for run ${runId || "unknown"}.`);
    return;
  }

  let query = db.collection("cards")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(CARD_NUMBERS_MIGRATION_BATCH_SIZE);
  if (state.lastDocId) query = query.startAfter(state.lastDocId);

  const snapshot = await query.get();
  if (snapshot.empty) {
    await CARD_NUMBERS_MIGRATION_DOC.set({
      status: "completed",
      completedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      error: null,
    }, { merge: true });
    console.log(`[CardNumbersMigration] Completed run ${runId}.`);
    return;
  }

  const batch = db.batch();
  let updatedInBatch = 0;
  for (const cardDoc of snapshot.docs) {
    const derivedNumbers = getNumbersFromCardInfo(cardDoc.data().info);
    const existingNumbers = new Set(
      (Array.isArray(cardDoc.data().numbers) ? cardDoc.data().numbers : [])
        .map(value => String(value).trim().toUpperCase())
    );
    const missingNumbers = Array.from(derivedNumbers).filter(number => !existingNumbers.has(number));

    if (missingNumbers.length > 0) {
      batch.set(cardDoc.ref, {
        numbers: FieldValue.arrayUnion(...missingNumbers),
        updatedAt: Date.now(),
      }, { merge: true });
      updatedInBatch++;
    }
  }
  if (updatedInBatch > 0) await batch.commit();

  const lastDocId = snapshot.docs[snapshot.docs.length - 1].id;
  await CARD_NUMBERS_MIGRATION_DOC.set({
    lastDocId,
    processedCount: (state.processedCount || 0) + snapshot.size,
    updatedCount: (state.updatedCount || 0) + updatedInBatch,
    lastBatchProcessed: snapshot.size,
    lastBatchUpdated: updatedInBatch,
    lastUpdatedAt: Date.now(),
  }, { merge: true });

  await enqueueCardNumbersMigration(runId);
  console.log(`[CardNumbersMigration] Run ${runId}: ${snapshot.size} processed, ${updatedInBatch} updated.`);
});




