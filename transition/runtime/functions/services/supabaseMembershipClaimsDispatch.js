'use strict';

const TASK_NAME = 'processMembershipClaimsTask';
const dispatchWaitMs = 500;

function createMembershipClaimsEnqueue(getFunctions, { projectId, env = process.env } = {}) {
  if (projectId !== 'ygo-synapse' || !env.K_SERVICE || !env.K_REVISION ||
      Object.entries(env).some(([key, value]) => key.includes('EMULATOR') && value)) return undefined;

  return uid => getFunctions()
    .taskQueue(`projects/${projectId}/locations/asia-northeast3/functions/${TASK_NAME}`)
    .enqueue({ uid }, { dispatchDeadlineSeconds: 30 });
}

async function dispatchCommittedMembershipClaims(uid, enqueueClaims, waitMs = dispatchWaitMs) {
  if (!enqueueClaims) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => enqueueClaims(uid)),
      new Promise((_, reject) => { timer = setTimeout(reject, waitMs); }),
    ]);
  } catch (_) {
    // DB의 대기 행은 정각 작업이 재처리한다.
    console.warn(JSON.stringify({ severity:'WARNING', event:'membership_claims_dispatch_deferred' }));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createMembershipClaimsEnqueue, dispatchCommittedMembershipClaims };
