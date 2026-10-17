'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeValue, encodeKey } = require('../services/user-storage/codec');
const { inventoryPayloadCodec } = require('../services/user-storage/inventoryCodec');
const { manifestPayloadCodec, cardHash, cardBlobPath, splitInventory,
  hydrateInventory, readSelected, patchInventory } = require('../services/user-storage/inventoryManifest');

const options = { uid: '합성 사용자', basePath: `inventories/${encodeKey('합성 사용자')}/payload` };
const errorCode = code => error => error.code === code;
const invalid = errorCode('user-storage/invalid-inventory-format');
const tokens = (start = 1) => { let value = start; return () => (value++).toString(16).padStart(32, '0'); };
const asMap = blobs => Object.fromEntries(blobs.map(blob => [blob.hash, blob.value]));
const empty = () => ({ version: 3, updatedAt: '2026-10-12T00:00:00Z', amount: 0, locations: {}, rarities: {}, cards: {} });
const fixture = () => ({ ...empty(), amount: 6, locations: { '상자 A': ['Z-KR001'], '상자 B': ['A-JP001'] }, rarities: { SR: 3, UR: 3 },
  cards: { 'Z-KR001': { name: '합성 카드 Z', cid: null, cidCheckedAt: 123,
    items: [{ rarity: 'SR', qty: 3, loc: '상자 A', illustration: '1' }] },
  'A-JP001': { name: '合成カード A', cid: '12',
    items: [{ rarity: 'UR', qty: 3, loc: '상자 B', illustration: '미확정 원문' }] } } });
const split = inventory => splitInventory({ inventory }, { ...options, tokenFactory: tokens() });

test('전체 인벤토리를 고정 해시 주소의 불변 카드 버전으로 나누고 순서/원문을 복원한다', () => {
  const inventory = fixture();
  const result = split(inventory);
  assert.equal(result.manifest.type, 'inventory-parts');
  assert.equal(result.manifest.version, 1);
  assert.equal(Object.hasOwn(result.manifest.header, 'cards'), false);
  assert.equal(result.manifest.cards.count, 2);
  const hash = cardHash('Z-KR001');
  assert.equal(result.manifest.cards[hash].o, 0);
  assert.deepEqual(result.manifest.cards[hash].l, { l1: true });
  assert.equal(result.blobs[0].path, cardBlobPath(options.uid, hash, result.manifest.cards[hash].v));
  assert.equal(result.blobs[0].value.number, 'Z-KR001');
  const hydrated = hydrateInventory(result.manifest, asMap(result.blobs), options);
  assert.deepEqual(hydrated.inventory, inventory);
  assert.deepEqual(Object.keys(hydrated.inventory.cards), Object.keys(inventory.cards));
});

test('임의 번호의 안정 주소는 특수문자·Unicode 정규화·단독 surrogate를 구별한다', () => {
  const values = ['', '__proto__', '번호./#$[]', 'é', 'e\u0301', '\ud800', '\ud801', '�', 'x'.repeat(2000)];
  assert.equal(new Set(values.map(cardHash)).size, values.length);
  for (const value of values) assert.match(cardHash(value), /^h[A-Za-z0-9_-]{43}$/);
  const inventory = empty();
  for (const number of values) Object.defineProperty(inventory.cards, number, { value: { items: [] }, enumerable: true });
  const result = split(inventory);
  assert.deepEqual(hydrateInventory(result.manifest, asMap(result.blobs), options).inventory, inventory);
  assert.throws(() => cardHash(12), invalid);
});

test('선택 읽기는 요청 카드 버전만 요구하며 나머지 카드 본문 없이 복원한다', () => {
  const result = split(fixture());
  const target = result.blobs[1];
  const selected = readSelected(result.manifest, { [target.hash]: target.value }, { ...options, numbers: ['A-JP001', '없음'] });
  assert.deepEqual(Object.keys(selected.cards), ['A-JP001']);
  assert.equal(selected.cards['A-JP001'].items[0].loc, '상자 B');
  assert.deepEqual(selected.missing, ['없음']);
  assert.throws(() => readSelected(result.manifest, {}, { ...options, numbers: ['A-JP001'] }), errorCode('USER_STORAGE_MISSING_CARD_VERSION'));
  assert.throws(() => readSelected(result.manifest, asMap(result.blobs), { ...options, numbers: ['A-JP001'] }), invalid);
});

