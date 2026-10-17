'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeValue } = require('../services/user-storage/codec');
const { inventoryPayloadCodec: codec } = require('../services/user-storage/inventoryCodec');

const options = { basePath: 'inventories/kdGVzdA/payload' };
const code = expected => error => error.code === `user-storage/${expected}`;
const empty = () => ({ version: 3, updatedAt: '2026-10-12T00:00:00.000Z', amount: 0, locations: {}, rarities: {}, cards: {} });
const fixture = () => ({ ...empty(), amount: 5, locations: { '상자.#/$[]': ['CARD-KR001'], '': ['CARD-KR001'] }, rarities: { 'SR.#': 5 },
  cards: { 'CARD-KR001': { name: '원문 카드', cid: null, cidCheckedAt: 123,
    items: [{ rarity: 'SR.#', qty: 3, loc: '상자.#/$[]', illustration: '1' },
      { rarity: 'SR.#', qty: 2, loc: '', illustration: '알 수 없는 원문' }] } } });

// Firebase의 객체 키 정렬과 null/빈 컨테이너 삭제를 흉내 낸 직렬화 경계.
function snapshot(value) {
  if (value === null) return undefined;
  if (typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = snapshot(value[key]);
    if (child !== undefined) Object.defineProperty(result, key, { value: child, enumerable: true });
  }
  return Object.keys(result).length ? result : undefined;
}
const roundtrip = inventory => codec.decode(snapshot(codec.encode({ inventory }, options)), options);

test('정상 인벤토리는 native 항목과 숫자 위치 참조로 저장하며 집계를 저장하지 않는다', () => {
  const inventory = fixture();
  const payload = codec.encode({ inventory }, options);
  assert.equal(payload.type, 'inventory');
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.locationNames, { l1: '상자.#/$[]', l2: '' });
  assert.equal(payload.nextLocationId, 3);
  assert.equal(payload.cards.c0.items.i0.loc, 1);
  assert.equal(payload.cards.c0.items.i1.loc, 2);
  assert.equal(payload.cards.c0.cidNull, true);
  for (const key of ['amount', 'locations', 'rarities', 'summaryCompatibility', 'extra']) assert.equal(Object.hasOwn(payload, key), false);
  assert.deepEqual(codec.decode(snapshot(payload), options).inventory, inventory);
});

test('위치 이름은 재사용하고 미사용 사전은 없애며 삭제된 숫자 ID는 재발급하지 않는다', () => {
  const first = roundtrip(fixture());
  first.inventory.cards['CARD-KR001'].items[0].loc = '새 위치';
  const secondPayload = codec.encode(first, options);
  assert.deepEqual(secondPayload.locationNames, { l3: '새 위치', l2: '' });
  assert.equal(secondPayload.nextLocationId, 4);
  const second = codec.decode(snapshot(secondPayload), options);
  second.inventory.cards['CARD-KR001'].items[0].loc = '상자.#/$[]';
  const third = codec.encode(second, options);
  assert.equal(third.cards.c0.items.i0.loc, 4);
  assert.equal(third.nextLocationId, 5);
  const cleared = codec.encode({ inventory: empty(), locationState: codec.decode(snapshot(third), options).locationState }, options);
  assert.equal(Object.hasOwn(cleared, 'locationNames'), false);
  assert.equal(cleared.nextLocationId, 5);
  const afterClear = codec.encode({ inventory: fixture(), locationState: codec.decode(snapshot(cleared), options).locationState }, options);
  assert.equal(afterClear.cards.c0.items.i0.loc, 5);
  assert.equal(afterClear.cards.c0.items.i1.loc, 6);
});

test('빈 인벤토리·빈 항목·희소 배열·키 순서는 RTDB 정렬/삭제 경계 후에도 유지한다', () => {
  assert.deepEqual(roundtrip(empty()).inventory, empty());
  const inventory = empty();
  const sparse = new Array(4); sparse[1] = {}; sparse[3] = null;
  inventory.cards = { Z: { items: [] }, A: { items: sparse }, '2': { items: [] }, '1': { items: [] } };
  const result = roundtrip(inventory).inventory;
  assert.deepEqual(Object.keys(result.cards), Object.keys(inventory.cards));
  assert.deepEqual(result, inventory);
  assert.equal(0 in result.cards.A.items, false);
  assert.equal(2 in result.cards.A.items, false);
});

