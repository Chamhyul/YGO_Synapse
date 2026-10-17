'use strict';

const { isDeepStrictEqual } = require('node:util');
const { encodeValue, decodeValue, UserStorageCodecError } = require('./codec');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => { throw new UserStorageCodecError(`user-storage/${code}`, message); };
const invalid = message => fail('invalid-inventory-format', message);
const define = (target, key, value) => Object.defineProperty(target, key,
  { value, enumerable: true, writable: true, configurable: true });
const scalar = value => typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0));
const string = value => typeof value === 'string';
const numeric = value => typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);

function keysOf(value) {
  return Reflect.ownKeys(value).filter(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !own(descriptor, 'value')
        || (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) {
      fail('unsupported-value', '접근자·Symbol·숨겨진 인벤토리 속성은 저장할 수 없습니다.');
    }
    return key !== 'length' || !Array.isArray(value);
  });
}

function validateInventory(inventory) {
  if (!plain(inventory)) throw Object.assign(new Error('인벤토리는 일반 객체여야 합니다.'), { code: 'USER_STORAGE_INVALID_INVENTORY' });
  keysOf(inventory);
  if (own(inventory, 'cards') && !plain(inventory.cards)) {
    throw Object.assign(new Error('인벤토리 카드 맵이 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_INVENTORY' });
  }
  const version = own(inventory, 'version') && ['number', 'string', 'boolean'].includes(typeof inventory.version)
    ? Number(inventory.version) : own(inventory, 'version') ? NaN : 1;
  if (!Number.isSafeInteger(version) || version < 1 || version > 3) {
    throw Object.assign(new Error('지원하지 않는 인벤토리 버전입니다.'), { code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION' });
  }
}

function context(options = {}) {
  const path = options.basePath ?? '';
  if (typeof path !== 'string' || Buffer.from(path, 'utf8').toString('utf8') !== path) {
    fail('invalid-path', '저장 경로는 올바른 Unicode 문자열이어야 합니다.');
  }
  const normalized = path.replace(/^\/|\/$/g, '');
  const parts = path === '' || path === '/' ? [] : normalized.split('/');
  if (parts.some(part => !part || /[.#$\[\]\u0000-\u001f\u007f]/.test(part))) {
    fail('invalid-path', '저장 경로에 허용되지 않은 문자가 있습니다.');
  }
  if (options.baseDepth !== undefined && options.baseDepth !== parts.length) {
    fail('invalid-path', '저장 경로와 깊이가 일치하지 않습니다.');
  }
  return parts;
}

function validateNative(payload, parts) {
  const ancestors = new WeakSet();
  function visit(value, path) {
    if (path.length > 32) fail('depth-exceeded', '인벤토리 경로가 RTDB 깊이 한도를 초과합니다.');
    if (Buffer.byteLength(`/${path.join('/')}`, 'utf8') > 768) {
      fail('path-too-long', '인벤토리 전체 경로가 RTDB 길이 한도를 초과합니다.');
    }
    if (scalar(value)) return;
    if (!plain(value) || ancestors.has(value)) invalid('저장 인벤토리에는 null·배열·순환 값을 직접 둘 수 없습니다.');
    const keys = keysOf(value);
    if (!keys.length) invalid('RTDB에서 사라지는 빈 객체를 직접 저장할 수 없습니다.');
    ancestors.add(value);
    for (const key of keys) {
      if (!key || /[.#$\[\]\u0000-\u001f\u007f]/.test(key)
          || Buffer.from(key, 'utf8').toString('utf8') !== key) invalid('저장 인벤토리 키가 올바르지 않습니다.');
      visit(value[key], [...path, key]);
    }
    ancestors.delete(value);
  }
  visit(payload, parts);
}

function fields(node, required, optional = []) {
  if (!plain(node)) invalid('저장 인벤토리 노드가 올바르지 않습니다.');
  const keys = keysOf(node);
  if (required.some(key => !own(node, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    invalid('저장 인벤토리 필드 구성이 올바르지 않습니다.');
  }
}

function locationStateOf(state) {
  if (state === undefined) return { locationNames: {}, nextLocationId: 1 };
  fields(state, ['locationNames', 'nextLocationId']);
  if (!plain(state.locationNames) || !Number.isSafeInteger(state.nextLocationId) || state.nextLocationId < 1) {
    invalid('위치 사전 또는 다음 ID가 올바르지 않습니다.');
  }
  const names = {};
  const unique = new Set();
  for (const key of keysOf(state.locationNames)) {
    if (!/^l[1-9]\d*$/.test(key)) invalid('위치 ID 키가 올바르지 않습니다.');
    const id = Number(key.slice(1));
    const name = state.locationNames[key];
    if (!Number.isSafeInteger(id) || id >= state.nextLocationId || !string(name) || unique.has(name)) {
      invalid('위치 사전에 중복 원문 또는 범위 밖 ID가 있습니다.');
    }
    unique.add(name);
    names[key] = name;
  }
  return { locationNames: names, nextLocationId: state.nextLocationId };
}

function generic(value, parts) { return encodeValue(value, { basePath: parts.join('/') }); }
function ungeneric(value, parts) { return decodeValue(value, { basePath: parts.join('/') }); }

function addExtra(source, consumed, target, path) {
  const extra = {};
  for (const key of keysOf(source)) if (!consumed.has(key)) define(extra, key, source[key]);
  if (Object.keys(extra).length) target.extra = generic(extra, [...path, 'extra']);
  if (Object.getPrototypeOf(source) === null) target.nullPrototype = true;
}

function restoreExtra(target, node, path) {
  if (own(node, 'nullPrototype') && node.nullPrototype !== true) invalid('객체 원형 표시가 올바르지 않습니다.');
  if (own(node, 'extra')) {
    const extra = ungeneric(node.extra, [...path, 'extra']);
    if (!plain(extra)) invalid('추가 인벤토리 필드는 객체여야 합니다.');
    for (const key of Object.keys(extra)) {
      if (own(target, key)) invalid('추가 필드가 이미 복원한 필드와 충돌합니다.');
      define(target, key, extra[key]);
    }
  }
  return target;
}

function objectOf(node) { return node.nullPrototype === true ? Object.create(null) : {}; }

// 저장 순서대로 집계한다. 과거 집계와 값/배열/객체 키 순서가 다르면 별도 호환 값으로 보존한다.
function summarize(inventory) {
  const summary = { amount: 0, locations: {}, rarities: {} };
  for (const [number, card] of Object.entries(inventory.cards || {})) {
    if (!plain(card) || !Array.isArray(card.items)) continue;
    for (const index of Object.keys(card.items)) {
      const item = card.items[index];
      if (!plain(item) || !numeric(item.qty) || item.qty <= 0) continue;
      const rarity = item.rarity || item.proc || '';
      const location = item.loc;
      summary.amount += item.qty;
      if (string(rarity)) define(summary.rarities, rarity, (own(summary.rarities, rarity) ? summary.rarities[rarity] : 0) + item.qty);
      if (string(location)) {
        if (!own(summary.locations, location)) define(summary.locations, location, []);
        if (!summary.locations[location].includes(number)) summary.locations[location].push(number);
      }
    }
  }
  return summary;
}

function sameSummary(a, b) {
  return isDeepStrictEqual(a, b)
    && (!plain(a) || !plain(b) || isDeepStrictEqual(Object.keys(a), Object.keys(b)));
}

function compatibilityOf(inventory, computed, path) {
  const compatibility = {};
  for (const key of ['amount', 'locations', 'rarities']) {
    if (!own(inventory, key)) compatibility[key] = { present: false };
    else if (!sameSummary(inventory[key], computed[key])) {
      compatibility[key] = { present: true, value: inventory[key] };
      // RTDB는 객체 키를 정렬할 수 있으므로 UI에서 쓰는 원래 위치 키 순서도 별도로 둔다.
      if (plain(inventory[key])) compatibility[key].keys = Object.keys(inventory[key]);
    }
  }
  return Object.keys(compatibility).length ? generic(compatibility, path) : undefined;
}

function restoreSummary(inventory, payload, path) {
  const computed = summarize(inventory);
  for (const key of ['amount', 'locations', 'rarities']) define(inventory, key, computed[key]);
  if (!own(payload, 'summaryCompatibility')) return;
  const compatibility = ungeneric(payload.summaryCompatibility, [...path, 'summaryCompatibility']);
  if (!plain(compatibility)) invalid('과거 집계 보존 형식이 올바르지 않습니다.');
  for (const key of Object.keys(compatibility)) {
    if (!['amount', 'locations', 'rarities'].includes(key)) invalid('알 수 없는 과거 집계 필드입니다.');
    const entry = compatibility[key];
    if (entry?.present === false) {
      fields(entry, ['present']);
      delete inventory[key];
      continue;
    }
    fields(entry, ['present', 'value'], ['keys']);
    if (entry.present !== true) invalid('과거 집계 존재 여부가 올바르지 않습니다.');
    let value = entry.value;
    if (own(entry, 'keys')) {
      if (!plain(value) || !Array.isArray(entry.keys) || entry.keys.length !== Object.keys(value).length
          || new Set(entry.keys).size !== entry.keys.length || entry.keys.some(keyName => !string(keyName) || !own(value, keyName))) {
        invalid('과거 집계 키 순서가 올바르지 않습니다.');
      }
      const ordered = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
      for (const keyName of entry.keys) define(ordered, keyName, value[keyName]);
      value = ordered;
    }
    define(inventory, key, value);
  }
}

function encodeCardNode(card, number, { basePath = '', allocateLocation } = {}) {
  const path = context({ basePath });
  if (!string(number) || typeof allocateLocation !== 'function') invalid('카드 번호와 위치 할당 함수가 필요합니다.');
  function encodeItem(item, itemPath) {
    if (!plain(item)) return { raw: generic(item, [...itemPath, 'raw']) };
    keysOf(item);
    const result = {};
    const used = new Set();
    for (const [key, valid] of [['rarity', string], ['qty', numeric], ['illustration', string]]) {
      if (own(item, key) && valid(item[key])) { result[key] = item[key]; used.add(key); }
    }
    if (own(item, 'loc') && string(item.loc)) { result.loc = allocateLocation(item.loc); used.add('loc'); }
    addExtra(item, used, result, itemPath);
    // RTDB에서 사라지는 빈 항목만 별도로 표시한다.
    if (!Object.keys(result).length) result.empty = true;
    return result;
  }

  function encodeCard(card, number, cardPath) {
    if (!plain(card)) return { number, raw: generic(card, [...cardPath, 'raw']) };
    keysOf(card);
    const result = { number };
    const used = new Set();
    for (const [key, valid] of [['name', string], ['cid', string], ['cidCheckedAt', numeric]]) {
      if (own(card, key) && valid(card[key])) { result[key] = card[key]; used.add(key); }
    }
    if (own(card, 'cid') && card.cid === null) { result.cidNull = true; used.add('cid'); }
    if (own(card, 'items') && Array.isArray(card.items)) {
      const items = { count: card.items.length };
      for (const key of keysOf(card.items)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= card.items.length || String(index) !== key) {
          fail('unsupported-value', '인벤토리 항목 배열에 일반 인덱스 외 속성이 있습니다.');
        }
        items[`i${key}`] = encodeItem(card.items[key], [...cardPath, 'items', `i${key}`]);
      }
      result.items = items;
      used.add('items');
    }
    addExtra(card, used, result, cardPath);
    return result;
  }
  const node = encodeCard(card, number, path);
  validateNative(node, path);
  return node;
}

function encode({ inventory, locationState } = {}, options) {
  validateInventory(inventory);
  const path = context(options);
  const state = locationStateOf(locationState);
  const ids = new Map(Object.entries(state.locationNames).map(([key, value]) => [value, Number(key.slice(1))]));
  const activeNames = {};
  const allocate = name => {
    let id = ids.get(name);
    if (id === undefined) {
      if (state.nextLocationId >= Number.MAX_SAFE_INTEGER) invalid('새 위치 ID를 안전하게 발급할 수 없습니다.');
      id = state.nextLocationId++;
      ids.set(name, id);
    }
    activeNames[`l${id}`] = name;
    return id;
  };
  const payload = { type: 'inventory', version: 1, nextLocationId: state.nextLocationId };
  const consumed = new Set(['amount', 'locations', 'rarities']);
  if (own(inventory, 'version') && scalar(inventory.version)) { payload.inventoryVersion = inventory.version; consumed.add('version'); }
  if (own(inventory, 'updatedAt') && scalar(inventory.updatedAt)) { payload.updatedAt = inventory.updatedAt; consumed.add('updatedAt'); }

  if (own(inventory, 'cards')) {
    const numbers = keysOf(inventory.cards);
    const cards = { count: numbers.length };
    if (Object.getPrototypeOf(inventory.cards) === null) cards.nullPrototype = true;
    numbers.forEach((number, index) => { cards[`c${index}`] = encodeCardNode(inventory.cards[number], number,
      { basePath: [...path, 'cards', `c${index}`].join('/'), allocateLocation: allocate }); });
    payload.cards = cards;
    consumed.add('cards');
  }
  addExtra(inventory, consumed, payload, path);
  payload.nextLocationId = state.nextLocationId;
  if (Object.keys(activeNames).length) payload.locationNames = activeNames;
  const compatibility = compatibilityOf(inventory, summarize(inventory), [...path, 'summaryCompatibility']);
  if (compatibility) payload.summaryCompatibility = compatibility;
  validateNative(payload, path);
  return payload;
}

function decodeCardNode(node, { basePath = '', locationState } = {}) {
  const path = context({ basePath });
  validateNative(node, path);
  if (!plain(node) || !string(node.number)) invalid('카드 번호가 올바르지 않습니다.');
  const state = locationStateOf(locationState);
  const usedLocations = new Set();

  function decodeItem(node, itemPath) {
    if (own(node, 'raw')) { fields(node, ['raw']); return ungeneric(node.raw, [...itemPath, 'raw']); }
    fields(node, [], ['rarity', 'qty', 'loc', 'illustration', 'extra', 'nullPrototype', 'empty']);
    if (own(node, 'empty') && (node.empty !== true || Object.keys(node).length !== 1)) invalid('빈 항목 표시가 올바르지 않습니다.');
    const item = objectOf(node);
    for (const [key, valid] of [['rarity', string], ['qty', numeric], ['illustration', string]]) {
      if (own(node, key)) {
        if (!valid(node[key])) invalid('인벤토리 항목 값이 올바르지 않습니다.');
        define(item, key, node[key]);
      }
    }
    if (own(node, 'loc')) {
      if (!Number.isSafeInteger(node.loc) || node.loc < 1 || !own(state.locationNames, `l${node.loc}`)) invalid('인벤토리 위치 참조가 사전에 없습니다.');
      usedLocations.add(`l${node.loc}`);
      define(item, 'loc', state.locationNames[`l${node.loc}`]);
    }
    return restoreExtra(item, node, itemPath);
  }

  function decodeCard(node, cardPath) {
    if (own(node, 'raw')) { fields(node, ['number', 'raw']); return ungeneric(node.raw, [...cardPath, 'raw']); }
    fields(node, ['number'], ['name', 'cid', 'cidNull', 'cidCheckedAt', 'items', 'extra', 'nullPrototype']);
    const card = objectOf(node);
    for (const [key, valid] of [['name', string], ['cid', string], ['cidCheckedAt', numeric]]) {
      if (own(node, key)) {
        if (!valid(node[key])) invalid('카드 저장 값이 올바르지 않습니다.');
        define(card, key, node[key]);
      }
    }
    if (own(node, 'cidNull')) {
      if (node.cidNull !== true || own(node, 'cid')) invalid('CID null 표시가 올바르지 않습니다.');
      card.cid = null;
    }
    if (own(node, 'items')) {
      const items = node.items;
      if (!plain(items) || !own(items, 'count') || !Number.isInteger(items.count) || items.count < 0 || items.count > 4294967295) invalid('항목 배열 길이가 올바르지 않습니다.');
      const restored = new Array(items.count);
      for (const key of Object.keys(items)) {
        if (key === 'count') continue;
        if (!/^i(?:0|[1-9]\d*)$/.test(key) || Number(key.slice(1)) >= items.count) invalid('항목 배열 인덱스가 올바르지 않습니다.');
        restored[Number(key.slice(1))] = decodeItem(items[key], [...cardPath, 'items', key]);
      }
      card.items = restored;
    }
    return restoreExtra(card, node, cardPath);
  }
  return { card: decodeCard(node, path), usedLocationIds: [...usedLocations] };
}

function decode(payload, options) {
  const path = context(options);
  if (plain(payload) && !own(payload, 'type') && own(payload, 'value')) {
    const inventory = ungeneric(payload, path);
    validateInventory(inventory);
    return { inventory, locationState: { locationNames: {}, nextLocationId: 1 } };
  }
  validateNative(payload, path);
  fields(payload, ['type', 'version', 'nextLocationId'],
    ['locationNames', 'inventoryVersion', 'updatedAt', 'cards', 'extra', 'nullPrototype', 'summaryCompatibility']);
  if (payload.type !== 'inventory' || payload.version !== 1) invalid('지원하지 않는 인벤토리 저장 형식입니다.');
  const state = locationStateOf({ locationNames: own(payload, 'locationNames') ? payload.locationNames : {}, nextLocationId: payload.nextLocationId });
  const usedLocations = new Set();
  const inventory = objectOf(payload);
  if (own(payload, 'inventoryVersion')) define(inventory, 'version', payload.inventoryVersion);
  if (own(payload, 'updatedAt')) define(inventory, 'updatedAt', payload.updatedAt);

  if (own(payload, 'cards')) {
    const collection = payload.cards;
    if (!plain(collection) || !own(collection, 'count') || !Number.isSafeInteger(collection.count) || collection.count < 0
        || (own(collection, 'nullPrototype') && collection.nullPrototype !== true)) invalid('카드 목록 메타데이터가 올바르지 않습니다.');
    const cardKeys = Object.keys(collection).filter(key => !['count', 'nullPrototype'].includes(key));
    if (cardKeys.length !== collection.count || cardKeys.some(key => !/^c(?:0|[1-9]\d*)$/.test(key) || Number(key.slice(1)) >= collection.count)) invalid('카드 목록 순서가 올바르지 않습니다.');
    const cards = objectOf(collection);
    for (let index = 0; index < collection.count; index++) {
      const key = `c${index}`;
      const node = collection[key];
      if (!plain(node) || !string(node.number) || own(cards, node.number)) invalid('카드 번호가 없거나 중복되었습니다.');
      const decoded = decodeCardNode(node, { basePath: [...path, 'cards', key].join('/'), locationState: state });
      for (const location of decoded.usedLocationIds) usedLocations.add(location);
      define(cards, node.number, decoded.card);
    }
    inventory.cards = cards;
  }
  restoreExtra(inventory, payload, path);
  if (own(inventory, 'amount') || own(inventory, 'locations') || own(inventory, 'rarities')) invalid('집계 필드를 추가 필드로 중복 저장할 수 없습니다.');
  restoreSummary(inventory, payload, path);
  if (Object.keys(state.locationNames).some(key => !usedLocations.has(key))) invalid('사용하지 않는 위치 사전 항목이 남아 있습니다.');
  validateInventory(inventory);
  return { inventory, locationState: state };
}

module.exports = { inventoryPayloadCodec: { encode, decode }, encodeCardNode, decodeCardNode,
  validateLocationState: locationStateOf,
  validatePayloadPaths: (payload, options) => validateNative(payload, context(options)) };