test('부분 수정은 변경 카드만 새 버전을 만들고 다른 참조/위치 ID를 유지한다', () => {
  const original = split(fixture());
  const hash = cardHash('Z-KR001');
  const untouched = cardHash('A-JP001');
  const oldMap = { [hash]: original.blobs[0].value };
  const cards = readSelected(original.manifest, oldMap, { ...options, numbers: ['Z-KR001'] }).cards;
  cards['Z-KR001'].items[0].qty = 4;
  cards['Z-KR001'].items[0].loc = '신규 위치';
  const result = patchInventory(original.manifest, cards, oldMap,
    { ...options, numbers: ['Z-KR001'], tokenFactory: tokens(100), updatedAt: '새 시각' });
  assert.equal(result.changed, true);
  assert.equal(result.blobs.length, 1);
  assert.equal(result.blobs[0].hash, hash);
  assert.deepEqual(result.manifest.cards[untouched], original.manifest.cards[untouched]);
  assert.deepEqual(result.manifest.header.locationNames, { l2: '상자 B', l3: '신규 위치' });
  assert.equal(result.manifest.header.nextLocationId, 4);
  assert.equal(result.manifest.header.updatedAt, '새 시각');
  assert.deepEqual(result.retired, [{ hash, token: original.manifest.cards[hash].v,
    path: original.blobs[0].path }]);
  const allBlobs = { ...asMap(original.blobs), ...asMap(result.blobs) };
  const restored = hydrateInventory(result.manifest, allBlobs, options).inventory;
  assert.equal(restored.amount, 7);
  assert.deepEqual(restored.rarities, { SR: 4, UR: 3 });
  assert.equal(restored.cards['Z-KR001'].items[0].loc, '신규 위치');
  assert.equal(original.manifest.header.nextLocationId, 3);
});

test('선택 삭제와 신규 카드 추가는 순서를 유지하고 사전 미사용 항목만 제거한다', () => {
  const original = split(fixture());
  const oldHash = cardHash('Z-KR001');
  const oldMap = { [oldHash]: original.blobs[0].value };
  const cards = { NEW: { name: '새 카드', cid: null, items: [{ rarity: 'R', qty: 2, loc: '상자 B', illustration: '1' }] } };
  const result = patchInventory(original.manifest, cards, oldMap,
    { ...options, numbers: ['Z-KR001', 'NEW'], tokenFactory: tokens(200) });
  assert.equal(Object.hasOwn(result.manifest.cards, oldHash), false);
  assert.equal(result.manifest.cards[cardHash('A-JP001')].o, 0);
  assert.equal(result.manifest.cards[cardHash('NEW')].o, 1);
  assert.deepEqual(result.manifest.header.locationNames, { l2: '상자 B' });
  assert.equal(result.manifest.header.nextLocationId, 3);
  const restored = hydrateInventory(result.manifest,
    { [cardHash('A-JP001')]: original.blobs[1].value, ...asMap(result.blobs) }, options).inventory;
  assert.deepEqual(Object.keys(restored.cards), ['A-JP001', 'NEW']);
  assert.equal(restored.amount, 5);
  const cleared = patchInventory(result.manifest, {}, { [cardHash('A-JP001')]: original.blobs[1].value, ...asMap(result.blobs) },
    { ...options, numbers: ['A-JP001', 'NEW'], tokenFactory: tokens(300) });
  assert.equal(cleared.manifest.cards.count, 0);
  assert.equal(cleared.manifest.header.nextLocationId, 3);
  assert.equal(Object.hasOwn(cleared.manifest.header, 'locationNames'), false);
});

test('동일한 수정은 새 버전을 만들지 않고 선택 밖 변경/토큰 재사용을 거부한다', () => {
  const original = split(fixture());
  const hash = cardHash('Z-KR001');
  const oldMap = { [hash]: original.blobs[0].value };
  const cards = readSelected(original.manifest, oldMap, { ...options, numbers: ['Z-KR001'] }).cards;
  const noChange = patchInventory(original.manifest, cards, oldMap,
    { ...options, numbers: ['Z-KR001'], updatedAt: 'noop 갱신 시각', tokenFactory: () => { throw Error('호출 금지'); } });
  assert.equal(noChange.changed, false);
  assert.notEqual(noChange.manifest, original.manifest);
  assert.equal(noChange.manifest.header.updatedAt, 'noop 갱신 시각');
  assert.equal(original.manifest.header.updatedAt, fixture().updatedAt);
  assert.deepEqual(noChange.blobs, []);
  assert.throws(() => patchInventory(original.manifest, { ...cards, OTHER: {} }, oldMap,
    { ...options, numbers: ['Z-KR001'] }), invalid);
  cards['Z-KR001'].items[0].qty++;
  assert.throws(() => patchInventory(original.manifest, cards, oldMap,
    { ...options, numbers: ['Z-KR001'], tokenFactory: () => original.manifest.cards[hash].v }), invalid);
});

