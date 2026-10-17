'use strict';

const { normalizeSourceMembership } = require('./membershipPolicy');
const { isDeepStrictEqual: same } = require('node:util');
const CLAIM = 'ygoMembership';
const failure = code => Object.assign(new Error('계정 권한 동기화 상태를 확인하지 못했습니다.'), { code });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function membershipClaim(record) {
  const source = normalizeSourceMembership(record.membership);
  return { v: 1, active: source.status === 'active',
    provider: source.verificationVersion === 2 ? source.verificationProvider : 'none', version: record.version };
}
function mergeClaims(current, patch) {
  if (!plain(current) || !plain(patch)) throw failure('MEMBERSHIP_CLAIMS_INVALID');
  const next = { ...current, ...patch };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 1000) throw failure('MEMBERSHIP_CLAIMS_TOO_LARGE');
  return next;
}
const definitive = error => ['auth/invalid-claims', 'auth/claims-too-large', 'auth/argument-error',
  'auth/invalid-argument', 'auth/user-not-found', 'auth/insufficient-permission'].includes(error?.code);
async function deadline(action, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('MEMBERSHIP_CLAIMS_TIMEOUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function configured(options) {
  const env = options.env || process.env;
  const config = require('../config/userStorage').resolveUserStorageConfig(env);
  if (config.mode === 'emulator' && (!options.allowEmulator || !options.auth || !options.storage)) {
    throw failure('MEMBERSHIP_CLAIMS_TEST_DEPENDENCIES_REQUIRED');
  }
  const writerConfig = env.USER_PROFILE_WRITER_MODE || env.USER_STORAGE_MODE === 'production'
    ? require('../config/userProfileWriter').resolveProfileWriterConfig(env) : undefined;
  const storage = options.storage || require('./userStorageRuntime').getRtdbUserStorage();
  if (writerConfig && (storage.writerTransition?.runId !== writerConfig.runId || writerConfig.mode === 'emulator' && !options.allowEmulator)) {
    throw failure('USER_STORAGE_FEATURE_UNAVAILABLE');
  }
  if (!require('../config/userStorage').sameConnectionConfig(config, storage.config)) throw failure('USER_STORAGE_CONFIG_INVALID');
  const auth = options.auth || require('../config/firebase').admin.auth();
  if (typeof auth.getUser !== 'function' || typeof auth.setCustomUserClaims !== 'function'
      || !storage.membership || !storage.customClaims) throw failure('MEMBERSHIP_CLAIMS_INVALID');
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw failure('MEMBERSHIP_CLAIMS_INVALID');
  return { auth, storage, timeoutMs };
}
async function writeClaims(uid, { auth, storage, timeoutMs }, patchFor,
  { allowDisabled = false, recoveryOperationId } = {}) {
  const operationId = recoveryOperationId || await storage.customClaims.acquire(uid);
  // 원본 재시도까지 같은 시간 예산을 사용한다. 시간초과 뒤 새 Auth 쓰기를 시작하지 않는다.
  const expiresAt = Date.now() + timeoutMs;
  const bounded = action => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw failure('MEMBERSHIP_CLAIMS_TIMEOUT');
    return deadline(action, remaining);
  };
  let uncertain = false, completed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await bounded(() => storage.membership.read(uid));
      const account = await bounded(() => auth.getUser(uid));
      if (account.disabled && !allowDisabled) throw failure('AUTH_INVALID');
      const current = account.customClaims || {};
      const patch = await patchFor(record, current, account), next = mergeClaims(current, patch);
      if (recoveryOperationId) {
        const lock = await bounded(() => storage.customClaims.inspect(uid));
        if (lock?.state !== 'running' || lock.operationId !== operationId) throw failure('MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT');
      }
      if (!same(current, next)) {
        let submitted = false;
        try { await bounded(() => { submitted = true; return auth.setCustomUserClaims(uid, next); }); }
        catch (error) { uncertain = submitted && !definitive(error); throw error; }
        // 공통 전환 경계에서는 승인 응답 뒤 실제 전체 claims도 대조한다.
        if (storage.writerTransition) uncertain = true;
      }
      if (recoveryOperationId || storage.writerTransition) {
        const actual = await bounded(() => auth.getUser(uid));
        if (!same(actual.customClaims || {}, next)) throw failure('MEMBERSHIP_CLAIMS_READBACK_MISMATCH');
        uncertain = false;
      }
      const latest = await bounded(() => storage.membership.read(uid));
      if (latest.version === record.version) {
        completed = true;
        return { status: 'synced', version: record.version };
      }
    }
    throw failure('MEMBERSHIP_CLAIMS_SOURCE_CHANGED');
  } finally {
    // 이미 성공한 RTDB 멤버십을 롤백하지 않는다. 상태 갱신 장애도 호출자가 pending으로 다룬다.
    await storage.customClaims.finish(uid, operationId, uncertain || (!!recoveryOperationId && !completed));
  }
}

