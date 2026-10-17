'use strict';

const { resolveUserStorageConfig, sameConnectionConfig } = require('../config/userStorage');

const unavailable = () => Object.assign(new Error('이 환경에서는 멤버십 인증을 사용할 수 없습니다.'),
  { code: 'USER_STORAGE_FEATURE_UNAVAILABLE', status: 503 });

// 합성 의존성을 명시한 직접 호출만 시험 RTDB를 사용한다. 일반 export는 운영 프록시로 우회하지 않는다.
function resolveMembershipProviderRuntime({ env = process.env, storage, rtdbTestDependencies = false } = {}) {
  if (env.USER_PROFILE_WRITER_MODE || env.USER_STORAGE_MODE === 'production') {
    let config;
    try { config = require('../config/userProfileWriter').resolveProfileWriterConfig(env); } catch (_) { throw unavailable(); }
    if (config.mode === 'production') storage = require('./userWriterSelection').selectProductionWriter({ env }).claimsStorage;
    if (config.mode === 'emulator' && !rtdbTestDependencies || !storage?.membership || storage?.writerTransition?.runId !== config.runId
        || !sameConnectionConfig(config, storage.config)) throw unavailable();
    return { storage, config };
  }
  const backend = env.USER_STORAGE_BACKEND;
  if (backend === undefined || backend === '' || backend === 'storage') return null;
  if (backend !== 'rtdb') throw unavailable();
  let config;
  try { config = resolveUserStorageConfig(env); } catch (_) { throw unavailable(); }
  if (config.mode === 'emulator' && (!rtdbTestDependencies || !storage?.membership)) throw unavailable();
  const selected = storage || require('./userStorageRuntime').getRtdbUserStorage();
  if (!selected.membership || (selected.config && !sameConnectionConfig(config, selected.config))) throw unavailable();
  return { storage: selected, config };
}

function guardMembershipProviderRoute(handler, { env = process.env } = {}) {
  return async (req, res) => {
    if (req.method === 'POST') {
      try {
        const selected = resolveMembershipProviderRuntime({ env });
        if (selected?.config.mode === 'production' && selected.storage.writerTransition) await selected.storage.writerTransition.route();
      } catch (_) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ success: false, code: 'USER_STORAGE_FEATURE_UNAVAILABLE',
          message: '이 환경에서는 멤버십 인증을 사용할 수 없습니다.' });
      }
    }
    return handler(req, res);
  };
}

async function syncProviderMembershipClaims(uid, runtime, auth, syncClaims) {
  try {
    if (runtime.config.mode === 'emulator' && !syncClaims) return { claimsPending: true, membershipClaims: { status: 'pending' } };
    const result = syncClaims ? await syncClaims(uid)
      : await require('./membershipClaims').syncMembershipClaims(uid, { auth, storage: runtime.storage });
    const status = result?.status === 'synced' ? 'synced' : 'pending';
    return { claimsPending: status !== 'synced', membershipClaims: { status,
      ...(typeof result?.version === 'string' ? { version: result.version } : {}) } };
  } catch (_) {
    // 원본 저장이 완료된 뒤의 Auth 오류는 제공자 검증을 다시 실행시키지 않는다.
    return { claimsPending: true, membershipClaims: { status: 'pending' } };
  }
}

function providerStateError(error, provider) {
  if (error?.code === 'MEMBERSHIP_TOO_MANY_REQUESTS') {
    return Object.assign(new Error('잠시 후 다시 인증해 주세요.'), { status: 429, code: `${provider}_TOO_MANY_REQUESTS` });
  }
  if (error?.code === 'MEMBERSHIP_VERIFICATION_EXPIRED') {
    return Object.assign(new Error('인증이 만료되었거나 이미 사용되었습니다. 다시 인증해 주세요.'),
      { status: 403, code: `${provider}_VERIFICATION_EXPIRED` });
  }
  return error;
}

module.exports = { resolveMembershipProviderRuntime, syncProviderMembershipClaims, providerStateError, guardMembershipProviderRoute };
