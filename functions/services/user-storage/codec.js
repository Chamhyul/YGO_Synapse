'use strict';

const { Timestamp } = require('firebase-admin/firestore');

const VERSION = 1;
const MAX_KEY_BYTES = 768;
const MAX_PATH_BYTES = 768;
const MAX_DEPTH = 32;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class UserStorageCodecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserStorageCodecError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UserStorageCodecError(`user-storage/${code}`, message);
}

// 원문 정규화·치환을 하지 않는다. 접두사는 빈 키와 숫자 배열 판정을 함께 피한다.
function encodeKey(key) {
  if (typeof key !== 'string' || Buffer.from(key, 'utf8').toString('utf8') !== key) {
    fail('invalid-key', '저장 키는 손상되지 않은 Unicode 문자열이어야 합니다.');
  }
  const encoded = `k${Buffer.from(key, 'utf8').toString('base64url')}`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_KEY_BYTES) {
    fail('key-too-long', '인코딩한 저장 키가 RTDB의 768바이트 한도를 초과합니다.');
  }
  return encoded;
}

function decodeKey(encoded) {
  if (typeof encoded !== 'string' || !/^k[A-Za-z0-9_-]*$/.test(encoded)) {
    fail('invalid-key', '지원하지 않는 저장 키 형식입니다.');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_KEY_BYTES) {
    fail('key-too-long', '인코딩한 저장 키가 RTDB의 768바이트 한도를 초과합니다.');
  }
  const bytes = Buffer.from(encoded.slice(1), 'base64url');
  const decoded = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(decoded, 'utf8')) || encodeKey(decoded) !== encoded) {
    fail('invalid-key', '손상되었거나 정규 형식이 아닌 저장 키입니다.');
  }
  return decoded;
}

function storageLocation(options) {
  let parts = [];
  const hasPath = options?.basePath !== undefined;
  if (hasPath) {
    const path = options.basePath;
    if (typeof path !== 'string' || Buffer.from(path, 'utf8').toString('utf8') !== path) {
      fail('invalid-path', '저장 경로는 손상되지 않은 Unicode 문자열이어야 합니다.');
    }
    const normalized = path.replace(/^\/|\/$/g, '');
    parts = path === '' || path === '/' ? [] : normalized.split('/');
    if (parts.some(part => !part || /[.#$\[\]\u0000-\u001f\u007f]/.test(part))) {
      fail('invalid-path', '저장 경로에 빈 구간 또는 RTDB에서 금지한 문자가 있습니다.');
    }
  }
  const depth = options?.baseDepth ?? (hasPath ? parts.length : 0);
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    fail('depth-exceeded', '저장 경로 깊이는 0부터 32까지의 정수여야 합니다.');
  }
  if (hasPath && depth !== parts.length) {
    fail('invalid-path', '저장 경로와 지정한 경로 깊이가 일치하지 않습니다.');
  }
  // SDK ValidationPath와 동일하게 선행 / 및 각 경로 구분자를 포함한다.
  const bytes = Math.max(1, parts.length) + parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0);
  checkPathBytes(bytes);
  return { depth, bytes, segments: parts.length };
}

function checkDepth(depth) {
  if (depth > MAX_DEPTH) fail('depth-exceeded', '저장 경로와 값의 총 깊이가 RTDB의 32단계 한도를 초과합니다.');
}

function checkPathBytes(bytes) {
  if (bytes > MAX_PATH_BYTES) fail('path-too-long', '저장 값의 전체 경로가 RTDB의 768바이트 한도를 초과합니다.');
}

// 구조 검사를 마친 encoded envelope를 순회한다. 사용자 키뿐 아니라 version,
// value, 태그와 배열 인덱스도 SDK가 검사하는 실제 하위 경로에 포함된다.
function validateStoragePaths(envelope, location) {
  function visit(value, depth, bytes, segments) {
    checkDepth(depth);
    checkPathBytes(bytes);
    if (value === null || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      visit(value[key], depth + 1, bytes + (segments ? 1 : 0) + Buffer.byteLength(key, 'utf8'), segments + 1);
    }
  }
  visit(envelope, location.depth, location.bytes, location.segments);
}

