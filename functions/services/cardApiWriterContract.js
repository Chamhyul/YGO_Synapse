'use strict';
const { UNLIMITED, verifyRecord, validOrigin, failure } = require('./cardApiAccess');
const { validateApiAccessValue } = require('./user-storage/apiAccessStore');
const { fingerprint } = require('./userMigrationRehearsal');
const fail = code => Object.assign(new Error('API 접근 자료와 전환 영수증을 확인해 주세요.'), { code });
function checkApiKey(key) {
  if (typeof key !== 'string' || !/^apiKey\/[a-f0-9]{24}$/.test(key)) throw fail('API_WRITER_INVALID_KEY');
  return key.slice(7);
}
function apiValue(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'corsOrigins,policy,usage') throw fail('API_WRITER_MIGRATION_REQUIRED');
  validateApiAccessValue({ policy: value.policy, usage: value.usage });
  const { policy, corsOrigins } = value;
  if (corsOrigins !== null && (!Array.isArray(corsOrigins) || !corsOrigins.every(validOrigin)
      || !policy.enabled || policy.scope !== 'getCardInfo' || fingerprint(corsOrigins) !== fingerprint(policy.origins))
      || corsOrigins === null && policy.enabled && policy.scope === 'getCardInfo' && policy.origins.length) throw fail('API_WRITER_MIGRATION_REQUIRED');
  return value;
}
function consumeValue(value, parsed, origin, at) {
  if (!Number.isSafeInteger(at) || at < 0) throw failure(503, 'API_UNAVAILABLE');
  const policy = verifyRecord(value?.policy, parsed, at);
  if (origin !== null && (!validOrigin(origin) || !policy.origins.includes(origin))) throw failure(403, 'ORIGIN_NOT_ALLOWED');
  const minute = Math.floor(at / 60000), day = Math.floor(at / 86400000), old = value.usage;
  const minuteCount = old?.minute === minute ? old.minuteCount : 0, dayCount = old?.day === day ? old.dayCount : 0;
  if ([minuteCount, dayCount].some(count => !Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER)) throw failure(503, 'API_UNAVAILABLE');
  const dayExceeded = policy.dayLimit !== UNLIMITED && dayCount >= policy.dayLimit;
  if (dayExceeded || policy.minuteLimit !== UNLIMITED && minuteCount >= policy.minuteLimit) throw Object.assign(failure(429, 'RATE_LIMIT_EXCEEDED'), {
    retryAfter: Math.max(1, Math.ceil(((dayExceeded ? (day + 1) * 86400000 : (minute + 1) * 60000) - at) / 1000)),
  });
  return { value: { ...value, usage: { minute, day, minuteCount: minuteCount + 1, dayCount: dayCount + 1 } }, result: {
    minuteLimit: policy.minuteLimit, minuteRemaining: policy.minuteLimit === UNLIMITED ? UNLIMITED : policy.minuteLimit - minuteCount - 1,
    dayLimit: policy.dayLimit, dayRemaining: policy.dayLimit === UNLIMITED ? UNLIMITED : policy.dayLimit - dayCount - 1,
  } };
}
function checkApiCommand(op) {
  if (op.changes?.length !== 1 || op.details?.kind !== 'apiAccess' || !['register', 'disable', 'rotate', 'consume'].includes(op.details.action)) throw fail('API_WRITER_INVALID_COMMAND');
  const entry = op.changes[0]; checkApiKey(entry.key);
  if (!entry.exists) throw fail('API_WRITER_INVALID_COMMAND'); apiValue(entry.value);
  if (op.details.action === 'consume' && (!/^[a-f0-9]{64}$/.test(op.details.secretHash || '') || op.details.origin !== null && !validOrigin(op.details.origin))) throw fail('API_WRITER_INVALID_COMMAND');
  return entry;
}
// 실제 승인 시점의 만료·고정 창·최신 정책을 검사한다. 시간 경계는 취소 영수증을 남긴 뒤 새로 계산한다.
function inactive(op, current, clock) {
  if (op.details.action !== 'consume' && op.details.action !== 'rotate') return false;
  const at = clock(); if (!Number.isSafeInteger(at) || at < 0) throw failure(503, 'API_UNAVAILABLE');
  if (op.details.action === 'rotate') return !current.exists || !current.value.policy.enabled
    || current.value.policy.expiresAt !== null && current.value.policy.expiresAt <= at;
  try {
    const planned = consumeValue(current.value, { id: checkApiKey(current.key), secretHash: op.details.secretHash }, op.details.origin, at);
    return fingerprint(planned.value) !== fingerprint(op.changes[0].value) || fingerprint(planned.result) !== fingerprint(op.result);
  } catch (error) { if ([401, 403, 429].includes(error.status)) return true; throw error; }
}
module.exports = { checkApiKey, apiValue, consumeValue, checkApiCommand, inactive };
