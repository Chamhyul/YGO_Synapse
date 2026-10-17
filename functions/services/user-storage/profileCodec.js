'use strict';

const { encodeKey, decodeKey, encodeValue, decodeValue, UserStorageCodecError,
  MAX_DEPTH, MAX_PATH_BYTES } = require('./codec');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const timePaths = new Set([['createdAt'], ['updatedAt'], ['registration', 'consent', 'acceptedAt']].map(path => JSON.stringify(path)));
const invalid = () => Object.assign(new Error('프로필 서버 시각 필드가 올바르지 않습니다.'),
  { code: 'USER_STORAGE_INVALID_SERVER_TIMESTAMP' });
const corrupt = () => new UserStorageCodecError('user-storage/invalid-format', '프로필 서버 시각 저장 형식이 올바르지 않습니다.');

function serverTimestampPaths(value, paths = []) {
  if (!Array.isArray(paths)) throw invalid();
  const result = [], seen = new Set();
  for (const path of paths) {
    if (!Array.isArray(path) || path.some(part => typeof part !== 'string')
        || !timePaths.has(JSON.stringify(path)) || seen.has(JSON.stringify(path))) throw invalid();
    let node = value;
    for (const key of path) {
      if (!plain(node) || !own(node, key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor?.enumerable || !own(descriptor, 'value')) throw invalid();
      node = descriptor.value;
    }
    // 명시적으로 지정한 새 patch의 null 자리만 서버 값으로 바꾼다.
    if (node !== null) throw invalid();
    seen.add(JSON.stringify(path));
    result.push([...path]);
  }
  return result;
}

// 범용 코덱 검사를 이미 통과한 payload에 추가한 .sv의 실제 깊이/길이도 검사한다.
function validatePhysicalPaths(payload, options = {}) {
  const base = (options.basePath ?? '').replace(/^\/|\/$/g, '');
  const parts = base ? base.split('/') : [];
  const baseDepth = options.baseDepth ?? parts.length;
  const baseBytes = Math.max(1, parts.length) + parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
  function visit(node, depth, bytes, segments) {
    if (depth > MAX_DEPTH) throw new UserStorageCodecError('user-storage/depth-exceeded', '프로필 서버 시각이 RTDB 경로 깊이 한도를 초과합니다.');
    if (bytes > MAX_PATH_BYTES) throw new UserStorageCodecError('user-storage/path-too-long', '프로필 서버 시각이 RTDB 경로 길이 한도를 초과합니다.');
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) visit(node[key], depth + 1,
      bytes + (segments ? 1 : 0) + Buffer.byteLength(key), segments + 1);
  }
  visit(payload, baseDepth, baseBytes, parts.length);
}

function decodeServerTimes(payload, options) {
  const active = new WeakSet();
  function visit(node, path) {
    if (!node || typeof node !== 'object') return node;
    if (!plain(node) || active.has(node)) throw corrupt();
    const keys = Reflect.ownKeys(node);
    if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(node, key)?.enumerable
        || !own(Object.getOwnPropertyDescriptor(node, key), 'value'))) throw corrupt();
    if (node.t === 'server-time') {
      if (!path || !timePaths.has(JSON.stringify(path))
          || keys.length !== 2 || !own(node, 'v') || !own(node, 't')
          || !Number.isSafeInteger(node.v) || node.v < -62135596800000 || node.v > 253402300799999) throw corrupt();
      const seconds = Math.floor(node.v / 1000);
      return { t: 'timestamp', s: seconds, n: (node.v - seconds * 1000) * 1000000 };
    }
    active.add(node);
    try {
      const result = {};
      for (const key of keys) {
        let childPath;
        if (path && node.t === 'object' && key !== 't' && key !== 'p') childPath = [...path, decodeKey(key)];
        Object.defineProperty(result, key, { value: visit(node[key], childPath), enumerable: true,
          writable: true, configurable: true });
      }
      return result;
    } finally { active.delete(node); }
  }
  // envelope 검증은 범용 코덱에 위임하며 value 아래에서만 논리 경로를 추적한다.
  if (!plain(payload) || Reflect.ownKeys(payload).length !== 2
      || !own(payload, 'version') || !own(payload, 'value')
      || ['version', 'value'].some(key => !Object.getOwnPropertyDescriptor(payload, key)?.enumerable
        || !own(Object.getOwnPropertyDescriptor(payload, key), 'value'))) throw corrupt();
  const normalized = { version: payload.version, value: visit(payload.value, []) };
  const value = decodeValue(normalized, options);
  validatePhysicalPaths(payload, options);
  return value;
}

function createProfilePayloadCodec(customCodec) {
  const base = customCodec ?? { encode: encodeValue, decode: decodeValue };
  if (!base || typeof base.encode !== 'function' || typeof base.decode !== 'function') {
    throw Object.assign(new Error('사용자 저장소 설정이 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_CONFIG' });
  }
  const isGeneric = base.encode === encodeValue && base.decode === decodeValue;
  const requested = new WeakMap();
  return {
    withServerTimestamps(value, paths) {
      const stablePaths = serverTimestampPaths(value, paths);
      if (stablePaths.length && !isGeneric) throw invalid();
      if (stablePaths.length) requested.set(value, stablePaths);
      return value;
    },
    encode(value, options) {
      const encoded = base.encode(value, options);
      for (const path of requested.get(value) ?? []) {
        let node = encoded.value;
        for (const key of path.slice(0, -1)) node = node[encodeKey(key)];
        node[encodeKey(path.at(-1))] = { t: 'server-time', v: { '.sv': 'timestamp' } };
      }
      if (requested.has(value)) validatePhysicalPaths(encoded, options);
      return encoded;
    },
    decode: isGeneric ? decodeServerTimes : (...args) => base.decode(...args),
  };
}

module.exports = { createProfilePayloadCodec, serverTimestampPaths };
