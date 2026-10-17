'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeKey, decodeKey, encodeValue, decodeValue, UserStorageCodecError } = require('../services/user-storage/codec');

const roundtrip = value => decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
const errorCode = code => error => error instanceof UserStorageCodecError && error.code === `user-storage/${code}`;
const envelope = value => ({ version: 1, value });

test('키는 금지 문자·빈 문자열·정규화가 다른 Unicode를 충돌 없이 복원한다', () => {
  const keys = ['', '.', '$', '#', '[a]', 'a/b', '\u0000\n\u007f', '한글😀', 'é', 'e\u0301', '0', '__proto__', 'prototype', 'constructor'];
  const encoded = keys.map(encodeKey);
  assert.equal(new Set(encoded).size, keys.length);
  encoded.forEach((key, index) => {
    assert.match(key, /^k[A-Za-z0-9_-]*$/);
    assert.equal(decodeKey(key), keys[index]);
  });
  assert.equal(Buffer.byteLength(encodeKey('a'.repeat(575))), 768);
  assert.throws(() => encodeKey('a'.repeat(576)), errorCode('key-too-long'));
  assert.throws(() => encodeKey('\ud800'), errorCode('invalid-key'));
  for (const malformed of ['bad/key', 'ka', 'kYQ=', 'kYR', 'k_w', '', null, 42]) {
    assert.throws(() => decodeKey(malformed), errorCode('invalid-key'));
  }
});

test('값은 null·빈 컨테이너·희소 배열·숫자·날짜·Timestamp의 나노초를 보존한다', () => {
  const sparse = new Array(5);
  sparse[1] = null;
  sparse[3] = [];
  const input = { null: null, object: {}, array: [], sparse, text: '카드😀', bool: false,
    values: [0, -0, Number.MIN_VALUE, Number.MAX_VALUE, 0.1],
    date: new Date('2026-10-12T00:00:00.123Z'),
    stamp: new Timestamp(1791763200, 123456789) };
  const result = roundtrip(input);
  assert.deepEqual(result, input);
  assert.equal(0 in result.sparse, false);
  assert.equal(1 in result.sparse, true);
  assert.equal(4 in result.sparse, false);
  assert.ok(Object.is(result.values[1], -0));
  assert.equal(result.stamp.nanoseconds, 123456789);
  assert.ok(result.stamp instanceof Timestamp);
  assert.deepEqual(roundtrip(new Timestamp(-62135596800, 0)), new Timestamp(-62135596800, 0));
  assert.deepEqual(roundtrip(new Timestamp(253402300799, 999999999)), new Timestamp(253402300799, 999999999));
});

test('공격 형태 키와 태그 모양의 사용자 값은 일반 데이터로 복원한다', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"prototype":1,"constructor":2,"t":"null","p":"object","version":1,"value":{"t":"timestamp","s":1,"n":2}}');
  input['수록.번호/#[$]'] = '원문';
  const result = roundtrip(input);
  assert.deepEqual(result, input);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  const nullPrototype = Object.create(null);
  nullPrototype.__proto__ = '데이터';
  assert.deepEqual(roundtrip(nullPrototype), nullPrototype);
});

test('undefined·비유한 숫자·실행 값·순환·누락될 속성은 명확히 거부한다', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('값'),
    { a: undefined }, [undefined], new Date(NaN), new Map(), new Set(), Buffer.from('a')]) {
    assert.throws(() => encodeValue(value), errorCode('unsupported-value'));
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => encodeValue(cyclic), errorCode('unsupported-value'));
  const array = []; array.extra = '손실 방지';
  assert.throws(() => encodeValue(array), errorCode('unsupported-value'));
  const accessor = Object.defineProperty({}, 'a', { enumerable: true, get() { throw Error('실행 금지'); } });
  assert.throws(() => encodeValue(accessor), errorCode('unsupported-value'));
  assert.throws(() => encodeValue({ [Symbol('키')]: 1 }), errorCode('unsupported-value'));
  assert.throws(() => encodeValue(Object.defineProperty({}, 'hidden', { value: 1 })), errorCode('unsupported-value'));
  const shared = { a: 1 };
  assert.deepEqual(roundtrip({ left: shared, right: shared }), { left: { a: 1 }, right: { a: 1 } });
});

test('손상·알 수 없는 버전/태그·비정규 배열 인덱스를 빈 값으로 대체하지 않는다', () => {
  const malformed = [null, {}, { version: 2, value: 1 }, { version: 1, value: 1, extra: true },
    envelope(null), envelope([]), envelope(NaN), envelope(-0), envelope({}), envelope({ t: 'future' }),
    envelope({ t: 'null', extra: 1 }), envelope({ t: 'object', p: 'bad' }),
    envelope({ t: 'object', p: 'object', illegal: 1 }),
    envelope({ t: 'timestamp', s: 1, n: 1e9 }), envelope({ t: 'timestamp', s: 253402300800, n: 0 }),
    envelope({ t: 'date', v: 8640000000000001 }), envelope({ t: 'array', l: -1 }),
    envelope({ t: 'array', l: 2, i01: 1 }), envelope({ t: 'array', l: 1, i1: 1 }),
    envelope({ t: 'array', l: 2, 'i1e0': 1 }), envelope({ t: 'array', l: 2, 'i-0': 1 }),
    envelope({ t: 'array', l: 2, '0': 1 }), envelope({ t: 'array', l: 2, i0: undefined })];
  for (const value of malformed) assert.throws(() => decodeValue(value), errorCode('invalid-format'));
  const cyclic = { t: 'object', p: 'object' }; cyclic[encodeKey('self')] = cyclic;
  assert.throws(() => decodeValue(envelope(cyclic)), errorCode('invalid-format'));
});