function properties(value, code) {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !own(descriptor, 'value')
        || (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) {
      fail(code, 'Symbol 키, 접근자 또는 숨겨진 속성은 저장 형식으로 지원하지 않습니다.');
    }
  }
  return keys;
}

function isPlain(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireFields(node, expected) {
  const keys = properties(node, 'invalid-format');
  if (keys.length !== expected.length || expected.some(key => !own(node, key))) {
    fail('invalid-format', '저장 값의 필드 구성이 올바르지 않습니다.');
  }
}

function define(target, key, value) {
  // __proto__도 상속 상태를 바꾸지 않는 일반 데이터 속성으로 복원한다.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function validTimestamp(seconds, nanoseconds) {
  return Number.isSafeInteger(seconds) && seconds >= -62135596800 && seconds <= 253402300799
    && Number.isSafeInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds < 1e9;
}

/**
 * version은 인벤토리 version과 별개다. 모든 객체는 태그와 인코딩 자식 키를
 * 같은 층에 두어 원본 중첩 하나당 RTDB 깊이 하나만 추가한다.
 * 저장할 때는 basePath에 이 envelope의 실제 DB 경로를 전달해야 한다.
 * baseDepth도 지정하면 경로 세그먼트 수와 일치해야 한다. 기존 baseDepth 단독
 * 호출은 깊이와 상대 경로 길이만 검사하며 알 수 없는 상위 키 길이는 추정하지 않는다.
 */
function encodeValue(value, options) {
  const location = storageLocation(options);
  const baseDepth = location.depth;
  checkDepth(baseDepth + 1);
  const ancestors = new WeakSet();
  function encode(input, depth) {
    checkDepth(depth);
    if (typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('unsupported-value', '유한한 숫자만 저장할 수 있습니다.');
      if (!Object.is(input, -0)) return input;
      checkDepth(depth + 1);
      return { t: 'negative-zero' };
    }
    checkDepth(depth + 1);
    if (input === null) return { t: 'null' };
    if (typeof input !== 'object') fail('unsupported-value', '지원하지 않는 저장 값 형식입니다.');
    if (ancestors.has(input)) fail('unsupported-value', '순환 참조는 저장할 수 없습니다.');
    if (input instanceof Timestamp) {
      const keys = Reflect.ownKeys(input);
      if (keys.some(key => !['_seconds', '_nanoseconds'].includes(key))
          || !validTimestamp(input.seconds, input.nanoseconds)) {
        fail('unsupported-value', '손상되었거나 추가 속성이 있는 Timestamp는 지원하지 않습니다.');
      }
      return { t: 'timestamp', s: input.seconds, n: input.nanoseconds };
    }
    if (input instanceof Date) {
      const millis = input.getTime();
      if (Reflect.ownKeys(input).length || !Number.isFinite(millis)) {
        fail('unsupported-value', '손상되었거나 추가 속성이 있는 Date는 지원하지 않습니다.');
      }
      return { t: 'date', v: millis };
    }
    if (!Array.isArray(input) && !isPlain(input)) {
      fail('unsupported-value', '일반 객체와 배열만 저장할 수 있습니다.');
    }
    ancestors.add(input);
    try {
      const keys = properties(input, 'unsupported-value');
      if (Array.isArray(input)) {
        const node = { t: 'array', l: input.length };
        for (const key of keys) {
          if (key === 'length') continue;
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= input.length || String(index) !== key) {
            fail('unsupported-value', '배열에는 정규 인덱스 외의 속성을 저장할 수 없습니다.');
          }
          node[`i${key}`] = encode(input[key], depth + 1);
        }
        return node;
      }
      const node = { t: 'object', p: Object.getPrototypeOf(input) === null ? 'null' : 'object' };
      for (const key of keys) node[encodeKey(key)] = encode(input[key], depth + 1);
      return node;
    } finally {
      ancestors.delete(input);
    }
  }
  const envelope = { version: VERSION, value: encode(value, baseDepth + 1) };
  validateStoragePaths(envelope, location);
  return envelope;
}

