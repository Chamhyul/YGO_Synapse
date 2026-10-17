'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { encodeKey, UserStorageCodecError } = require('./codec');
const { inventoryPayloadCodec, encodeCardNode, decodeCardNode,
  validateLocationState, validatePayloadPaths } = require('./inventoryCodec');
const { buildApiSummary, readApiSummary, validateApiSummary } = require('./inventoryApiSummary');

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = message => { throw new UserStorageCodecError('user-storage/invalid-inventory-format', message); };
const failure = (code, message) => Object.assign(new Error(message), { code });
const fullRequired = () => { throw failure('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE', '이 인벤토리는 호환 정보를 보존하는 전체 수정이 필요합니다.'); };
const define = (object, key, value) => Object.defineProperty(object, key,
  { value, enumerable: true, configurable: true, writable: true });
const copy = value => JSON.parse(JSON.stringify(value));
const tokenPattern = /^[a-f0-9]{32}$/;
const hashPattern = /^h[A-Za-z0-9_-]{43}$/;

function fields(value, required, optional = []) {
  if (!plain(value)) invalid('인벤토리 참조 노드는 일반 객체여야 합니다.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !own(descriptor, 'value') || !descriptor.enumerable
        || (!required.includes(key) && !optional.includes(key))) invalid('인벤토리 참조 필드가 올바르지 않습니다.');
  }
  if (required.some(key => !own(value, key))) invalid('인벤토리 참조 필수 필드가 없습니다.');
}

function cardHash(number) {
  if (typeof number !== 'string') invalid('카드 번호는 문자열이어야 합니다.');
  // JSON 문자열 표현은 단독 surrogate도 구별하며 원문을 정규화하지 않는다.
  return `h${createHash('sha256').update(JSON.stringify(number), 'utf8').digest('base64url')}`;
}

function validHash(hash) {
  return typeof hash === 'string' && hashPattern.test(hash)
    && Buffer.from(hash.slice(1), 'base64url').toString('base64url') === hash.slice(1);
}

function cardBlobPath(uid, hash, token, { partsPath = 'inventoryCardVersions' } = {}) {
  if (typeof partsPath !== 'string' || !partsPath || !validHash(hash) || !tokenPattern.test(token)) invalid('카드 버전 경로가 올바르지 않습니다.');
  const path = `${partsPath.replace(/^\/|\/$/g, '')}/${encodeKey(uid)}/${hash}/${token}`;
  validatePayloadPaths(0, { basePath: path });
  return path;
}

function refsOf(manifest) {
  return own(manifest, 'cards') ? Object.entries(manifest.cards)
    .filter(([key]) => !['count', 'nullPrototype'].includes(key)).sort((a, b) => a[1].o - b[1].o) : [];
}

function headerState(header) {
  return validateLocationState({ locationNames: own(header, 'locationNames') ? header.locationNames : {}, nextLocationId: header.nextLocationId });
}

