'use strict';

const { membershipPermissionVersion } = require('./user-storage/membershipStore');
const { normalizeSourceMembership } = require('./membershipPolicy');
const { measure } = require('./inventoryRequestTiming');
const { isDeepStrictEqual: same } = require('node:util');
const CLAIM = 'ygoMembership';
const LEGACY_SOURCE = Symbol('legacy-membership-source');
const failure = code => Object.assign(new Error('계정 권한 동기화 상태를 확인하지 못했습니다.'), { code });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function membershipClaim(record) {
  const source = normalizeSourceMembership(record.membership);
  return { v: 1, active: source.status === 'active',
    provider: source.verificationVersion === 2 ? source.verificationProvider : 'none', version: membershipPermissionVersion(record.membership) };
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
  options = {}) {
  const work = () => writeClaimsInSession(uid, { auth, storage, timeoutMs }, patchFor, options);
  return storage.customClaims.withSession ? storage.customClaims.withSession(work) : work();
}
async function writeClaimsInSession(uid, { auth, storage, timeoutMs }, patchFor,
  { allowDisabled = false, recoveryOperationId, expectedBackend, readMembership = () => storage.membership.read(uid) } = {}) {
  const operationId = recoveryOperationId || await measure('claims.acquire', () => expectedBackend
    ? storage.customClaims.acquire(uid, { backend: expectedBackend }) : storage.customClaims.acquire(uid));
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
      // 잠금을 획득한 뒤의 fresh 조회만 병렬화한다. 이전 조회의 Auth/원본을 쓰기에 재사용하지 않는다.
      const [record, account] = await bounded(() => Promise.all([
        measure('claims.source', readMembership), measure('claims.account', () => auth.getUser(uid)),
      ]));
      if (account.disabled && !allowDisabled) throw failure('AUTH_INVALID');
      const current = account.customClaims || {};
      const patch = await patchFor(record, current, account), next = mergeClaims(current, patch);
      if (recoveryOperationId) {
        const lock = await bounded(() => storage.customClaims.inspect(uid));
        if (lock?.state !== 'running' || lock.operationId !== operationId) throw failure('MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT');
      }
      if (!same(current, next)) {
        let submitted = false;
        try { await bounded(() => { submitted = true; return measure('claims.patch', () => auth.setCustomUserClaims(uid, next)); }); }
        catch (error) { uncertain = submitted && !definitive(error); throw error; }
        // 공통 전환 경계에서는 승인 응답 뒤 실제 전체 claims도 대조한다.
        if (storage.writerTransition) uncertain = true;
      }
      if (recoveryOperationId || storage.writerTransition) {
        const actual = await bounded(() => measure('claims.readback', () => auth.getUser(uid)));
        if (!same(actual.customClaims || {}, next)) throw failure('MEMBERSHIP_CLAIMS_READBACK_MISMATCH');
        uncertain = false;
      }
      const latest = await bounded(() => measure('claims.source', readMembership));
      if (latest.version === record.version) {
        completed = true;
        return { status: 'synced', version: membershipPermissionVersion(record.membership) };
      }
    }
    throw failure('MEMBERSHIP_CLAIMS_SOURCE_CHANGED');
  } finally {
    // 이미 성공한 RTDB 멤버십을 롤백하지 않는다. 상태 갱신 장애도 호출자가 pending으로 다룬다.
    await measure('claims.finish', () => storage.customClaims.finish(uid, operationId, uncertain || (!!recoveryOperationId && !completed)));
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
  const record = await bounded(() => measure('claims.source', () => storage.membership.read(uid)));
  const account = await bounded(() => measure('claims.account', () => auth.getUser(uid)));
  const latest = await bounded(() => measure('claims.source', () => storage.membership.read(uid)));
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
    // 저장소 내부의 활성 인증 lease+확정 저장 결과로만 선택한다. HTTP/options 입력은 자격이 아니다.
    if (typeof runtime.storage.membership.withClaimsWriteWindow === 'function') {
      const saved = await runtime.storage.membership.withClaimsWriteWindow(uid, ({ read }) =>
        measure('claims.after_write', () => writeClaims(uid, runtime, record => ({ [CLAIM]: membershipClaim(record) }),
          { readMembership: read, expectedBackend: options.expectedBackend })));
      if (saved.used) return saved.value;
    }
    const matched = await matchingClaims(uid, runtime);
    return matched || await writeClaims(uid, runtime, record => ({ [CLAIM]: membershipClaim(record) }),
      { expectedBackend: options.expectedBackend });
  } catch (_) { return { status: 'pending' }; }
}

