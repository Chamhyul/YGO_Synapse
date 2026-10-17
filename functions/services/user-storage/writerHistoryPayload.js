'use strict';
const { createHash } = require('node:crypto');
const { encodeValue, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const fail = () => Object.assign(new Error('전환 이력의 본문 참조를 확인하지 못했습니다.'), { code: 'WRITER_HISTORY_CONFLICT' });
const hash = encoded => createHash('sha256').update(encoded).digest('hex');
const clone = value => decodeValue(encodeValue(value));
const MIN_BODY_BYTES = 256;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const canonical = value => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function analyze(value) {
  const encoded = encodeValue(value);
  return { encoded, digest: hash(JSON.stringify(canonical(encoded))), bytes: Buffer.byteLength(JSON.stringify(encoded)) };
}

// 사용자 값 안의 특정 표식을 해석하지 않는다. 별도 경로 목록의 null 자리만 복원한다.
function pack(value) {
  return packEncoded(encodeValue(value));
}
// 확인한 루트 코덱을 재사용하여 같은 원문 전체를 다시 인코딩하지 않는다.
function packEncoded(encoded) {
  const saved = decodeValue(encoded), refs = [], bodies = new Map();
  function take(parent, key, path) {
    if (!own(parent, key)) return;
    const encoded = JSON.stringify(encodeValue(parent[key])), bytes = Buffer.byteLength(encoded);
    if (bytes < MIN_BODY_BYTES) return;
    if (bytes > MAX_BODY_BYTES) throw fail();
    const digest = hash(encoded);
    bodies.set(digest, { format: 1, digest, encoded });
    refs.push({ path, digest }); parent[key] = null;
  }
  for (const [parent, prefix] of [[saved, []], [saved.receipt, ['receipt']]]) {
    if (Array.isArray(parent?.changes)) parent.changes.forEach((entry, n) => take(entry, 'value', [...prefix, 'changes', String(n), 'value']));
    take(parent, 'result', [...prefix, 'result']);
  }
  if (Array.isArray(saved.details?.blobs)) {
    saved.details.blobs.forEach((blob, n) => take(blob, 'value', ['details', 'blobs', String(n), 'value']));
  } else take(saved, 'details', ['details']);
  return { value: saved, refs, bodies };
}
function decodeBody(body, digest) {
  if (!body || Object.keys(body).length !== 3 || body.format !== 1 || body.digest !== digest
      || typeof body.encoded !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || Buffer.byteLength(body.encoded) < MIN_BODY_BYTES || Buffer.byteLength(body.encoded) > MAX_BODY_BYTES
      || hash(body.encoded) !== digest) throw fail();
  try {
    const value = decodeValue(JSON.parse(body.encoded));
    if (JSON.stringify(encodeValue(value)) !== body.encoded) throw fail();
    return value;
  } catch { throw fail(); }
}
async function unpackChecked(envelope, load) {
  if (!Array.isArray(envelope.refs)) throw fail();
  const value = clone(envelope.value), seen = new Set(), cache = new Map();
  for (const ref of envelope.refs) {
    if (!ref || Object.keys(ref).length !== 2 || !Array.isArray(ref.path)
        || !/^[a-f0-9]{64}$/.test(ref.digest)) throw fail();
    const path = ref.path, name = path.join('/');
    // 메타정보나 임의의 사용자 키를 참조 대상으로 덮어쓰지 않는다.
    if (!path.every(part => typeof part === 'string') || seen.has(name)
        || !/^(?:(?:receipt\/)?changes\/(?:0|[1-9][0-9]*)\/value|(?:receipt\/)?result|details(?:\/blobs\/(?:0|[1-9][0-9]*)\/value)?)$/.test(name)) throw fail();
    seen.add(name);
    let parent = value;
    for (const key of path.slice(0, -1)) { if (!own(parent, key)) throw fail(); parent = parent[key]; }
    const key = path.at(-1);
    if (!own(parent, key) || parent[key] !== null) throw fail();
    if (!cache.has(ref.digest)) cache.set(ref.digest, decodeBody(await load(ref.digest), ref.digest));
    parent[key] = clone(cache.get(ref.digest));
  }
  const stats = analyze(value), rebuilt = packEncoded(stats.encoded);
  if (stats.digest !== envelope.digest || fingerprint({ value: rebuilt.value, refs: rebuilt.refs })
      !== fingerprint({ value: envelope.value, refs: envelope.refs })) throw fail();
  return { value, stats };
}
const unpack = async (envelope, load) => (await unpackChecked(envelope, load)).value;
module.exports = { pack, packEncoded, unpack, unpackChecked, analyze, decodeBody, MIN_BODY_BYTES };