test('실제 저장 경로와 태그 메타데이터를 포함해 RTDB 깊이 32를 검사한다', () => {
  const wrap = (depth, leaf) => {
    let value = leaf;
    for (let i = 0; i < depth; i++) value = { nested: value };
    return value;
  };
  // baseDepth 4 + envelope.value 1 + 원본 중첩 27 = scalar leaf 깊이 32.
  const value = wrap(27, '끝');
  const encoded = encodeValue(value, { baseDepth: 4 });
  assert.deepEqual(decodeValue(encoded, { baseDepth: 4 }), value);
  assert.throws(() => encodeValue(wrap(28, '끝'), { baseDepth: 4 }), errorCode('depth-exceeded'));
  assert.throws(() => decodeValue(encoded, { baseDepth: 5 }), errorCode('depth-exceeded'));
  // null/빈 컨테이너는 삭제 방지 태그 한 층을 계산해야 한다.
  assert.throws(() => encodeValue(wrap(27, null), { baseDepth: 4 }), errorCode('depth-exceeded'));
  assert.deepEqual(decodeValue(encodeValue({}, { baseDepth: 30 }), { baseDepth: 30 }), {});
  assert.throws(() => encodeValue({}, { baseDepth: 31 }), errorCode('depth-exceeded'));
  for (const baseDepth of [-1, 33, 1.5, '4']) {
    assert.throws(() => encodeValue(1, { baseDepth }), errorCode('depth-exceeded'));
  }
});

test('basePath로 깊이를 추론하고 별도 baseDepth가 있으면 같은 경로인지 검사한다', () => {
  const value = { cards: [] };
  const basePath = `inventories/${encodeKey('사용자')}/payload`;
  const encoded = encodeValue(value, { basePath });
  assert.deepEqual(decodeValue(encoded, { basePath: `/${basePath}/`, baseDepth: 3 }), value);
  assert.throws(() => encodeValue(value, { basePath, baseDepth: 2 }), errorCode('invalid-path'));
  assert.throws(() => decodeValue(encoded, { basePath, baseDepth: 4 }), errorCode('invalid-path'));
  for (const invalid of ['a//b', '//', 'a.b', 'a/#b', 'a/\u0000', '\ud800', 42]) {
    assert.throws(() => encodeValue(1, { basePath: invalid }), errorCode('invalid-path'));
  }
  assert.deepEqual(decodeValue(encodeValue(value, { basePath: '/' }), { basePath: '' }), value);
});

test('개별 키가 짧아도 누적 절대 경로는 UTF-8 768바이트까지만 허용한다', () => {
  const value = { a: '끝' };
  // /<basePath>/value/kYQ: 선행 / 1 + basePath 757 + /value 6 + /kYQ 4.
  const basePath = 'b'.repeat(757);
  const encoded = encodeValue(value, { basePath });
  assert.deepEqual(decodeValue(encoded, { basePath }), value);
  assert.throws(() => encodeValue(value, { basePath: basePath + 'b' }), errorCode('path-too-long'));
  assert.throws(() => decodeValue(encoded, { basePath: basePath + 'b' }), errorCode('path-too-long'));
  const unicodePath = '가'.repeat(252) + 'b';
  assert.deepEqual(decodeValue(encodeValue(value, { basePath: unicodePath }), { basePath: unicodePath }), value);
  assert.throws(() => encodeValue(value, { basePath: unicodePath + 'b' }), errorCode('path-too-long'));
  const key = 'a'.repeat(280);
  assert.ok(Buffer.byteLength(encodeKey(key)) < 768);
  const nested = { [key]: { [key]: true } };
  assert.throws(() => encodeValue(nested, { basePath: 'inventories/kdXNlcg/payload' }), errorCode('path-too-long'));
  assert.throws(() => decodeValue(envelope({ t: 'object', p: 'object',
    [encodeKey(key)]: { t: 'object', p: 'object', [encodeKey(key)]: true } }),
  { basePath: 'inventories/kdXNlcg/payload' }), errorCode('path-too-long'));
});

test('envelope 메타데이터·태그·배열 인덱스도 전체 경로 길이에 포함한다', () => {
  // 값이 scalar여도 /version 필드가 더 길어 먼저 한도에 도달한다.
  const scalar = encodeValue(true, { basePath: 'b'.repeat(759) });
  assert.equal(decodeValue(scalar, { basePath: 'b'.repeat(759) }), true);
  assert.throws(() => encodeValue(true, { basePath: 'b'.repeat(760) }), errorCode('path-too-long'));
  assert.throws(() => encodeValue({ a: null }, { basePath: 'b'.repeat(757) }), errorCode('path-too-long'));
  const sparse = new Array(101); sparse[100] = true;
  const array = encodeValue(sparse, { basePath: 'b'.repeat(756) });
  assert.deepEqual(decodeValue(array, { basePath: 'b'.repeat(756) }), sparse);
  assert.throws(() => encodeValue(sparse, { basePath: 'b'.repeat(757) }), errorCode('path-too-long'));
  // baseDepth만 전달한 이전 호출도 알려진 상대 경로의 초과는 거부한다.
  assert.throws(() => encodeValue({ ['a'.repeat(575)]: true }), errorCode('path-too-long'));
});
