const { requestCardIndexWork } = require('./cardIndexDispatchService');
/**
 * autoCrawlerService.js
 * 자동 크롤링 메인 로직 - 점진적 팩/카드 동기화
 *
 * 동작 방식:
 * 1. 공식 사이트에서 전체 팩 목록 스캔
 * 2. Firestore에 없는 신규 PID 필터링
 * 3. 한 번에 1개 팩만 크롤링 (CID 추출 → 카드 상세 → Firestore 저장)
 * 4. 미처리 팩이 2개 이상이면 Cloud Tasks로 5~10분 후 재실행 예약
 */
const { ALL_LOCALES, MAIN_LOCALES } = require("../config/crawler");
const { db } = require("../config/firebase");
const { getFunctions } = require("firebase-admin/functions");
const { getAllPacks, getPackCids, crawlCardInPack, LOCALE_TO_INDEX } = require("../scrapers/cardScraper");
const { saveCardToFirestore } = require("./cardService");
const { downloadPacksMetadata, upsertPackToStorage } = require("../utils/packsStorage");
const { normalizeText } = require("../utils/common");

/**
 * 자동 크롤링 메인 프로세스
 * @param {string[]} locales - 스캔할 언어 목록
 * @param {boolean} force - 잠금 무시 및 강제 실행 여부
 * @returns {Promise<object>} 실행 결과 로그
 */