// 이벤트의 권한 버전 변화는 쓰기 경로 선택 힌트뿐이다. 원본/계정은 잠금 뒤 새로 읽는다.
// 같은 권한의 시각 갱신은 기존 무쓰기 일치 대조를 유지한다. HTTP 진입점이 아니다.
async function syncMembershipClaimsForProfileEvent(uid, { permissionChanged = false, ...options } = {}) {
  if (permissionChanged !== true) return syncMembershipClaims(uid, options);
  try {
    const runtime = configured(options);
    return await measure('claims.event_write', () => writeClaims(uid, runtime,
      record => ({ [CLAIM]: membershipClaim(record) })));
  } catch (_) { return { status: 'pending' }; }
}

// 서버 인증 헬퍼만 공급하는 최신 계정 조회를 검증 창 안에서 처음 실행한다.
// running/uncertain·원본 실패에도 계정 인증은 생략하지 않으며 Auth 실패는 호출자에게 전달한다.
async function readMembershipClaimsStatusWithAccount(uid, options = {}) {
  if (typeof options.readAccount !== 'function') throw failure('AUTH_INVALID');
  const started = Date.now();
  let runtime, membershipClaims = { status: 'pending' }, accountTask;
  const account = () => {
    if (accountTask) return accountTask;
    const remaining = started + (runtime?.timeoutMs || 10000) - Date.now();
    accountTask = (remaining > 0 ? deadline(options.readAccount, remaining)
      : Promise.reject(failure('MEMBERSHIP_CLAIMS_TIMEOUT'))).then(value => {
      if (!value || value.uid !== uid) throw failure('AUTH_INVALID');
      return value;
    });
    return accountTask;
  };
  try {
    runtime = configured(options);
    membershipClaims = await matchingClaims(uid, { ...runtime, auth: { getUser: account } }) || membershipClaims;
  } catch (_) { /* 저장 증거 실패를 성공으로 바꾸지 않는다. 인증 실패는 아래에서 다시 전달한다. */ }
  return { account: await account(), membershipClaims };
}

// HTTP 완료 확인은 읽기만 한다. 잠금 획득·claims 쓰기·인벤토리 조회는 수행하지 않는다.
async function readMembershipClaimsStatus(uid, options = {}) {
  try { return await matchingClaims(uid, configured(options)) || { status: 'pending' }; }
  catch (_) { return { status: 'pending' }; }
}

// 제공자 검증이 원본을 저장한 뒤의 전체 조회는 별도 worker와 Auth 쓰기를
// 경쟁하지 않는다. legacy에는 해당 이벤트가 없으므로 기존 동기 복구를 유지한다.
async function readMembershipClaimsAfterVerification(uid, options = {}) {
  try {
    const runtime = configured(options);
    if (!runtime.storage.writerTransition) return syncMembershipClaims(uid, options);
    const matched = await matchingClaims(uid, runtime, { legacyFallback: true });
    return matched === LEGACY_SOURCE ? syncMembershipClaims(uid, { ...options, expectedBackend: 'legacy' })
      : matched || { status: 'pending' };
  } catch (_) { return { status: 'pending' }; }
}

