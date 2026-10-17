'use strict';

const { createHash } = require('node:crypto');
const { createRecordStore } = require('./recordStore');
const { createStorageAccess, DEFAULT_TIMEOUT_MS } = require('./storageAccess');
const { encodeValue, decodeValue } = require('./codec');
const { UNLIMITED, parseToken, verifyRecord, keyOptions, validOrigin, failure } = require('../card-service/services/cardApiAccess');
const KEY_ID = /^[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const time = value => Number.isSafeInteger(value) && value >= 0;
const limit = value => value === UNLIMITED || (Number.isSafeInteger(value) && value >= 1);
const unavailable = () => failure(503, 'API_UNAVAILABLE');
const originHash = origin => createHash('sha256').update(origin).digest('hex');
const mutationQueues = new WeakMap();

// 같은 연결의 같은 키는 조회부터 CAS 승인까지 순서대로 처리한다.
// recordStore의 commit 큐와 분리해 중첩 대기 없이 다른 연결의 서버 CAS는 유지한다.
function serializeMutation(database, id, work, timeoutMs) {
  let queues = mutationQueues.get(database);
  if (!queues) { queues = new Map(); mutationQueues.set(database, queues); }
  const previous = queues.get(id) || Promise.resolve();
  let cancelled = false, started = false, timer;
  const queueError = () => Object.assign(new Error('API 키 변경 대기 시간이 초과되었습니다. 이 변경은 서버에 제출하지 않았습니다.'),
    { code: 'USER_STORAGE_QUEUE_TIMEOUT' });
  const start = () => {
    if (cancelled) throw queueError();
    started = true;
    clearTimeout(timer);
    return work();
  };
  const task = previous.then(start, start);
  const tail = task.then(() => {}, () => {});
  queues.set(id, tail);
  tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
    if (!queues.size && mutationQueues.get(database) === queues) mutationQueues.delete(database);
  });
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      cancelled = true;
      reject(queueError());
    }, timeoutMs);
    task.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function checkId(id) {
  if (typeof id !== 'string' || !KEY_ID.test(id)) throw failure(400, 'INVALID_KEY_ID');
}

function stableKey(key) {
  const id = key?.id, secretHash = key?.secretHash;
  checkId(id);
  if (typeof secretHash !== 'string' || !HASH.test(secretHash)) throw failure(400, 'INVALID_KEY_ID');
  // 생성 도구가 전달하는 token 원문을 복사하거나 저장하지 않는다.
  return { id, secretHash };
}

function storedValue(value) {
  if (!plain(value) || Object.keys(value).length !== 2 || !own(value, 'policy') || !own(value, 'usage')) throw unavailable();
  const { policy, usage } = value;
  const required = ['label', 'origins', 'minuteLimit', 'dayLimit', 'expiresAt', 'scope', 'enabled', 'secretHash', 'createdAt'];
  const allowed = [...required, 'disabledAt', 'rotatedAt'];
  if (!plain(policy) || required.some(key => !own(policy, key)) || Object.keys(policy).some(key => !allowed.includes(key))
      || typeof policy.label !== 'string' || !policy.label.trim() || policy.label.length > 100
      || !Array.isArray(policy.origins) || policy.origins.length > 20 || !policy.origins.every(validOrigin)
      || typeof policy.scope !== 'string' || typeof policy.enabled !== 'boolean'
      || typeof policy.secretHash !== 'string' || !HASH.test(policy.secretHash)
      || !limit(policy.minuteLimit) || !limit(policy.dayLimit) || !time(policy.createdAt)
      || (policy.expiresAt !== null && !time(policy.expiresAt))
      || ['disabledAt', 'rotatedAt'].some(key => own(policy, key) && !time(policy[key]))) throw unavailable();
  if (usage !== null && (!plain(usage) || Object.keys(usage).length !== 4
      || !['minute', 'day', 'minuteCount', 'dayCount'].every(key => own(usage, key) && time(usage[key])))) throw unavailable();
  return value;
}