test('원문 수록번호·null CID·unknown 필드와 Date/Timestamp/빈 값은 generic extra로 보존한다', () => {
  const inventory = fixture();
  inventory.version = 1;
  inventory.cidMigration = { retryableError: true, retryAt: 12345 };
  inventory.extra = { nothing: null, list: [], object: {}, stamp: new Timestamp(1791763200, 123456789), date: new Date(12345) };
  inventory.cards['번호./#$[]\u0000'] = { name: null, cid: false, cidCheckedAt: new Date(123), items: [
    { qty: -0, loc: 7, illustration: null, rarity: '', custom: { unknown: [] } },
  ] };
  Object.defineProperty(inventory, '__proto__', { value: { safe: true }, enumerable: true });
  const result = roundtrip(inventory).inventory;
  assert.deepEqual(result, inventory);
  assert.equal(result.extra.stamp.nanoseconds, 123456789);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.safe, undefined);
  assert.ok(Object.is(result.cards['번호./#$[]\u0000'].items[0].qty, -0));
});

test('과거 집계 불일치·위치 배열 및 위치 키 순서·원래 필드 부재를 바꾸지 않는다', () => {
  const inventory = fixture();
  inventory.amount = 987;
  inventory.locations = { 'z': ['B', 'A'], 'a': [], '상자.#/$[]': ['CARD-KR001'] };
  inventory.rarities = { stale: 0, 'SR.#': 5 };
  const payload = codec.encode({ inventory }, options);
  assert.ok(payload.summaryCompatibility);
  const result = codec.decode(snapshot(payload), options).inventory;
  assert.deepEqual(result, inventory);
  assert.deepEqual(Object.keys(result.locations), ['z', 'a', '상자.#/$[]']);
  assert.deepEqual(roundtrip({ cards: {} }).inventory, { cards: {} });
  const minimal = { cards: { A: {} } };
  assert.deepEqual(roundtrip(minimal).inventory, minimal);
});

test('값이 같은 집계라도 배열 순서나 키 순서가 다르면 호환 정보를 남긴다', () => {
  const inventory = empty();
  inventory.amount = 2;
  inventory.rarities = { SR: 2 };
  inventory.cards = { A: { items: [{ rarity: 'SR', qty: 1, loc: 'Y', illustration: '1' }] },
    B: { items: [{ rarity: 'SR', qty: 1, loc: 'Y', illustration: '1' }] } };
  inventory.locations = { Y: ['B', 'A'] };
  const result = roundtrip(inventory);
  assert.deepEqual(result.inventory.locations.Y, ['B', 'A']);
  assert.ok(codec.encode({ inventory }, options).summaryCompatibility);
});

test('기존 generic payload는 수정 없이 읽고 다음 encode에서 native 저장 형식으로 바뀐다', () => {
  const inventory = fixture();
  const legacy = encodeValue(inventory, options);
  const before = JSON.stringify(legacy);
  const internal = codec.decode(snapshot(legacy), options);
  assert.deepEqual(internal.inventory, inventory);
  assert.equal(JSON.stringify(legacy), before);
  const payload = codec.encode(internal, options);
  assert.equal(payload.type, 'inventory');
  assert.equal(payload.locationNames.l1, '상자.#/$[]');
  assert.deepEqual(codec.decode(snapshot(payload), options).inventory, inventory);
});

