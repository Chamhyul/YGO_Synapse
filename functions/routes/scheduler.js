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

/**
 * [관리자 전용] 기존 cards 컬렉션의 모든 문서를 순회하여 info 내부의 카드 번호들을 수집 후
 * numbers 배열 필드로 Firestore 문서 일괄 갱신 마이그레이션 함수
 */
exports.migrateCardNumbersField = onRequest({ invoker: "public", memory: "1GiB", timeoutSeconds: 540 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const isAdmin = await verifyUser(req, res);
  if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden: 관리자 권한이 필요합니다." });

  try {
    const snapshot = await db.collection("cards").get();
    let updatedCount = 0;
    const totalDocs = snapshot.size;
    let batch = db.batch();
    let countInBatch = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const info = data.info || {};
      const numbersSet = new Set();

      Object.keys(info).forEach(k => {
        const idx = parseInt(k, 10);
        if (!isNaN(idx) && idx < 10) {
          const langArr = info[k];
          if (Array.isArray(langArr) && langArr[2] && typeof langArr[2] === 'object') {
            Object.keys(langArr[2]).forEach(no => {
              if (no && typeof no === 'string') {
                numbersSet.add(no.trim().toUpperCase());
              }
            });
          }
        }
      });

      if (numbersSet.size > 0) {
        const numbersArr = Array.from(numbersSet);
        batch.set(doc.ref, {
          numbers: FieldValue.arrayUnion(...numbersArr),
          updatedAt: Date.now()
        }, { merge: true });

        countInBatch++;
        updatedCount++;

        if (countInBatch >= 400) {
          await batch.commit();
          batch = db.batch();
          countInBatch = 0;
        }
      }
    }

    if (countInBatch > 0) {
      await batch.commit();
    }

    return res.json({
      success: true,
      message: `총 ${totalDocs}개 카드 문서 중 ${updatedCount}개 문서의 numbers 필드 마이그레이션 완료.`,
      updatedCount,
      totalDocs
    });
  } catch (e) {
    console.error("migrateCardNumbersField error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});