async function runAutoCrawl(locales, force = false) {
  const log = {
    startedAt: new Date().toISOString(),
    locales,
    phase: "init",
  };

  const statusDocRef = db.collection("system").doc("crawler");
  const queue = getFunctions().taskQueue("locations/asia-northeast3/functions/autoCrawlTask");

  const LOCK_TTL_MS = 30 * 60 * 1000; // 30분 TTL

  try {
    // ── Phase 0: Lock 체크 (트랜잭션 기반 & TTL 만료 검증) ──
    let epoch = Date.now();
    if (!force) {
      await db.runTransaction(async (transaction) => {
        const statusDoc = await transaction.get(statusDocRef);
        const statusData = statusDoc.exists ? statusDoc.data() : { status: "idle" };

        const lastRun = statusData.lastRun || 0;
        const isStaleLock = statusData.status === "running" && (Date.now() - lastRun > LOCK_TTL_MS);

        if (statusData.status === "running" && !isStaleLock) {
          throw new Error("ALREADY_RUNNING");
        }

        if (isStaleLock) {
          console.warn(`[AutoCrawl] 만료된 락 감지 (마지막 실행 후 30분 초과). 락을 재획득합니다.`);
        }

        // Lock 선점 (작업 시작 상태 기록 및 세션 ID 부여)
        transaction.set(statusDocRef, {
          status: "running",
          lastRun: Date.now(),
          currentEpoch: epoch,
          stopRequest: false,
        }, { merge: true });
      });
    } else {
      // 강제 실행 시에는 단순 업데이트 (강제 실행도 새로운 세션으로 간주)
      await statusDocRef.set({
        status: "running",
        lastRun: Date.now(),
        currentEpoch: epoch,
        stopRequest: false,
      }, { merge: true });
    }

    // ── Phase 0-1: 기존 예약 태스크 삭제 로직은 Epoch 방식 도입으로 인해 불필요하므로 제거 ──
    // (대신 각 태스크 핸들러에서 자신의 epoch와 Firestore의 currentEpoch를 비교하여 중단 여부 결정)

    // ── Phase 1: 공식 사이트에서 전체 팩 목록 수집 ──
    log.phase = "scan";
    console.log(`[AutoCrawl] 팩 목록 스캔 시작 (언어: ${locales.join(", ")})`);
    const allPacks = await getAllPacks(locales);
    log.totalPacksFound = allPacks.length;

    // ── Phase 2: Storage에서 이미 크롤링된 PID 목록 조회 (Firestore 읽기 비용 절감) ──
    const existingMetadata = await downloadPacksMetadata();
    const existingKeys = new Set(Object.keys(existingMetadata)); // [변경] PID_locale 복합키 Set
    log.existingPacks = existingKeys.size;

    // ── Phase 3: 신규 PID 필터링 ──
    // [변경] PID+locale 복합키 기준으로 필터링: 동일 PID라도 locale이 다르면 신규로 인식
    const newPacks = allPacks.filter(p => !existingKeys.has(`${p.pid}_${p.locale}`));
    log.newPacksCount = newPacks.length;
    console.log(`[AutoCrawl] 신규 팩 ${newPacks.length}개 발견 (기존: ${existingKeys.size}개)`);

    if (newPacks.length === 0) {
      log.phase = "done";
      log.message = "신규 팩 없음 - 크롤링 종료";
      return log;
    }

    // ── Phase 4: 유효한 팩 탐색 및 1개 팩 크롤링 ──
    log.phase = "crawl";
    let targetPack = null;
    let crawlResult = null;
    const skippedZeroPacks = [];
    let processedIndex = -1;

    for (let i = 0; i < newPacks.length; i++) {
      const currentPack = newPacks[i];
      console.log(`[AutoCrawl] 팩 검사 [${i + 1}/${newPacks.length}]: "${currentPack.name}" (PID: ${currentPack.pid}, locale: ${currentPack.locale})`);

      const result = await crawlSinglePack(currentPack);

      if (result.isZeroCardPack) {
        skippedZeroPacks.push({ pid: currentPack.pid, name: currentPack.name, locale: currentPack.locale });
        console.log(`[AutoCrawl] 팩 "${currentPack.name}" 건너뜀 (카드가 0장인 미수록 팩). 다음 팩을 탐색합니다.`);
        continue;
      }

      // 유효한 팩(카드 1장 이상) 크롤링 완료
      targetPack = currentPack;
      crawlResult = result;
      processedIndex = i;
      break; // 1회 실행당 1개의 유효 팩 크롤링 원칙
    }

    log.skippedZeroPacksCount = skippedZeroPacks.length;
    if (skippedZeroPacks.length > 0) {
      log.skippedZeroPacks = skippedZeroPacks;
    }

    if (!targetPack) {
      log.phase = "done";
      log.message = `신규 팩 ${newPacks.length}개 모두 수록 카드가 0장(발매 전 미수록 팩)이어서 이번 회차 크롤링을 종료합니다.`;
      console.log(`[AutoCrawl] ${log.message}`);
      return log;
    }

    log.targetPack = { pid: targetPack.pid, name: targetPack.name, locale: targetPack.locale };
    log.crawlResult = crawlResult;

    // ── Phase 5: 다음 작업 예약 전 중지 요청 확인 ──
    const finalStatusDoc = await statusDocRef.get();
    const isStopRequested = finalStatusDoc.exists && finalStatusDoc.data().stopRequest === true;

    if (isStopRequested) {
      log.phase = "stopped";
      log.message = "사용자의 요청에 의해 작업을 중단합니다.";
      console.log(`[AutoCrawl] ${log.message}`);
      return log;
    }

    // 처리된 팩 뒤에 아직 검사하지 않은 신규 팩이 남아있으면 다음 작업 예약
    const remainingUncheckedPacks = newPacks.length - 1 - processedIndex;
    if (remainingUncheckedPacks > 0) {
      const delaySec = 300 + Math.floor(Math.random() * 300); // 5~10분 랜덤
      log.reschedule = { delaySeconds: delaySec, remainingPacks: remainingUncheckedPacks };
      await scheduleNextRun(locales, delaySec, epoch);
    }

    log.phase = "done";
    log.message = `"${targetPack.name}" 크롤링 완료` + (skippedZeroPacks.length > 0 ? ` (0장 미수록 팩 ${skippedZeroPacks.length}개 스킵)` : "");
    return log;

  } catch (e) {
    if (e.message === "ALREADY_RUNNING") {
      log.phase = "skipped";
      log.message = "이미 다른 크롤링 작업이 진행 중입니다.";
      console.log(`[AutoCrawl] ${log.message}`);
      return log;
    }

    log.phase = "error";
    log.error = e.message;
    console.error("[AutoCrawl] 오류 발생:", e);
    return log;
  } finally {
    // 성공/실패 여부와 상관없이 Lock 해제 (단, skip인 경우에는 해제하지 않음)
    if (log.phase !== "skipped") {
      try {
        // 신규 팩이 없어도 이전에 남은 변경을 처리하며 완료 응답 전에 파일을 저장합니다.
        await requestCardIndexWork();
      } finally {
        try {
          await statusDocRef.set({
            status: "idle",
            stopRequest: false,
            lastFinished: Date.now(),
          }, { merge: true });
        } catch (err) {
          console.error("[AutoCrawl] Lock 해제 중 오류:", err);
        }
      }
    }
  }
}

/**
 * 단일 팩 크롤링 (CID 추출 → 카드 상세 크롤링 → Firestore 저장)
 * @param {{pid: string, name: string, locale: string}} pack
 * @returns {Promise<{crawled: number, skipped: number, failed: number, totalCids: number, isZeroCardPack?: boolean}>}
 */
