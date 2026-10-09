'use strict';
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const KEY_ID = /^[a-f0-9]{24}$/;
const TOKEN = /^ygo_([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;
const scope = 'getCardInfo';
const UNLIMITED = 'unlimited';
const validLimit = (value, max = Number.MAX_SAFE_INTEGER) => value === UNLIMITED ||
  (Number.isSafeInteger(value) && value >= 1 && value <= max);
function failure(status, code) { return Object.assign(new Error(code), { status, code }); }
function newKey(id = randomBytes(12).toString('hex')) {
  if (!KEY_ID.test(id)) throw failure(400, 'INVALID_KEY_ID');
  const secret = randomBytes(32).toString('base64url');
  return { id, token: `ygo_${id}.${secret}`, secretHash: hash(secret) };
}
function validOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch (_) { return false; }
}
function keyOptions({ label, origins = [], minuteLimit = 60, dayLimit = 5000, expiresAt = null }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100 || !Array.isArray(origins) || origins.length > 20 || !origins.every(validOrigin) ||
    !validLimit(minuteLimit, 600) || !validLimit(dayLimit, 100000) ||
    (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) throw failure(400, 'INVALID_KEY_OPTIONS');
  return { label: label.trim(), origins: [...new Set(origins)], minuteLimit, dayLimit, expiresAt, scope, enabled: true };
}
function parseToken(token) {
  const match = typeof token === 'string' && TOKEN.exec(token);
  if (!match) throw failure(401, 'API_KEY_INVALID');
  return { id: match[1], secretHash: hash(match[2]) };
}
function verifyRecord(record, parsed, now) {
  if (!record || typeof record.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.secretHash) ||
    !timingSafeEqual(Buffer.from(record.secretHash, 'hex'), Buffer.from(parsed.secretHash, 'hex'))) throw failure(401, 'API_KEY_INVALID');
  if (!record.enabled || record.scope !== scope || (record.expiresAt !== null && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now))) throw failure(403, 'API_KEY_DISABLED');
  if (!Array.isArray(record.origins) || !record.origins.every(validOrigin) ||
      !validLimit(record.minuteLimit) || !validLimit(record.dayLimit)) throw failure(503, 'API_UNAVAILABLE');
  return record;
}
function createCardApiAccess(db, clock = Date.now) {
  const keyRef = id => db.collection('cardApiKeys').doc(id);
  const corsRef = db.collection('cardApiConfig').doc('cors');
  return {
    async authenticate(token) {
      const parsed = parseToken(token);
      return { id: parsed.id, ...verifyRecord((await keyRef(parsed.id).get()).data(), parsed, clock()) };
    },
    async allowsPreflight(origin) {
      const config = (await corsRef.get()).data();
      return validOrigin(origin) && Object.values(config?.keyOrigins || {}).some(origins => Array.isArray(origins) && origins.includes(origin));
    },
    async consume(token, origin) {
      const parsed = parseToken(token);
      return db.runTransaction(async tx => {
        const record = verifyRecord((await tx.get(keyRef(parsed.id))).data(), parsed, clock());
        if (origin !== undefined && !record.origins.includes(origin)) throw failure(403, 'ORIGIN_NOT_ALLOWED');
        const now = clock(), minute = Math.floor(now / 60000), day = Math.floor(now / 86400000);
        const ref = db.collection('cardApiUsage').doc(parsed.id);
        const old = (await tx.get(ref)).data() || {};
        const minuteCount = old.minute === minute ? old.minuteCount : 0;
        const dayCount = old.day === day ? old.dayCount : 0;
        if (![minuteCount, dayCount].every(n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)) throw failure(503, 'API_UNAVAILABLE');
        const minuteExceeded = record.minuteLimit !== UNLIMITED && minuteCount >= record.minuteLimit;
        const dayExceeded = record.dayLimit !== UNLIMITED && dayCount >= record.dayLimit;
        if (minuteExceeded || dayExceeded) {
          const reset = dayExceeded ? (day + 1) * 86400000 : (minute + 1) * 60000;
          throw Object.assign(failure(429, 'RATE_LIMIT_EXCEEDED'), { retryAfter: Math.max(1, Math.ceil((reset - now) / 1000)) });
        }
        tx.set(ref, { minute, day, minuteCount: minuteCount + 1, dayCount: dayCount + 1 });
        return { minuteLimit: record.minuteLimit, minuteRemaining: record.minuteLimit === UNLIMITED ? UNLIMITED : record.minuteLimit - minuteCount - 1,
          dayLimit: record.dayLimit, dayRemaining: record.dayLimit === UNLIMITED ? UNLIMITED : record.dayLimit - dayCount - 1 };
      });
    },
    // 키 원문은 저장하지 않는다. 도구에서 안전한 출력 파일을 만든 뒤 등록한다.
    async register(key, options) {
      const record = keyOptions(options);
      if (!KEY_ID.test(key.id) || !/^[a-f0-9]{64}$/.test(key.secretHash)) throw failure(400, 'INVALID_KEY_ID');
      await db.runTransaction(async tx => {
        const ref = keyRef(key.id);
        if ((await tx.get(ref)).exists) throw failure(409, 'KEY_ALREADY_EXISTS');
        const config = (await tx.get(corsRef)).data() || {};
        tx.create(ref, { ...record, secretHash: key.secretHash, createdAt: clock() });
        tx.set(corsRef, { keyOrigins: { ...(config.keyOrigins || {}), [key.id]: record.origins } });
      });
    },
    async disable(id) {
      if (!KEY_ID.test(id)) throw failure(400, 'INVALID_KEY_ID');
      await db.runTransaction(async tx => {
        const ref = keyRef(id);
        if (!(await tx.get(ref)).exists) throw failure(404, 'KEY_NOT_FOUND');
        const config = (await tx.get(corsRef)).data() || {};
        const keyOrigins = { ...(config.keyOrigins || {}) }; delete keyOrigins[id];
        tx.update(ref, { enabled: false, disabledAt: clock() });
        tx.set(corsRef, { keyOrigins });
      });
    },
    async rotate(key) {
      if (!KEY_ID.test(key.id) || !/^[a-f0-9]{64}$/.test(key.secretHash)) throw failure(400, 'INVALID_KEY_ID');
      await db.runTransaction(async tx => {
        const ref = keyRef(key.id), record = (await tx.get(ref)).data();
        if (!record) throw failure(404, 'KEY_NOT_FOUND');
        if (!record.enabled || (record.expiresAt !== null && record.expiresAt <= clock())) throw failure(403, 'API_KEY_DISABLED');
        tx.update(ref, { secretHash: key.secretHash, rotatedAt: clock() });
      });
    },
  };
}
module.exports = { UNLIMITED, createCardApiAccess, newKey, keyOptions, validOrigin, failure };
