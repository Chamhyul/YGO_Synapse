'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { encodeValue, decodeValue } = require('./codec');
const RETRY_MS = 86400000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const define = (object, key, value) => Object.defineProperty(object, key,
  { value, enumerable: true, configurable: true, writable: true });
const invalid = () => { throw Object.assign(new Error('인벤토리 API 요약이 본문 또는 참조와 일치하지 않습니다.'), { code: 'USER_STORAGE_INVALID_API_SUMMARY' }); };
const validCid = value => typeof value === 'string' && value.length > 0
  && !['LOCAL_CID', 'MISSING_CID', 'null', 'undefined'].includes(value) && !value.includes('/');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function fingerprint(manifest, value) {
  return createHash('sha256').update(JSON.stringify(stable({ header: manifest.header, cards: manifest.cards, value }))).digest('hex');
}
function rows(cards) {
  const totals = { amount: 0, locations: new Map(), rarities: new Map(), pendingCount: 0, unresolvedCount: 0, nextRetryAt: 0, prepared: true };
  for (const [number, card] of Object.entries(cards || {})) {
    if (!plain(card) || !Array.isArray(card.items)) { totals.prepared = false; continue; }
    if (!validCid(card.cid)) {
      totals.unresolvedCount++;
      if (!(card.cid === null && card.cidCheckedAt)) totals.pendingCount++;
      else if (typeof card.cidCheckedAt === 'number' && Number.isSafeInteger(card.cidCheckedAt) && card.cidCheckedAt > 0) {
        const due = card.cidCheckedAt + RETRY_MS;
        totals.nextRetryAt = totals.nextRetryAt ? Math.min(totals.nextRetryAt, due) : due;
      } else totals.prepared = false;
    }
    const identities = new Set();
    if (Object.keys(card.items).length !== card.items.length) totals.prepared = false;
    for (const item of card.items) {
      if (!plain(item) || !Number.isSafeInteger(item.qty) || item.qty <= 0 || typeof item.loc !== 'string'
          || typeof (item.rarity || item.proc || '') !== 'string') { totals.prepared = false; continue; }
      const rarity = item.rarity || item.proc || '';
      totals.amount += item.qty;
      totals.rarities.set(rarity, (totals.rarities.get(rarity) || 0) + item.qty);
      if (!totals.locations.has(item.loc)) totals.locations.set(item.loc, new Set());
      totals.locations.get(item.loc).add(number);
      const illustration = item.illustration;
      const match = typeof illustration === 'string' && illustration.match(/^(\d+)(?:st|nd|rd|th)?$/i);
      if (typeof illustration !== 'string' || !illustration || illustration.trim() !== illustration
          || illustration === '기본' || illustration === '0' || (match && String(Number(match[1])) !== illustration)
          || own(item, 'another')) totals.prepared = false;
      const identity = JSON.stringify([rarity, item.loc, illustration]);
      if (identities.has(identity)) totals.prepared = false;
      identities.add(identity);
    }
  }
  if (!Number.isSafeInteger(totals.amount) || [...totals.rarities.values()].some(value => !Number.isSafeInteger(value))) totals.prepared = false;
  return totals;
}
function matches(inventory, totals) {
  if (inventory.amount !== totals.amount || !plain(inventory.locations) || !plain(inventory.rarities)) return false;
  if (Object.keys(inventory.locations).length !== totals.locations.size) return false;
  for (const [name, numbers] of totals.locations) {
    if (!own(inventory.locations, name) || !Array.isArray(inventory.locations[name])) return false;
    const saved = inventory.locations[name];
    if (saved.length !== numbers.size || new Set(saved).size !== saved.length || saved.some(number => !numbers.has(number))) return false;
  }
  for (const [name, count] of totals.rarities) if (!own(inventory.rarities, name) || inventory.rarities[name] !== count) return false;
  return Object.entries(inventory.rarities).every(([name, count]) => Number.isSafeInteger(count) && count >= 0 && count === (totals.rarities.get(name) || 0));
}
const packMap = value => ({ entries: Object.entries(value), nullPrototype: Object.getPrototypeOf(value) === null });
function unpackMap(value) {
  if (!plain(value) || typeof value.nullPrototype !== 'boolean' || !Array.isArray(value.entries)) invalid();
  const result = value.nullPrototype ? Object.create(null) : {};
  for (const entry of value.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || own(result, entry[0])) invalid();
    define(result, entry[0], entry[1]);
  }
  return result;
}
function migrationOf(inventory, totals) {
  const retryAt = inventory.cidMigration?.retryAt || 0;
  if (typeof retryAt !== 'number' || !Number.isFinite(retryAt)) return undefined;
  return { pendingCount: totals.pendingCount, unresolvedCount: totals.unresolvedCount,
    nextRetryAt: totals.nextRetryAt, retryAt, retryableError: inventory.cidMigration?.retryableError === true };
}
function encodeSummary(manifest, inventory, migration, options = {}) {
  const payload = { amount: inventory.amount, locations: packMap(inventory.locations), rarities: packMap(inventory.rarities), migration };
  const value = encodeValue(payload, { basePath: `${options.basePath || ''}/apiSummary/value`.replace(/^\//, '') });
  return { type: 'inventory-api-summary', version: 1, fingerprint: fingerprint(manifest, value), value };
}
function buildApiSummary(manifest, inventory, options) {
  const totals = rows(inventory.cards);
  if (inventory.version !== 3 || own(inventory, 'cidMigration') || !plain(inventory.cards) || !totals.prepared || !matches(inventory, totals)) return undefined;
  const migration = migrationOf(inventory, totals);
  if (!migration) return undefined;
  return encodeSummary(manifest, inventory, migration, options);
}
function readApiSummary(manifest, options = {}) {
  const node = manifest.apiSummary;
  if (!node) return undefined;
  if (!plain(node) || Object.keys(node).length !== 4 || node.type !== 'inventory-api-summary' || node.version !== 1
      || node.fingerprint !== fingerprint(manifest, node.value)) invalid();
  const value = decodeValue(node.value, { basePath: `${options.basePath || ''}/apiSummary/value`.replace(/^\//, '') });
  if (!plain(value) || Object.keys(value).length !== 4 || !Number.isSafeInteger(value.amount) || value.amount < 0) invalid();
  const locations = unpackMap(value.locations), rarities = unpackMap(value.rarities), migration = value.migration;
  if (!plain(migration) || Object.keys(migration).length !== 5 || !Number.isSafeInteger(migration.pendingCount)
      || !Number.isSafeInteger(migration.unresolvedCount) || migration.pendingCount < 0
      || migration.unresolvedCount < migration.pendingCount || migration.unresolvedCount > (manifest.cards?.count ?? 0)
      || !Number.isFinite(migration.nextRetryAt) || !Number.isFinite(migration.retryAt) || typeof migration.retryableError !== 'boolean') invalid();
  for (const numbers of Object.values(locations)) if (!Array.isArray(numbers) || !numbers.length
      || numbers.some(number => typeof number !== 'string') || new Set(numbers).size !== numbers.length) invalid();
  if (Object.values(rarities).some(count => !Number.isSafeInteger(count) || count < 0)) invalid();
  return { amount: value.amount, locations, rarities, migration };
}
function validateApiSummary(manifest, inventory, options) {
  const summary = readApiSummary(manifest, options);
  if (!summary) return;
  const expected = buildApiSummary(manifest, inventory, options);
  if (!expected) invalid();
  const rebuilt = readApiSummary({ ...manifest, apiSummary: expected }, options);
  const earliest = rebuilt.migration.nextRetryAt;
  if (summary.migration.nextRetryAt && earliest && summary.migration.nextRetryAt > earliest) invalid();
  if ((!summary.migration.nextRetryAt && earliest) || (!summary.migration.unresolvedCount && summary.migration.nextRetryAt)) invalid();
  rebuilt.migration.nextRetryAt = summary.migration.nextRetryAt;
  if (!isDeepStrictEqual(summary, rebuilt)) invalid();
}
function migrationStatus(summary, now = Date.now()) {
  const value = summary.migration;
  return { status: value.retryableError ? 'retryableError' : value.pendingCount || (value.nextRetryAt && now >= value.nextRetryAt) ? 'pending' : 'complete',
    pendingCount: value.pendingCount, unresolvedCount: value.unresolvedCount, retryAt: value.retryAt };
}
function patchApiSummary(manifest, before, inventory, previous, options) {
  const old = rows(before), next = rows(inventory.cards);
  if (!old.prepared || !next.prepared) invalid();
  const totals = { amount: previous.amount - old.amount + next.amount, rarities: new Map(Object.entries(previous.rarities)),
    locations: new Map(Object.entries(previous.locations).map(([name, numbers]) => [name, new Set(numbers)])) };
  for (const [name, count] of old.rarities) totals.rarities.set(name, (totals.rarities.get(name) || 0) - count);
  for (const [name, count] of next.rarities) totals.rarities.set(name, (totals.rarities.get(name) || 0) + count);
  for (const [name, numbers] of old.locations) for (const number of numbers) totals.locations.get(name)?.delete(number);
  for (const [name, numbers] of next.locations) {
    if (!totals.locations.has(name)) totals.locations.set(name, new Set());
    for (const number of numbers) totals.locations.get(name).add(number);
  }
  for (const [name, numbers] of totals.locations) if (!numbers.size) totals.locations.delete(name);
  if (!matches(inventory, totals)) invalid();
  const migration = { ...previous.migration,
    pendingCount: previous.migration.pendingCount - old.pendingCount + next.pendingCount,
    unresolvedCount: previous.migration.unresolvedCount - old.unresolvedCount + next.unresolvedCount };
  // 가장 이른 재조회 시각은 보수적으로 유지한다. 제거된 카드의 시각 때문에 전체 준비가
  // 일찍 실행될 수 있지만 미선택 미확정 카드의 재조회를 늦추지는 않는다.
  if (next.nextRetryAt) migration.nextRetryAt = migration.nextRetryAt ? Math.min(migration.nextRetryAt, next.nextRetryAt) : next.nextRetryAt;
  if (!migration.unresolvedCount) migration.nextRetryAt = 0;
  return encodeSummary(manifest, inventory, migration, options);
}
// 포착용 버전 주소만 바꾼다. 기존 집계 검증을 먼저 통과해야 하며 값/헤더는 바꾸지 않는다.
function retokenApiSummary(manifest, versions, options = {}) {
  readApiSummary(manifest, options);
  const hashes = new Set();
  if (!Array.isArray(versions)) invalid();
  for (const item of versions) {
    if (!item || hashes.has(item.hash) || !manifest.cards?.[item.hash] || !/^[a-f0-9]{32}$/.test(item.token)) invalid();
    hashes.add(item.hash);
  }
  for (const item of versions) manifest.cards[item.hash].v = item.token;
  if (manifest.apiSummary) manifest.apiSummary.fingerprint = fingerprint(manifest, manifest.apiSummary.value);
}
module.exports = { buildApiSummary, readApiSummary, validateApiSummary, patchApiSummary, migrationStatus, retokenApiSummary };
