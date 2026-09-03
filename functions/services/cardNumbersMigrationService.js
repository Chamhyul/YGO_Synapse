const { db, admin, FieldValue } = require("../config/firebase");
const { getFunctions } = require("firebase-admin/functions");
const { requestCardIndexWork } = require("./cardIndexDispatchService");
const { stageCardWrite } = require("./cardWriteService");

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


async function startCardNumbersMigration() {
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
    return { httpStatus: 202,
      success: true,
      status: "running",
      runId,
      batchSize: CARD_NUMBERS_MIGRATION_BATCH_SIZE,
      message: "카드 번호 마이그레이션을 시작했습니다. Cloud Tasks가 100개씩 자동으로 처리합니다.",
    };
  } catch (e) {
    if (e.message === "MIGRATION_ALREADY_RUNNING") {
      return { httpStatus: 409, success: false, message: "이미 카드 번호 마이그레이션이 진행 중입니다." };
    }
    await CARD_NUMBERS_MIGRATION_DOC.set({
      status: "failed",
      error: e.message || String(e),
      lastUpdatedAt: Date.now(),
    }, { merge: true }).catch(() => {});
    console.error("migrateCardNumbersField start error:", e);
    return { httpStatus: 500, success: false, message: e.toString() };
  }
}

async function processCardNumbersMigration(data) {
  const { runId } = data || {};
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
      stageCardWrite(batch, cardDoc.id, {
        numbers: FieldValue.arrayUnion(...missingNumbers),
        updatedAt: Date.now(),
      });
      updatedInBatch++;
    }
  }
  if (updatedInBatch > 0) {
    await batch.commit();
    await requestCardIndexWork();
  }

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
}
module.exports = { startCardNumbersMigration, processCardNumbersMigration };