async function inspectMembershipClaims(uid, options = {}) {
  const { storage, auth, timeoutMs } = configured(options);
  const expiresAt = Date.now() + timeoutMs;
  const bounded = action => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw failure('MEMBERSHIP_CLAIMS_TIMEOUT');
    return deadline(action, remaining);
  };
  const writerState = async () => {
    if (!storage.writerTransition) return undefined;
    const { backend, epoch, phase, unresolved } = await bounded(() => storage.writerTransition.inspect());
    return { backend, epoch, phase, unresolved };
  };
  const writerBefore = await writerState();
  const before = await bounded(() => storage.customClaims.inspect(uid));
  const record = await bounded(() => storage.membership.read(uid));
  const account = await bounded(() => auth.getUser(uid));
  const latest = await bounded(() => storage.membership.read(uid));
  const after = await bounded(() => storage.customClaims.inspect(uid));
  const writer = await writerState();
  const stable = same(before, after) && same(writerBefore, writer) && record.version === latest.version;
  // UID·제공자 개인 ID·claims 전체는 보고하지 않는다.
  return { state: after?.state || 'absent', ...(after ? { operationId: after.operationId } : {}),
    ...(after?.recoveryOf ? { recoveryOf: after.recoveryOf } : {}), stable,
    matches: stable && same(account.customClaims?.[CLAIM], membershipClaim(latest)), version: latest.version,
    ...(writer ? { writer } : {}) };
}

async function recoverMembershipClaims(uid, expectedOperationId, options = {}) {
  if (options.writersDrained !== true || typeof expectedOperationId !== 'string' || !/^[a-f0-9]{32}$/.test(expectedOperationId)) {
    throw failure('MEMBERSHIP_CLAIMS_RECOVERY_CONFIRMATION_REQUIRED');
  }
  const runtime = configured(options);
  const operationId = await runtime.storage.customClaims.beginRecovery(uid, expectedOperationId, { writersDrained: true });
  // 과거 관리자 변경 의도를 추측하지 않는다. 현재 Auth 역할을 보존해 요약을 복구한다.
  return { ...await writeClaims(uid, runtime, record => ({ [CLAIM]: membershipClaim(record) }),
    { allowDisabled: true, recoveryOperationId: operationId }), operationId, recoveryOf: expectedOperationId };
}

async function syncMembershipClaims(uid, options = {}) {
  try {
    const runtime = configured(options);
    const matched = await matchingClaims(uid, runtime);
    return matched || await writeClaims(uid, runtime, record => ({ [CLAIM]: membershipClaim(record) }));
  } catch (_) { return { status: 'pending' }; }
}

// Auth를 수정하지 않는 읽기 경로다. UID 잠금의 revision과 완료된 공통 장벽,
// 원본/정책 버전·현재 Auth 값·전환 epoch를 모두 대조한다. 미확정 작업은 복구에 남긴다.
async function matchingClaims(uid, { storage, auth, timeoutMs }) {
  if (!storage.writerTransition?.route || !storage.customClaims.observe || !storage.customClaims.isSettled) return;
  const expires = Date.now() + timeoutMs;
  const bounded = action => { const left = expires - Date.now(); if (left <= 0) throw failure('MEMBERSHIP_CLAIMS_TIMEOUT'); return deadline(action, left); };
  const writer = await bounded(() => storage.writerTransition.route());
  // drain 전 얻은 부모 lease의 동기화는 기존 쓰기 경로에서 계속 완료할 수 있다.
  if (writer.phase !== 'accepting') return;
  const before = await bounded(() => storage.customClaims.observe(uid));
  if (!before.value) return;
  if (before.value.state !== 'idle') return { status: 'pending' };
  const [record, account] = await bounded(() => Promise.all([storage.membership.read(uid), auth.getUser(uid)]));
  if (account.disabled) return { status: 'pending' };
  if (!same(account.customClaims?.[CLAIM], membershipClaim(record))) return;
  const [latest, after, settled] = await bounded(() => Promise.all([
    storage.membership.read(uid), storage.customClaims.observe(uid), storage.customClaims.isSettled(uid, before.value.operationId),
  ]));
  const finalWriter = await bounded(() => storage.writerTransition.route());
  if (!settled || !same(before, after) || record.version !== latest.version || !same(writer, finalWriter)) return { status: 'pending' };
  return { status: 'synced', version: record.version };
}

async function updateAccountClaims(uid, patch, options = {}) {
  if (!plain(patch) || Object.keys(patch).some(key => !['role', 'admin'].includes(key))
      || !['owner', 'admin', 'none'].includes(patch.role) || typeof patch.admin !== 'boolean') throw failure('MEMBERSHIP_CLAIMS_INVALID');
  const env = options.env || process.env;
  if (env.USER_STORAGE_BACKEND === 'rtdb' || env.USER_PROFILE_WRITER_MODE) {
    const result = await writeClaims(uid, configured(options), (record, current, account) => { options.validateCurrentClaims?.(current, account); return { ...patch, [CLAIM]: membershipClaim(record) }; }, { allowDisabled: true });
    return result;
  }
  if (env.USER_STORAGE_BACKEND !== undefined && env.USER_STORAGE_BACKEND !== '' && env.USER_STORAGE_BACKEND !== 'storage') {
    throw failure('USER_STORAGE_CONFIG_INVALID');
  }
  const auth = options.auth || require('../config/firebase').admin.auth();
  const account = await auth.getUser(uid);
  options.validateCurrentClaims?.(account.customClaims || {}, account);
  await auth.setCustomUserClaims(uid, mergeClaims(account.customClaims || {}, patch));
  return { status: 'synced' };
}

module.exports = { CLAIM, membershipClaim, mergeClaims, syncMembershipClaims, updateAccountClaims,
  inspectMembershipClaims, recoverMembershipClaims };