test('과거 집계·부재 카드 맵·미완료 버전은 전체 수정이 필요하지만 선택 읽기는 가능하다', () => {
  const inventory = fixture();
  inventory.locations['상자 A'] = ['과거 정보', 'Z-KR001'];
  const legacy = split(inventory);
  const hash = cardHash('Z-KR001');
  const selected = { [hash]: legacy.blobs[0].value };
  assert.equal(readSelected(legacy.manifest, selected, { ...options, numbers: ['Z-KR001'] }).cards['Z-KR001'].name, '합성 카드 Z');
  assert.throws(() => patchInventory(legacy.manifest, {}, selected, { ...options, numbers: ['Z-KR001'] }), errorCode('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE'));
  assert.deepEqual(hydrateInventory(legacy.manifest, asMap(legacy.blobs), options).inventory, inventory);
  for (const source of [{ version: 3 }, { ...empty(), version: 1 }]) {
    const result = split(source);
    assert.throws(() => patchInventory(result.manifest, {}, {}, { ...options, numbers: [] }), errorCode('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE'));
  }
});

test('빈/희소/null/unknown/원형없는 원문과 시각을 전체 분할/복원에서 보존한다', () => {
  const inventory = Object.assign(Object.create(null), empty());
  inventory.cards = Object.create(null);
  const items = new Array(5); items[2] = null; items[4] = Object.create(null);
  inventory.cards.__proto__ = { items, custom: { date: new Date(123), stamp: new Timestamp(123, 456), empty: [], nil: null } };
  inventory.extra = { empty: {}, value: null };
  const result = split(inventory);
  const restored = hydrateInventory(result.manifest, asMap(result.blobs), options).inventory;
  assert.deepEqual(restored, inventory);
  assert.equal(0 in restored.cards.__proto__.items, false);
  assert.equal(restored.cards.__proto__.custom.stamp.nanoseconds, 456);
  assert.equal({}.custom, undefined);
});

test('payload 코덱은 기존 generic/native v1을 구분하고 참조 형식에는 엄격히 적용된다', () => {
  const inventory = fixture();
  const state = { inventory };
  const legacy = manifestPayloadCodec.decode(encodeValue(inventory, { basePath: options.basePath }), { basePath: options.basePath });
  assert.deepEqual(legacy.legacy.inventory, inventory);
  const v1 = inventoryPayloadCodec.encode(state, { basePath: options.basePath });
  assert.deepEqual(manifestPayloadCodec.decode(v1, { basePath: options.basePath }).legacy.inventory, inventory);
  assert.deepEqual(manifestPayloadCodec.encode({ legacy: state }, { basePath: options.basePath }), v1);
  const result = split(inventory);
  assert.equal(manifestPayloadCodec.decode(result.manifest, options), result.manifest);
  assert.equal(manifestPayloadCodec.encode(result.manifest, options), result.manifest);
});

test('해시/원문·위치 참조·순서·버전 손상과 누락 blob을 거부한다', () => {
  const original = split(fixture());
  const hash = original.blobs[0].hash;
  const all = asMap(original.blobs);
  for (const mutate of [
    manifest => { manifest.version = 2; },
    manifest => { manifest.cards[hash].o = 1; },
    manifest => { manifest.cards[hash].v = 'bad'; },
    manifest => { manifest.cards[hash].l = { l999: true }; },
    manifest => { manifest.header.cards = { count: 0 }; },
    manifest => { manifest.header.locationNames.l3 = '미사용'; manifest.header.nextLocationId = 4; },
  ]) {
    const bad = JSON.parse(JSON.stringify(original.manifest)); mutate(bad);
    assert.throws(() => manifestPayloadCodec.decode(bad, options), invalid);
  }
  const wrong = JSON.parse(JSON.stringify(all)); wrong[hash].number = '다른 번호';
  assert.throws(() => hydrateInventory(original.manifest, wrong, options), invalid);
  const locationMismatch = JSON.parse(JSON.stringify(original.manifest)); locationMismatch.cards[hash].l = { l2: true };
  delete locationMismatch.header.locationNames.l1;
  assert.throws(() => hydrateInventory(locationMismatch, all, options), invalid);
  const missing = { [original.blobs[1].hash]: original.blobs[1].value, [hash]: null };
  assert.throws(() => hydrateInventory(original.manifest, missing, options), errorCode('USER_STORAGE_MISSING_CARD_VERSION'));
});

test('헤더와 실제 immutable blob 경로의 누적 한도를 저장 전에 검사한다', () => {
  const inventory = fixture();
  assert.throws(() => splitInventory({ inventory }, { ...options, partsPath: 'x'.repeat(700), tokenFactory: tokens() }), errorCode('user-storage/path-too-long'));
  assert.throws(() => splitInventory({ inventory }, { ...options, basePath: Array(29).fill('x').join('/'), tokenFactory: tokens() }), errorCode('user-storage/depth-exceeded'));
  assert.throws(() => cardBlobPath(options.uid, cardHash('A'), '1'.repeat(32), { partsPath: 'bad//path' }), errorCode('user-storage/invalid-path'));
});