async function crawlSinglePack(pack) {
  const { pid, name, locale } = pack;

  // CID 목록 추출
  const packResult = await getPackCids(pid, locale);
  if (packResult.isError || !packResult.cids) {
    console.error(`[AutoCrawl] 팩 CID 추출 실패: ${pid}`, packResult.message);
    throw new Error(`CID 추출 실패: ${packResult.message}`);
  }

  const cids = packResult.cids;
  console.log(`[AutoCrawl] 팩 "${name}" 수록 카드 ${cids.length}장 발견`);

  // 발매 전 미수록 팩 (카드가 0장인 경우) 처리: Storage 저장을 스킵하여 추후 정식 발매 시 재인식되도록 함
  if (cids.length === 0) {
    console.log(`[AutoCrawl] 팩 "${name}" (PID: ${pid})은 수록 카드가 0장(발매 전 미수록 팩)입니다. Storage 저장을 스킵합니다.`);
    return { crawled: 0, skipped: 0, failed: 0, totalCids: 0, isZeroCardPack: true };
  }

  // 카드 상세 크롤링 (Firestore에 없는 것만)
  let crawled = 0, skipped = 0, failed = 0;

  // Firestore 일괄 조회 (cids.length > 0 이 위에서 보장되므로 안전함)
  const docRefs = cids.map(cid => db.collection("cards").doc(cid));
  const existingDocs = await db.getAll(...docRefs);
  const existingMap = new Map(existingDocs.map(doc => [doc.id, doc]));

  for (const cid of cids) {
    // Firestore 존재 여부 확인 (3단계 검증: CID -> 언어 -> 팩 이름 수록 검증)
    const existing = existingMap.get(cid);
    if (existing && existing.exists) {
      const data = existing.data();
      const localeIdx = LOCALE_TO_INDEX[locale];
      const cInfo = data.info ? data.info[localeIdx] : null;

      // 1단계(CID) 및 2단계(언어 정보) 존재 확인
      if (cInfo && cInfo[0]) {
        // 3단계: raritiesByNo 내 현재 팩 이름 매칭 확인
        const raritiesByNo = cInfo[2] || {};
        const targetPackNameNorm = normalizeText(name);

        const isPackAlreadyRecorded = Object.values(raritiesByNo).some(arr => {
          if (!Array.isArray(arr) || !arr[0]) return false;
          const normPack = normalizeText(arr[0]);
          return normPack === targetPackNameNorm;
        });

        if (isPackAlreadyRecorded) {
          skipped++;
          continue; // 이미 이 팩에서의 정보가 기록된 완벽 중복 -> 스킵
        }
        console.log(`[AutoCrawl] 카드(${cid})는 존재하나 팩("${name}") 정보가 없어 재록 갱신 크롤링을 수행합니다.`);
      } else {
        console.log(`[AutoCrawl] 문서(${cid})는 존재하나 언어(${locale}) 정보가 없어 크롤링을 수행합니다.`);
      }
    }

    // 상세 페이지 크롤링
    const cardData = await crawlCardInPack(cid, locale, name);
    if (!cardData.isError) {
      await saveCardToFirestore(cardData, { deferIndexFlush: true });
      crawled++;
    } else {
      failed++;
      console.warn(`[AutoCrawl] 카드 크롤링 실패 (CID: ${cid}):`, cardData.message);
    }

    // 요청 간 딜레이 (차단 방지: 500ms)
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`[AutoCrawl] 팩 "${name}" 처리 완료 - 크롤링: ${crawled}, 스킵: ${skipped}, failed: ${failed}`);

  // 팩 메타정보 Storage에 저장 (Firestore 대신 Storage JSON 파일로 관리)
  await upsertPackToStorage(`${pid}_${locale}`, { // [변경] PID_locale 복합키 사용
    name,
    totalCards: cids.length,
    cids,
    updatedAt: Date.now(),
  });
  console.log(`[AutoCrawl] 팩 "${name}" Storage 저장 완료`);

  return { crawled, skipped, failed, totalCids: cids.length };
}

/**
 * Cloud Tasks를 통해 5~10분 후 재실행 예약
 * firebase-admin의 getFunctions().taskQueue()를 사용
 * @param {string[]} locales - 다음 실행 시 사용할 언어 목록
 * @param {number} delaySec - 지연 시간 (초)
 * @param {number} epoch - 현재 실행 세션 번호
 */
async function scheduleNextRun(locales, delaySec, epoch) {
  try {
    const queue = getFunctions().taskQueue(
      "locations/asia-northeast3/functions/autoCrawlTask"
    );
    // 1. 중복 ID 에러(Task Already Exists) 방지를 위해 유니크 ID 사용
    // 2. 페이로드에 epoch를 포함하여 핸들러에서 세션 유효성 검증 가능케 함
    const taskId = `auto-crawl-${Date.now()}`;
    await queue.enqueue(
      { locales, epoch },
      { 
        id: taskId,
        scheduleDelaySeconds: delaySec 
      }
    );
    console.log(`[AutoCrawl] Cloud Tasks 재실행 예약 완료 (${delaySec}초 후, ID: ${taskId}, Epoch: ${epoch})`);
  } catch (e) {
    console.error("[AutoCrawl] Cloud Tasks 예약 실패:", e);
  }
}

module.exports = { runAutoCrawl };

async function resumeAutoCrawl(data) {
  const { locales = MAIN_LOCALES, epoch } = data;

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
}
module.exports.resumeAutoCrawl = resumeAutoCrawl;

async function controlAutoCrawl(options) {
  const { action, locale, full, force } = options;

  // 1. 중지 명령 처리
  if (action === "stop") {
    await db.collection("system").doc("crawler").set({
      stopRequest: true,
      stoppedAt: Date.now(),
    }, { merge: true });
    return { success: true, message: "크롤링 중지 요청이 수신되었습니다. 현재 처리 중인 팩까지만 완료 후 중단됩니다." };
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

  return { success: true, ...result };
}
module.exports.controlAutoCrawl = controlAutoCrawl;
