'use strict';
const { decodeKey, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const { validateStoragePath } = require('./storageAccess');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = () => Object.assign(new Error('전환 이력의 요약 색인을 확인하지 못했습니다.'), { code: 'WRITER_HISTORY_CONFLICT' });
const compactDigest = digest => Buffer.from(digest, 'hex').toString('base64url');
function expandDigest(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw fail();
  return bytes.toString('hex');
}
function validateSummary(e, kind, id) {
  const s = e?.value;
  if (e?.format !== 1 || e.kind !== kind || Object.keys(e).length !== 4
      || !s || s.id !== id || s.kind !== kind || !/^[a-f0-9]{64}$/.test(s.digest)
      || e.digest !== fingerprint(s) || !Number.isSafeInteger(s.bytes) || s.bytes < 0
      || (kind === 'operations' ? !['completed', 'cancelled'].includes(s.status) : !['completed', 'recovered'].includes(s.status))
      || Object.keys(s).some(key => !['id', 'kind', 'status', 'digest', 'bytes', 'backend', 'epoch', 'capturedSequence', 'recoveryId'].includes(key))
      || (own(s, 'backend') && !['legacy', 'rtdb'].includes(s.backend))
      || ['epoch', 'capturedSequence'].some(key => own(s, key) && (!Number.isSafeInteger(s[key]) || s[key] < 0))
      || (own(s, 'recoveryId') && !/^[a-f0-9]{32}$/.test(s.recoveryId))) throw fail();
  return s;
}
function createSummaryCodec({ path, kind }) {
  if (!['operations', 'external'].includes(kind)) throw fail();
  validateStoragePath(path);
  const statuses = ['completed', 'cancelled', 'recovered'];
  function idFor(options) {
    const base = options?.basePath;
    if (typeof base !== 'string' || !base.startsWith(`${path}/`) || !base.endsWith('/payload')) throw fail();
    const key = base.slice(path.length + 1, -8); if (key.includes('/')) throw fail();
    const id = decodeKey(key); if (!/^[a-f0-9]{32}$/.test(id)) throw fail();
    return id;
  }
  function encode(e, options) {
    const s = validateSummary(e, kind, idFor(options));
    const raw = { v: 2, s: statuses.indexOf(s.status), d: compactDigest(s.digest), b: s.bytes, h: compactDigest(e.digest) };
    if (own(s, 'backend')) raw.t = s.backend === 'legacy' ? 0 : 1;
    if (own(s, 'epoch')) raw.e = s.epoch;
    if (own(s, 'capturedSequence')) raw.q = s.capturedSequence;
    if (own(s, 'recoveryId')) raw.r = s.recoveryId;
    for (const key of Object.keys(raw)) validateStoragePath(`${options.basePath}/${key}`);
    return raw;
  }
  function decode(raw, options) {
    const id = idFor(options);
    // 기존 범용 payload는 읽기만 지원하고 원래 불변 레코드를 갱신하지 않는다.
    if (raw?.version === 1) { const e = decodeValue(raw, options); validateSummary(e, kind, id); return e; }
    const required = ['v', 's', 'd', 'b', 'h'], allowed = [...required, 't', 'e', 'q', 'r'];
    if (!raw || raw.v !== 2 || Array.isArray(raw) || required.some(key => !own(raw, key))
        || Object.keys(raw).some(key => !allowed.includes(key)) || !Number.isSafeInteger(raw.s) || raw.s < 0 || raw.s > 2
        || (own(raw, 't') && ![0, 1].includes(raw.t))) throw fail();
    for (const key of Object.keys(raw)) validateStoragePath(`${options.basePath}/${key}`);
    const s = { id, kind, status: statuses[raw.s], digest: expandDigest(raw.d), bytes: raw.b };
    if (own(raw, 't')) s.backend = raw.t === 0 ? 'legacy' : 'rtdb';
    if (own(raw, 'e')) s.epoch = raw.e;
    if (own(raw, 'q')) s.capturedSequence = raw.q;
    if (own(raw, 'r')) s.recoveryId = raw.r;
    const e = { format: 1, kind, value: s, digest: expandDigest(raw.h) }; validateSummary(e, kind, id); return e;
  }
  return { encode, decode };
}
module.exports = { createSummaryCodec, validateSummary };
