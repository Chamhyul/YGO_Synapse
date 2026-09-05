const { randomUUID } = require('node:crypto');
const { getFunctions } = require('firebase-admin/functions');
const { db } = require('../config/firebase');

const SESSION_MS = 15 * 60 * 1000;
const dispatchRef = () => db.collection('system').doc('cardIndexDispatch');
const pendingQuery = () => db.collection('pendingCardIndexUpdates').limit(1);
const reservation = () => ({
  runId: randomUUID(), status: 'scheduled', submitted: false,
  expiresAt: Date.now() + SESSION_MS, updatedAt: Date.now(),
});

async function submitReservation(runId) {
  // 로컬 Functions/Tasks 에뮬레이터가 없으면 운영 작업 큐로 우회하지 않습니다.
  if ((process.env.FUNCTIONS_EMULATOR || process.env.FIRESTORE_EMULATOR_HOST) && !process.env.CLOUD_TASKS_EMULATOR_HOST) {
    throw new Error('남은 인덱스의 후속 실행에는 Tasks 에뮬레이터가 필요합니다. 대기 기록은 보존됩니다.');
  }
  try {
    await getFunctions().taskQueue('locations/asia-northeast3/functions/processCardIndexTask')
      .enqueue({ runId }, { id: `card-index-${runId}`, dispatchDeadlineSeconds: 540 });
  } catch (error) {
    // 응답 유실 후 같은 예약을 제출해도 작업 ID가 같으므로 중복 생성되지 않습니다.
    if (error.code !== 'functions/task-already-exists' && Number(error.code) !== 6 && Number(error.code) !== 409) throw error;
  }
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(dispatchRef());
    if (snapshot.exists && snapshot.data().runId === runId && snapshot.data().status === 'scheduled') {
      tx.update(dispatchRef(), { submitted: true, updatedAt: Date.now() });
    }
  });
}

// 호출자는 대기 기록을 먼저 commit한 뒤 호출합니다.
// 실행 자리 확보를 하나의 트랜잭션으로 처리하여 동시에 여러 작업을 만들지 않습니다.
async function ensureCardIndexWorker({ direct = false } = {}) {
  const runId = await db.runTransaction(async tx => {
    const snapshot = await tx.get(dispatchRef());
    const state = snapshot.exists ? snapshot.data() : {};
    if (state.expiresAt > Date.now()) {
      if (state.status === 'running') return null;
      if (state.status === 'scheduled' && !direct) return state.submitted ? null : state.runId;
    }
    const pending = await tx.get(pendingQuery());
    if (pending.empty) return null;
    const next = reservation();
    tx.set(dispatchRef(), next);
    return next.runId;
  });
  if (runId && direct) {
    // 최초 처리는 카드 등록·크롤링 요청 안에서 바로 실행합니다.
    // 처리 중 새 변경이 들어온 경우에만 finishCardIndexTask가 후속 Tasks를 예약합니다.
    const { runCardIndexTask } = require('./cardIndexTaskService');
    return runCardIndexTask(runId);
  }
  if (runId) await submitReservation(runId);
  return { scheduled: Boolean(runId) };
}

// 카드 변경 직후 첫 처리는 호출한 함수에서 직접 실행합니다. 그 사이 새 대기분이
// 생긴 경우에만 finishCardIndexTask가 후속 Tasks를 이어가며, 0이 되는 순간 멈춥니다.
async function requestCardIndexWork() {
  return ensureCardIndexWorker({ direct: true });
}

async function claimCardIndexTask(runId) {
  if (typeof runId !== 'string' || !runId) return false;
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(dispatchRef());
    if (!snapshot.exists || snapshot.data().runId !== runId || snapshot.data().status !== 'scheduled') return false;
    tx.update(dispatchRef(), {
      status: 'running', submitted: true, expiresAt: Date.now() + SESSION_MS, updatedAt: Date.now(),
    });
    return true;
  });
}

async function finishCardIndexTask(runId) {
  const nextRunId = await db.runTransaction(async tx => {
    const snapshot = await tx.get(dispatchRef());
    if (!snapshot.exists || snapshot.data().runId !== runId) return null;
    const pending = await tx.get(pendingQuery());
    // 종료 직전 새 변경이 있으면 다음 작업을 확보하고, 비어 있으면 idle로 전환합니다.
    // 저장 후 확인하는 생산자도 이 문서를 읽고 갱신하므로 종료 경계의 경쟁을 재시도합니다.
    if (!pending.empty) {
      const next = reservation();
      tx.set(dispatchRef(), next);
      return next.runId;
    }
    tx.set(dispatchRef(), { status: 'idle', runId: null, submitted: false, expiresAt: 0, updatedAt: Date.now() });
    return null;
  });
  if (nextRunId) await submitReservation(nextRunId);
  return { continued: Boolean(nextRunId) };
}

async function retryCardIndexTask(runId, error) {
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(dispatchRef());
    // 후속 실행으로 넘어간 경우에는 이전 작업이 새 예약을 되돌리지 않습니다.
    if (snapshot.exists && snapshot.data().runId === runId) {
      tx.update(dispatchRef(), {
        status: 'scheduled', submitted: false, expiresAt: Date.now() + SESSION_MS,
        updatedAt: Date.now(), lastError: String(error.message || error).slice(0, 500),
      });
    }
  });
}

module.exports = { requestCardIndexWork, claimCardIndexTask, finishCardIndexTask, retryCardIndexTask };
