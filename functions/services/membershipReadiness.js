'use strict';

// 이 응답은 준비 상태일 뿐 회원/권한 증명이 아니다. 호출자는 먼저 기존
// App Check·인증·가입 판정을 끝내며 실제 업무 요청은 모든 검사를 다시 한다.
const modules = Object.freeze({
  startYoutubeMembershipVerification: ['./membershipClaims'],
  getUserData: ['./loginUserData', './membershipClaims'],
  verifyYoutubeMembership: ['./membershipClaims', './membershipCsvService'],
  verifyDiscordMembership: ['./membershipClaims'],
});

function respondMembershipReadiness(req, res, target, { load = require,
  prepareWorker = () => require('./membershipWorkerPreparation').prepareMembershipWorker() } = {}) {
  const body = req.body;
  if (req.method !== 'POST' || !body || Array.isArray(body) || body.membershipPrepare !== true
      || body.warmup !== 'true' || !Object.hasOwn(modules, target)
      || Object.keys(body).some(key => !['membershipPrepare', 'warmup', 'ssId', 'workerPrepare'].includes(key))
      || Object.hasOwn(body, 'workerPrepare') && (body.workerPrepare !== true || target !== 'getUserData')) {
    return res.status(400).json({ success: false, code: 'MEMBERSHIP_PREPARATION_INVALID',
      message: '준비 요청 형식이 올바르지 않습니다.' });
  }
  for (const name of modules[target]) load(name);
  if (body.workerPrepare === true) return Promise.resolve().then(prepareWorker)
    .catch(() => ({ status: 'unavailable' })).then(workerPreparation => res.json({ success: true,
      membershipPreparation: { version: 1, target, ready: true },
      workerPreparation: { status: ['delivered', 'throttled'].includes(workerPreparation?.status)
        ? workerPreparation.status : 'unavailable' } }));
  return res.json({ success: true, membershipPreparation: { version: 1, target, ready: true } });
}

module.exports = { respondMembershipReadiness };