function validateManifest(manifest, { basePath = '' } = {}) {
  validatePayloadPaths(manifest, { basePath });
  fields(manifest, ['type', 'version', 'header'], ['cards', 'apiSummary']);
  if (manifest.type !== 'inventory-parts' || manifest.version !== 1) invalid('지원하지 않는 인벤토리 참조 형식입니다.');
  if (!plain(manifest.header) || own(manifest.header, 'cards')) invalid('참조 헤더에 카드 본문을 포함할 수 없습니다.');
  const state = headerState(manifest.header);
  // 헤더의 나머지는 기존 native v1 계약이다. 카드 없는 검증에서 위치 미사용 검사는 분리한다.
  const standalone = { ...manifest.header };
  delete standalone.locationNames;
  const decodedHeader = inventoryPayloadCodec.decode(standalone, { basePath: `${basePath}/header`.replace(/^\//, '') });
  if (own(decodedHeader.inventory, 'cards')) invalid('헤더 추가 필드에 카드 본문을 숨길 수 없습니다.');
  const used = new Set();
  if (own(manifest, 'cards')) {
    const collection = manifest.cards;
    if (!plain(collection) || !own(collection, 'count') || !Number.isSafeInteger(collection.count) || collection.count < 0
        || (own(collection, 'nullPrototype') && collection.nullPrototype !== true)) invalid('카드 참조 목록이 올바르지 않습니다.');
    const refs = Object.entries(collection).filter(([key]) => !['count', 'nullPrototype'].includes(key));
    if (refs.length !== collection.count) invalid('카드 참조 수가 일치하지 않습니다.');
    const orders = new Set();
    for (const [hash, ref] of refs) {
      if (!validHash(hash)) invalid('카드 주소 해시가 올바르지 않습니다.');
      fields(ref, ['v', 'o'], ['l']);
      if (typeof ref.v !== 'string' || !tokenPattern.test(ref.v) || !Number.isSafeInteger(ref.o)
          || ref.o < 0 || ref.o >= collection.count || orders.has(ref.o)) invalid('카드 버전 또는 순서가 올바르지 않습니다.');
      orders.add(ref.o);
      if (own(ref, 'l')) {
        if (!plain(ref.l) || !Object.keys(ref.l).length) invalid('카드 위치 참조 목록이 올바르지 않습니다.');
        for (const [id, flag] of Object.entries(ref.l)) {
          if (flag !== true || !own(state.locationNames, id)) invalid('카드 위치 참조에 없는 사전 항목이 사용되었습니다.');
          used.add(id);
        }
      }
    }
  }
  if (Object.keys(state.locationNames).some(id => !used.has(id))) invalid('사용하지 않는 위치 사전 항목이 참조 헤더에 남아 있습니다.');
  if (own(manifest, 'apiSummary')) {
    try { readApiSummary(manifest, { basePath }); }
    catch (error) { if (error.code === 'USER_STORAGE_INVALID_API_SUMMARY') invalid(error.message); throw error; }
  }
  return manifest;
}

const manifestPayloadCodec = {
  encode(value, options) {
    if (plain(value) && own(value, 'legacy')) {
      fields(value, ['legacy']);
      return inventoryPayloadCodec.encode(value.legacy, options);
    }
    return validateManifest(value, options);
  },
  decode(value, options) {
    if (plain(value) && value.type === 'inventory-parts') return validateManifest(value, options);
    return { legacy: inventoryPayloadCodec.decode(value, options) };
  },
};

function issueToken(factory, unavailable) {
  const token = factory();
  if (typeof token !== 'string' || !tokenPattern.test(token) || unavailable.has(token)) invalid('새 카드 버전 토큰은 이전 토큰과 달라야 합니다.');
  unavailable.add(token);
  return token;
}

function tokenFactoryOf(options) {
  const factory = options.tokenFactory ?? (() => randomUUID().replace(/-/g, ''));
  if (typeof factory !== 'function') invalid('카드 버전 토큰 생성 함수가 필요합니다.');
  return factory;
}

function locationRefs(ids) {
  if (!ids.length) return undefined;
  return Object.fromEntries(ids.map(id => [id, true]));
}

function blobOptions(options, hash, token, locationState) {
  return { basePath: cardBlobPath(options.uid, hash, token, options), locationState };
}

function splitInventory(state, options = {}) {
  const encoded = inventoryPayloadCodec.encode(state, { basePath: options.basePath ?? '' });
  const header = { ...encoded };
  delete header.cards;
  const manifest = { type: 'inventory-parts', version: 1, header };
  const blobs = [];
  const unavailable = new Set();
  const factory = tokenFactoryOf(options);
  const locationState = headerState(header);
  if (own(encoded, 'cards')) {
    const cards = { count: encoded.cards.count };
    if (encoded.cards.nullPrototype === true) cards.nullPrototype = true;
    for (let order = 0; order < encoded.cards.count; order++) {
      const node = encoded.cards[`c${order}`];
      const hash = cardHash(node.number);
      if (own(cards, hash)) invalid('서로 다른 카드 번호의 주소가 충돌했습니다.');
      const token = issueToken(factory, unavailable);
      const target = blobOptions(options, hash, token, locationState);
      const decoded = decodeCardNode(node, target);
      const ref = { v: token, o: order };
      const locations = locationRefs(decoded.usedLocationIds);
      if (locations) ref.l = locations;
      cards[hash] = ref;
      blobs.push({ hash, token, path: target.basePath, value: node });
    }
    manifest.cards = cards;
  }
  const apiSummary = buildApiSummary(manifest, state.inventory, options);
  if (apiSummary) manifest.apiSummary = apiSummary;
  validateManifest(manifest, options);
  return { manifest, blobs };
}

function assertBlobs(blobs) {
  if (!plain(blobs)) invalid('읽은 카드 버전 목록은 해시별 객체여야 합니다.');
  for (const key of Reflect.ownKeys(blobs)) {
    const descriptor = Object.getOwnPropertyDescriptor(blobs, key);
    if (typeof key !== 'string' || !validHash(key) || !own(descriptor, 'value') || !descriptor.enumerable) invalid('읽은 카드 버전 목록이 올바르지 않습니다.');
  }
}

function decodeBlob(manifest, hash, ref, blobs, options, expectedNumber) {
  if (!own(blobs, hash) || blobs[hash] === null || blobs[hash] === undefined) {
    throw failure('USER_STORAGE_MISSING_CARD_VERSION', '참조된 카드 버전을 읽을 수 없습니다. 인벤토리 revision을 다시 확인해 주세요.');
  }
  const node = blobs[hash];
  const target = blobOptions(options, hash, ref.v, headerState(manifest.header));
  const decoded = decodeCardNode(node, target);
  if (cardHash(node.number) !== hash || (expectedNumber !== undefined && node.number !== expectedNumber)) invalid('카드 주소와 원문 번호가 일치하지 않습니다.');
  const expectedLocations = Object.keys(ref.l || {}).sort();
  if (!isDeepStrictEqual(decoded.usedLocationIds.slice().sort(), expectedLocations)) invalid('카드 본문과 위치 참조 메타데이터가 일치하지 않습니다.');
  return { node, card: decoded.card };
}

function hydrateInventory(manifest, blobs, options = {}) {
  validateManifest(manifest, options);
  assertBlobs(blobs);
  const encoded = copy(manifest.header);
  const refs = refsOf(manifest);
  if (Object.keys(blobs).length !== refs.length || Object.keys(blobs).some(hash => !own(manifest.cards || {}, hash))) invalid('전체 읽기의 카드 버전 목록이 일치하지 않습니다.');
  if (own(manifest, 'cards')) {
    encoded.cards = { count: refs.length };
    if (manifest.cards.nullPrototype === true) encoded.cards.nullPrototype = true;
    for (const [hash, ref] of refs) encoded.cards[`c${ref.o}`] = decodeBlob(manifest, hash, ref, blobs, options).node;
  }
  const state = inventoryPayloadCodec.decode(encoded, { basePath: options.basePath ?? '' });
  validateApiSummary(manifest, state.inventory, options);
  return state;
}

function selectionOf(options) {
  if (!Array.isArray(options.numbers) || options.numbers.some(number => typeof number !== 'string')) {
    throw failure('USER_STORAGE_INVALID_PARTIAL_SELECTION', '선택 카드 번호 목록이 필요합니다.');
  }
  return [...new Set(options.numbers)];
}

function readSelected(manifest, blobs, options = {}) {
  validateManifest(manifest, options);
  assertBlobs(blobs);
  const numbers = selectionOf(options);
  const requested = new Map(numbers.map(number => [cardHash(number), number]));
  if (requested.size !== numbers.length) invalid('선택 카드 번호의 주소가 충돌했습니다.');
  if (Object.keys(blobs).some(hash => !requested.has(hash) || !own(manifest.cards || {}, hash))) invalid('선택하지 않은 카드 버전이 전달되었습니다.');
  const cards = manifest.cards?.nullPrototype === true ? Object.create(null) : {};
  const missing = numbers.filter(number => !own(manifest.cards || {}, cardHash(number)));
  for (const [hash, ref] of refsOf(manifest)) {
    if (!requested.has(hash)) continue;
    const number = requested.get(hash);
    define(cards, number, decodeBlob(manifest, hash, ref, blobs, options, number).card);
  }
  return { cards, missing };
}

function patchInventory(manifest, cards, beforeBlobs, options = {}) {
  validateManifest(manifest, options);
  if (!own(manifest, 'cards') || manifest.header.inventoryVersion !== 3
      || (own(manifest.header, 'summaryCompatibility') && !(options.apiSummary === true && manifest.apiSummary))) fullRequired();
  if (!plain(cards)) invalid('부분 수정 결과는 카드 번호별 객체여야 합니다.');
  const selected = new Set(selectionOf(options));
  for (const key of Reflect.ownKeys(cards)) {
    const descriptor = Object.getOwnPropertyDescriptor(cards, key);
    if (typeof key !== 'string' || !own(descriptor, 'value') || !descriptor.enumerable || !selected.has(key)) invalid('선택 범위 밖의 카드를 부분 수정할 수 없습니다.');
  }
  const before = readSelected(manifest, beforeBlobs, options).cards;
  const candidate = copy(manifest);
  delete candidate.apiSummary;
  const state = headerState(candidate.header);
  const ids = new Map(Object.entries(state.locationNames).map(([id, name]) => [name, Number(id.slice(1))]));
  const unavailable = new Set(refsOf(manifest).map(([, ref]) => ref.v));
  const factory = tokenFactoryOf(options);
  const blobs = [];
  const retired = [];
  let nextOrder = manifest.cards.count;
  let changed = false;
  const allocateLocation = name => {
    let id = ids.get(name);
    if (id === undefined) {
      if (state.nextLocationId >= Number.MAX_SAFE_INTEGER) invalid('새 위치 ID를 안전하게 발급할 수 없습니다.');
      id = state.nextLocationId++;
      ids.set(name, id);
      state.locationNames[`l${id}`] = name;
    }
    return id;
  };
  for (const number of selected) {
    const had = own(before, number);
    const has = own(cards, number);
    if ((!had && !has) || (had && has && isDeepStrictEqual(before[number], cards[number]))) continue;
    changed = true;
    const hash = cardHash(number);
    const previous = own(manifest.cards, hash) ? manifest.cards[hash] : undefined;
    if (previous) retired.push({ hash, token: previous.v, path: cardBlobPath(options.uid, hash, previous.v, options) });
    if (!has) { delete candidate.cards[hash]; continue; }
    const token = issueToken(factory, unavailable);
    const target = blobOptions(options, hash, token, state);
    const node = encodeCardNode(cards[number], number, { basePath: target.basePath, allocateLocation });
    const decoded = decodeCardNode(node, { ...target, locationState: state });
    const ref = { v: token, o: previous ? previous.o : nextOrder++ };
    // 전체 읽기에서 재조립할 기존 native v1 경로 한도도 함께 만족해야 한다.
    decodeCardNode(node, { basePath: `${options.basePath ?? ''}/cards/c${ref.o}`.replace(/^\//, ''), locationState: state });
    const locations = locationRefs(decoded.usedLocationIds);
    if (locations) ref.l = locations;
    candidate.cards[hash] = ref;
    blobs.push({ hash, token, path: target.basePath, value: node });
  }
  if (!changed) {
    if (own(options, 'updatedAt')) candidate.header.updatedAt = options.updatedAt;
    validateManifest(candidate, options);
    return { manifest: candidate, blobs, retired, changed: false };
  }
  const refs = refsOf(candidate);
  refs.forEach(([, ref], order) => { ref.o = order; });
  candidate.cards.count = refs.length;
  const used = new Set(refs.flatMap(([, ref]) => Object.keys(ref.l || {})));
  const names = {};
  for (const [id, name] of Object.entries(state.locationNames)) if (used.has(id)) names[id] = name;
  if (Object.keys(names).length) candidate.header.locationNames = names;
  else delete candidate.header.locationNames;
  candidate.header.nextLocationId = state.nextLocationId;
  if (own(options, 'updatedAt')) candidate.header.updatedAt = options.updatedAt;
  validateManifest(candidate, options);
  return { manifest: candidate, blobs, retired, changed: true };
}

module.exports = { manifestPayloadCodec, cardHash, cardBlobPath, splitInventory, hydrateInventory, readSelected, patchInventory };