test('미래 버전·손상 참조·중복 번호·사전 충돌은 원본을 빈 인벤토리로 바꾸지 않고 거부한다', () => {
  const payload = codec.encode({ inventory: fixture() }, options);
  const broken = change => { const candidate = JSON.parse(JSON.stringify(payload)); change(candidate); return candidate; };
  for (const candidate of [
    broken(p => { p.version = 2; }),
    broken(p => { p.cards.c0.items.i0.loc = 999; }),
    broken(p => { p.cards.c0.items.i0.loc = 1.1; }),
    broken(p => { p.locationNames.l2 = p.locationNames.l1; }),
    broken(p => { p.locationNames = false; }),
    broken(p => { p.locationNames.l3 = '미사용'; p.nextLocationId = 4; }),
    broken(p => { p.nextLocationId = 2; }),
    broken(p => { p.cards.count = 2; p.cards.c1 = p.cards.c0; }),
    broken(p => { p.cards.c0.cid = '중복 null'; }),
    broken(p => { p.cards.c0.items.i00 = p.cards.c0.items.i0; }),
    broken(p => { p.unknown = 1; }),
  ]) assert.throws(() => codec.decode(candidate, options), code('invalid-inventory-format'));
  const unsupportedVersion = error => error.code === 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION';
  assert.throws(() => codec.encode({ inventory: { ...empty(), version: 4 } }, options), unsupportedVersion);
  assert.throws(() => codec.decode(encodeValue({ ...empty(), version: 4 }, options), options), unsupportedVersion);
});

test('원형 없는 객체·공격 키는 그대로 보존하고 실행 속성·undefined·순환은 거부한다', () => {
  const inventory = Object.assign(Object.create(null), empty());
  inventory.cards = Object.create(null);
  inventory.cards.__proto__ = Object.assign(Object.create(null), { items: [Object.create(null)] });
  assert.deepEqual(roundtrip(inventory).inventory, inventory);
  const hidden = empty(); Object.defineProperty(hidden, 'hidden', { value: 1 });
  assert.throws(() => codec.encode({ inventory: hidden }, options), code('unsupported-value'));
  const accessor = empty(); Object.defineProperty(accessor, 'extra', { enumerable: true, get() { throw Error('실행하면 안 됨'); } });
  assert.throws(() => codec.encode({ inventory: accessor }, options), code('unsupported-value'));
  for (const [object, key] of [[accessor, 'cards'], [fixture().cards['CARD-KR001'], 'name'], [fixture().cards['CARD-KR001'].items[0], 'loc']]) {
    const candidate = empty();
    Object.defineProperty(object, key, { enumerable: true, get() { throw Error('실행하면 안 됨'); } });
    if (key === 'cards') assert.throws(() => codec.encode({ inventory: object }, options), code('unsupported-value'));
    else {
      candidate.cards.A = key === 'name' ? object : { items: [object] };
      assert.throws(() => codec.encode({ inventory: candidate }, options), code('unsupported-value'));
    }
  }
  const cyclic = empty(); cyclic.extra = cyclic;
  assert.throws(() => codec.encode({ inventory: cyclic }, options), code('unsupported-value'));
  assert.throws(() => codec.encode({ inventory: { ...empty(), extra: undefined } }, options), code('unsupported-value'));
});

test('최대 길이의 희소 배열도 실제 항목만 순회하고 원래 길이와 인덱스를 보존한다', () => {
  const inventory = empty();
  const items = new Array(4294967295);
  items[4294967294] = { rarity: 'SR', qty: 1, loc: '끝', illustration: '1' };
  inventory.cards.A = { items };
  inventory.amount = 1;
  inventory.rarities = { SR: 1 };
  inventory.locations = { 끝: ['A'] };
  const result = roundtrip(inventory).inventory;
  assert.equal(result.cards.A.items.length, 4294967295);
  assert.deepEqual(Object.keys(result.cards.A.items), ['4294967294']);
  assert.deepEqual(result.cards.A.items[4294967294], items[4294967294]);
});

test('native·extra·호환 집계의 실제 저장 경로 깊이와 누적 UTF-8 길이를 검사한다', () => {
  const inventory = fixture();
  assert.throws(() => codec.encode({ inventory }, { basePath: 'x'.repeat(760) }), code('path-too-long'));
  const payload = codec.encode({ inventory }, options);
  assert.throws(() => codec.decode(payload, { basePath: 'x'.repeat(760) }), code('path-too-long'));
  assert.throws(() => codec.encode({ inventory }, { basePath: Array(30).fill('x').join('/') }), code('depth-exceeded'));
  inventory.extra = { ['x'.repeat(550)]: '원문' };
  assert.throws(() => codec.encode({ inventory }, options), code('path-too-long'));
  assert.throws(() => codec.encode({ inventory: empty() }, { basePath: 'wrong//path' }), code('invalid-path'));
});