// Auth를 수정하지 않는 읽기 경로다. UID 잠금의 revision과 완료된 공통 장벽,
// 원본/정책 버전·현재 Auth 값·전환 epoch를 모두 대조한다. 미확정 작업은 복구에 남긴다.
async function matchingClaims(uid, { storage, auth, timeoutMs }, { legacyFallback = false } = {}) {
  if (!storage.writerTransition?.route || !storage.customClaims.observe || !storage.customClaims.isSettled) return;
  const expires = Date.now() + timeoutMs;
  const bounded = action => { const left = expires - Date.now(); if (left <= 0) throw failure('MEMBERSHIP_CLAIMS_TIMEOUT'); return deadline(action, left); };
  const check = async read => {
    const before = await bounded(() => measure('claims.lock_before', () => storage.customClaims.observe(uid)));
    if (!before.value) return;
    if (before.value.state !== 'idle') return { status: 'pending' };
    // idle 관측의 작업 ID로 완료 증거를 미리 읽는다. 원본/Auth와 독립인
    // 읽기만 병렬화하고, 반환 전 원본 버전·잠금 revision/세대는 다시 대조한다.
    // 부가 증거의 실패는 시작 시 회수한다. claims 불일치가 먼저 확인되면
    // 이 읽기를 기다리지 않고 기존 복구로 넘기며, 늦은 읽기는 권한에 쓰지 않는다.
    const settledTask = bounded(() => measure('claims.settled', () => storage.customClaims.isSettled(uid, before.value.operationId)))
      .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
    const [sourceRead, accountRead] = await bounded(() => Promise.allSettled([
      measure('claims.source', read), measure('claims.account', () => auth.getUser(uid)),
    ]));
    if (sourceRead.status === 'rejected' || accountRead.status === 'rejected') {
      await settledTask;
      throw sourceRead.status === 'rejected' ? sourceRead.reason : accountRead.reason;
    }
    const record = sourceRead.value, account = accountRead.value;
    if (account.disabled) return { status: 'pending' };
    if (!same(account.customClaims?.[CLAIM], membershipClaim(record))) return;
    // 선행 증거 읽기의 실패는 현재 claims가 맞을 때만 판정한다. 불일치의
    // 기존 동기 복구는 이 부가 읽기의 실패 때문에 차단하지 않는다.
    const settledRead = await settledTask;
    if (settledRead.status === 'rejected') throw settledRead.reason;
    const settled = settledRead.value;
    const [latest, after] = await bounded(() => Promise.all([
      measure('claims.source_after', read), measure('claims.lock_after', () => storage.customClaims.observe(uid)),
    ]));
    if (!settled || !same(before, after) || record.version !== latest.version) return { status: 'pending' };
    return { status: 'synced', version: membershipPermissionVersion(record.membership) };
  };
  if (typeof storage.membership.withReadWindow === 'function') {
    return bounded(() => storage.membership.withReadWindow(uid, ({ writer, read }) => {
      // drain 전 얻은 부모 lease의 동기화는 기존 쓰기 경로에서 계속 완료한다.
      if (writer.phase !== 'accepting') return;
      return legacyFallback && writer.backend === 'legacy' ? LEGACY_SOURCE : check(read);
    }));
  }
  // 구형/시험 저장소는 기존 reader와 바깥 전후 검사를 그대로 사용한다.
  const writer = await bounded(() => measure('claims.route_before', () => storage.writerTransition.route()));
  if (writer.phase !== 'accepting') return;
  const value = legacyFallback && writer.backend === 'legacy' ? LEGACY_SOURCE
    : await check(() => storage.membership.read(uid));
  const finalWriter = await bounded(() => measure('claims.route_after', () => storage.writerTransition.route()));
  return same(writer, finalWriter) ? value : { status: 'pending' };
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

module.exports = { CLAIM, membershipClaim, mergeClaims, syncMembershipClaims, syncMembershipClaimsForProfileEvent, updateAccountClaims,
  inspectMembershipClaims, recoverMembershipClaims, readMembershipClaimsStatus, readMembershipClaimsStatusWithAccount, readMembershipClaimsAfterVerification };