// 키 설정과 사용량은 같은 키 레코드의 CAS로 처리한다. CORS 후보는 권한 근거가 아니다.
function createApiAccessStore({ database, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts, onAmbiguousWrite, clock = Date.now } = {}) {
  if (typeof clock !== 'function') throw Object.assign(new Error('API 접근 시계 설정이 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_CONFIG' });
  const options = { database, timeoutMs, maxAttempts, onAmbiguousWrite };
  const access = createStorageAccess(options);
  const keys = createRecordStore({ ...options, path: 'apiAccess/keys', payloadCodec: {
    encode: (value, context) => encodeValue(storedValue(value), context),
    decode: (value, context) => storedValue(decodeValue(value, context)),
  } });
  function now() {
    const result = clock();
    if (!time(result)) throw unavailable();
    return result;
  }
  const missing = record => !record.exists;
  const mutate = (id, work) => serializeMutation(database, id, () => { access.ensureUsable(); return work(); }, timeoutMs);

  return {
    async authenticate(token) {
      access.ensureUsable();
      const parsed = parseToken(token), record = await keys.read(parsed.id);
      return { id: parsed.id, ...verifyRecord(missing(record) ? undefined : record.value.policy, parsed, now()) };
    },
    async allowsPreflight(origin) {
      access.ensureUsable();
      if (!validOrigin(origin)) return false;
      const candidates = await access.read(`apiAccess/origins/${originHash(origin)}`);
      if (candidates === null || candidates === undefined) return false;
      if (!plain(candidates) || Object.keys(candidates).some(id => !KEY_ID.test(id) || candidates[id] !== true)) throw unavailable();
      // 한 origin의 후보만 순차 조회한다. 후보를 먼저 등록하고 실제 키는 마지막에 활성화한다.
      for (const id of Object.keys(candidates)) {
        const record = await keys.read(id);
        if (missing(record)) continue;
        const policy = record.value.policy;
        // 기존 OPTIONS 계약은 만료 시각과 무관한 등록 origin 합집합이다.
        // 실제 요청은 authenticate/consume에서 만료와 비밀값을 다시 검사한다.
        if (policy.enabled && policy.scope === 'getCardInfo' && policy.origins.includes(origin)) return true;
      }
      return false;
    },
    async consume(token, origin) {
      access.ensureUsable();
      const parsed = parseToken(token);
      const outcome = await mutate(parsed.id, () => keys.update(parsed.id, (value, current) => {
        const timestamp = now();
        const policy = verifyRecord(current.exists ? value.policy : undefined, parsed, timestamp);
        if (origin !== undefined && !policy.origins.includes(origin)) throw failure(403, 'ORIGIN_NOT_ALLOWED');
        const minute = Math.floor(timestamp / 60000), day = Math.floor(timestamp / 86400000);
        const old = value.usage || {};
        const minuteCount = old.minute === minute ? old.minuteCount : 0;
        const dayCount = old.day === day ? old.dayCount : 0;
        if (![minuteCount, dayCount].every(count => Number.isSafeInteger(count) && count >= 0 && count < Number.MAX_SAFE_INTEGER)) throw unavailable();
        const minuteExceeded = policy.minuteLimit !== UNLIMITED && minuteCount >= policy.minuteLimit;
        const dayExceeded = policy.dayLimit !== UNLIMITED && dayCount >= policy.dayLimit;
        if (minuteExceeded || dayExceeded) {
          const reset = dayExceeded ? (day + 1) * 86400000 : (minute + 1) * 60000;
          throw Object.assign(failure(429, 'RATE_LIMIT_EXCEEDED'), { retryAfter: Math.max(1, Math.ceil((reset - timestamp) / 1000)) });
        }
        return { value: { policy, usage: { minute, day, minuteCount: minuteCount + 1, dayCount: dayCount + 1 } }, result: {
          minuteLimit: policy.minuteLimit, minuteRemaining: policy.minuteLimit === UNLIMITED ? UNLIMITED : policy.minuteLimit - minuteCount - 1,
          dayLimit: policy.dayLimit, dayRemaining: policy.dayLimit === UNLIMITED ? UNLIMITED : policy.dayLimit - dayCount - 1,
        } };
      }));
      return outcome.result;
    },
    async register(key, options) {
      access.ensureUsable();
      const stable = stableKey(key), policy = { ...keyOptions(options), secretHash: stable.secretHash, createdAt: now() };
      await mutate(stable.id, async () => {
        const current = await keys.read(stable.id);
        if (current.revision !== 0) throw failure(409, 'KEY_ALREADY_EXISTS');
        // 중간 실패는 비활성 후보만 남긴다. 인덱스 준비가 확정되기 전에는 키를 저장하지 않는다.
        for (const origin of policy.origins) await access.write(`apiAccess/origins/${originHash(origin)}/${stable.id}`, true);
        try { await keys.compareAndSet(stable.id, 0, { policy, usage: null }); }
        catch (error) {
          if (error.code === 'USER_STORAGE_CONFLICT') throw failure(409, 'KEY_ALREADY_EXISTS');
          throw error;
        }
      });
    },
    async disable(id) {
      access.ensureUsable();
      checkId(id);
      await mutate(id, () => keys.update(id, (value, current) => {
        if (!current.exists) throw failure(404, 'KEY_NOT_FOUND');
        return { value: { ...value, policy: { ...value.policy, enabled: false, disabledAt: now() } } };
      }));
      // 후보가 남아도 preflight에서 현재 enabled를 확인한다. 키 이력은 삭제하지 않는다.
    },
    async rotate(key) {
      access.ensureUsable();
      const stable = stableKey(key);
      await mutate(stable.id, () => keys.update(stable.id, (value, current) => {
        if (!current.exists) throw failure(404, 'KEY_NOT_FOUND');
        const timestamp = now();
        if (!value.policy.enabled || (value.policy.expiresAt !== null && value.policy.expiresAt <= timestamp)) throw failure(403, 'API_KEY_DISABLED');
        return { value: { ...value, policy: { ...value.policy, secretHash: stable.secretHash, rotatedAt: timestamp } } };
      }));
    },
  };
}

module.exports = { createApiAccessStore, validateApiAccessValue: storedValue };