function decodeValue(envelope, options) {
  const location = storageLocation(options);
  const baseDepth = location.depth;
  checkDepth(baseDepth + 1);
  if (!isPlain(envelope)) fail('invalid-format', '저장 값 envelope가 올바르지 않습니다.');
  requireFields(envelope, ['version', 'value']);
  if (envelope.version !== VERSION) fail('invalid-format', '지원하지 않는 저장 형식 버전입니다.');
  const ancestors = new WeakSet();
  function decode(node, depth) {
    checkDepth(depth);
    if (typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number' && Number.isFinite(node) && !Object.is(node, -0)) return node;
    checkDepth(depth + 1);
    if (!isPlain(node) || ancestors.has(node)) fail('invalid-format', '손상된 저장 값입니다.');
    const keys = properties(node, 'invalid-format');
    if (!own(node, 't')) fail('invalid-format', '저장 값의 형식 태그가 없습니다.');
    ancestors.add(node);
    try {
      switch (node.t) {
        case 'null':
          requireFields(node, ['t']);
          return null;
        case 'negative-zero':
          requireFields(node, ['t']);
          return -0;
        case 'timestamp':
          requireFields(node, ['t', 's', 'n']);
          if (!validTimestamp(node.s, node.n)) fail('invalid-format', '저장 Timestamp 범위가 올바르지 않습니다.');
          return new Timestamp(node.s, node.n);
        case 'date':
          requireFields(node, ['t', 'v']);
          if (!Number.isSafeInteger(node.v) || Math.abs(node.v) > 8640000000000000) {
            fail('invalid-format', '저장 Date 범위가 올바르지 않습니다.');
          }
          return new Date(node.v);
        case 'array': {
          if (!own(node, 'l') || !Number.isSafeInteger(node.l) || node.l < 0 || node.l > 4294967295) {
            fail('invalid-format', '저장 배열 길이가 올바르지 않습니다.');
          }
          const result = new Array(node.l);
          for (const key of keys) {
            if (key === 't' || key === 'l') continue;
            if (!/^i(?:0|[1-9][0-9]*)$/.test(key)) fail('invalid-format', '저장 배열 인덱스가 올바르지 않습니다.');
            const index = Number(key.slice(1));
            if (!Number.isSafeInteger(index) || index >= node.l || `i${index}` !== key) {
              fail('invalid-format', '저장 배열 인덱스가 범위를 벗어났습니다.');
            }
            define(result, String(index), decode(node[key], depth + 1));
          }
          return result;
        }
        case 'object': {
          if (!own(node, 'p') || !['object', 'null'].includes(node.p)) {
            fail('invalid-format', '저장 객체의 원형 표시가 올바르지 않습니다.');
          }
          const result = node.p === 'null' ? Object.create(null) : {};
          for (const key of keys) {
            if (key === 't' || key === 'p') continue;
            let decodedKey;
            try { decodedKey = decodeKey(key); }
            catch (error) {
              if (!(error instanceof UserStorageCodecError)) throw error;
              fail('invalid-format', '저장 객체의 키가 손상되었습니다.');
            }
            define(result, decodedKey, decode(node[key], depth + 1));
          }
          return result;
        }
        default:
          fail('invalid-format', '지원하지 않는 저장 값 태그입니다.');
      }
    } finally {
      ancestors.delete(node);
    }
  }
  const result = decode(envelope.value, baseDepth + 1);
  validateStoragePaths(envelope, location);
  return result;
}

module.exports = { encodeKey, decodeKey, encodeValue, decodeValue, UserStorageCodecError,
  VERSION, MAX_KEY_BYTES, MAX_PATH_BYTES, MAX_DEPTH };
