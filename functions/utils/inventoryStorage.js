/**
 * inventoryStorage.js
 * Firebase Storage 기반 유저 인벤토리 읽기/쓰기 공통 유틸리티
 *
 * Storage 파일 구조:
 *   - users/{uid}/inventory.json : 유저별 전체 인벤토리 (비공개, Admin SDK만 접근)
 *
 * 동시성 제어:
 *   - Cloud Storage의 generation 기반 낙관적 잠금 (ifGenerationMatch)
 *   - 충돌 시 자동 재시도 (최대 3회)
 */
const { admin } = require("../config/firebase");

const INVENTORY_DIR = "users";

/**
 * 빈 인벤토리 객체를 생성합니다.
 * @returns {Object} 빈 인벤토리 구조
 */
function createEmptyInventory() {
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    amount: 0,
    locations: {},
    rarities: {},
    cards: {}
  };
}

/**
 * Storage에서 users/{uid}/inventory.json을 다운로드합니다.
 * @param {string} uid - 유저 UID
 * @returns {Promise<{data: Object, generation: string}>} 인벤토리 데이터와 generation
 */
async function downloadInventory(uid) {
  const bucket = admin.storage().bucket();
  const path = `${INVENTORY_DIR}/${uid}/inventory.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let metadata;
    try { [metadata] = await bucket.file(path).getMetadata(); }
    catch (error) {
      if (Number(error.code) === 404) return { data: createEmptyInventory(), generation: '0' };
      throw error;
    }
    try {
      const [content] = await bucket.file(path, { generation: metadata.generation }).download();
      const data = JSON.parse(content.toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          (data.cards && (typeof data.cards !== 'object' || Array.isArray(data.cards)))) {
        throw new Error('인벤토리 형식이 올바르지 않습니다. 원본을 보존합니다.');
      }
      if (Number(data.version || 1) > 3) throw new Error('지원하지 않는 인벤토리 버전입니다.');
      return { data, generation: String(metadata.generation) };
    } catch (error) {
      if (Number(error.code) === 404 && attempt < 2) continue;
      throw error;
    }
  }
}

// 이관과 일반 수정 모두 최신 generation의 본문에 변경을 적용합니다.
async function updateInventoryWithRetry(uid, updateFn, maxRetries = 3) {
  const file = admin.storage().bucket().file(`${INVENTORY_DIR}/${uid}/inventory.json`);
  const { prepareInventoryV2, inventoryMigrationStatus } = require('../services/inventoryMigrationService');
  const resolutions = new Map();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, generation } = await downloadInventory(uid);
    const before = JSON.stringify(data);
    await prepareInventoryV2(data, resolutions);
    await updateFn(data);
    const status = inventoryMigrationStatus(data);
    data.version = status.status === 'complete' ? 3 : 1;
    if (before === JSON.stringify(data)) return data;
    data.updatedAt = new Date().toISOString();
    try {
      await file.save(JSON.stringify(data), {
        resumable: false,
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: generation === '0' ? 0 : generation },
      });
      return data;
    } catch (error) {
      if (Number(error.code) === 412 && attempt < maxRetries - 1) continue;
      throw error;
    }
  }
}

/**
 * 유저 인벤토리 파일을 삭제합니다.
 * @param {string} uid - 유저 UID
 * @returns {Promise<void>}
 */
async function deleteInventory(uid) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`${INVENTORY_DIR}/${uid}/inventory.json`);
  try {
    await file.delete();
  } catch (e) {
    if (e.code === 404 || (e.message && e.message.includes("No such object"))) {
      return; // 이미 없으면 무시
    }
    throw e;
  }
}

function updateUserLocationsSummary(userData, changedCardsLocMap) {
  if (!userData.locations) userData.locations = {};
  for (const cardNo in changedCardsLocMap) {
    const activeLocs = changedCardsLocMap[cardNo];
    for (const loc of activeLocs) {
      if (!userData.locations[loc]) userData.locations[loc] = [];
    }
    for (const loc in userData.locations) {
      const idx = userData.locations[loc].indexOf(cardNo);
      if (activeLocs.includes(loc)) {
        if (idx === -1) userData.locations[loc].push(cardNo);
      } else {
        if (idx !== -1) {
          userData.locations[loc].splice(idx, 1);
          if (userData.locations[loc].length === 0) {
            delete userData.locations[loc];
          }
        }
      }
    }
  }
}

function processAddCards(inventory, cardGroups, operationResults = []) {
  const { normalizeIllustrationId } = require('../services/inventoryMigrationService');
  if (!inventory.cards) inventory.cards = {};
  if (!inventory.locations) inventory.locations = {};
  if (!inventory.rarities) inventory.rarities = {};
  if (typeof inventory.amount !== 'number') inventory.amount = 0;

  const updatedItems = [];

  for (const cardNo in cardGroups) {
    const group = cardGroups[cardNo];
    const cardEntry = inventory.cards[cardNo] || { name: group.name, cid: group.cid || null, cidCheckedAt: Date.now(), items: [] };
    const cardName = group.name || cardEntry.name || "Unknown";
    cardEntry.name = cardName;
    if (Object.hasOwn(group, 'cid')) {
      cardEntry.cid = group.cid;
      cardEntry.cidCheckedAt = Date.now();
    }

    group.items.forEach(incoming => {
      incoming = { ...incoming, illustration: normalizeIllustrationId(incoming.illustration ?? incoming.another) };
      if (!Number.isSafeInteger(Number(incoming.qty)) || Number(incoming.qty) <= 0) {
        operationResults.push({ requestIndex: incoming.requestIndex, status: 'fail', qty: 0, failReason: 'invalid_qty' });
        return;
      }
      incoming.qty = Number(incoming.qty);
      let matchIndex = -1;
      for (let i = 0; i < cardEntry.items.length; i++) {
        const iRare = cardEntry.items[i].rarity || cardEntry.items[i].proc;
        const iLoc = cardEntry.items[i].loc;
        const iIllust = cardEntry.items[i].illustration || cardEntry.items[i].another;
        if (iRare === incoming.rarity && iLoc === incoming.loc && iIllust === incoming.illustration) {
          matchIndex = i; break;
        }
      }

      const nextQty = (matchIndex > -1 ? cardEntry.items[matchIndex].qty : 0) + incoming.qty;
      if (![nextQty, inventory.amount + incoming.qty, (inventory.rarities[incoming.rarity] || 0) + incoming.qty].every(Number.isSafeInteger)) {
        operationResults.push({ requestIndex: incoming.requestIndex, status: 'fail', qty: 0, failReason: 'invalid_qty' });
        return;
      }
      inventory.cards[cardNo] = cardEntry;
      if (matchIndex > -1) {
        cardEntry.items[matchIndex].qty = nextQty;
      } else {
        const { requestIndex, ...storedItem } = incoming;
        cardEntry.items.push(storedItem);
      }

      operationResults.push({ requestIndex: incoming.requestIndex, status: 'success', qty: incoming.qty });
      inventory.amount += incoming.qty;
      inventory.rarities[incoming.rarity] = (inventory.rarities[incoming.rarity] || 0) + incoming.qty;

      if (!inventory.locations[incoming.loc]) inventory.locations[incoming.loc] = [];
      if (!inventory.locations[incoming.loc].includes(cardNo)) {
        inventory.locations[incoming.loc].push(cardNo);
      }

      updatedItems.push({
        cardNo,
        name: cardName,
        cid: cardEntry.cid || null,
        rarity: incoming.rarity,
        qty: matchIndex > -1 ? cardEntry.items[matchIndex].qty : incoming.qty,
        loc: incoming.loc,
        illustration: incoming.illustration,
        isDeleted: false
      });
    });
  }
  return updatedItems;
}

// 최신 재고를 입력 순서대로 확인한다. 부족/미발견 행은 변경하지 않는다.
function processCardChanges(inventory, requests, operation, operationResults) {
  const { normalizeIllustrationId } = require('../services/inventoryMigrationService');
  if (!inventory.cards) inventory.cards = {};
  if (!inventory.locations) inventory.locations = {};
  if (!inventory.rarities) inventory.rarities = {};
  const updatedItems = [];
  const changedCardsLocMap = {};
  requests.forEach((request, requestIndex) => {
    const cardNo = String(request.cardNo || '').trim().toUpperCase();
    const qty = Number(operation === 'move' ? request.moveQty : request.qty);
    const fail = failReason => operationResults.push({ requestIndex, status: 'fail', qty: 0, failReason });
    if (!Number.isSafeInteger(qty) || qty <= 0) { fail('invalid_qty'); return; }
    const cardEntry = inventory.cards[cardNo];
    if (!cardEntry) { fail('no_inventory'); return; }
    const rarity = request.rarity || request.proc || '';
    const illustration = normalizeIllustrationId(request.illustration ?? request.another);
    const loc = operation === 'move' ? request.currentLoc || request.loc || '' : request.loc || '';
    const targetLoc = request.targetLoc || '';
    if (operation === 'move' && !targetLoc) { fail('no_target_loc'); return; }
    if (operation === 'move' && loc === targetLoc) { fail('same_loc'); return; }
    const items = cardEntry.items || [];
    const source = items.find(item => (item.rarity || item.proc) === rarity && item.loc === loc
      && normalizeIllustrationId(item.illustration ?? item.another) === illustration);
    if (!source) { fail('no_inventory'); return; }
    if (source.qty < qty) { fail('insufficient_qty'); return; }
    const target = operation === 'move' ? items.find(item => item !== source && (item.rarity || item.proc) === rarity
      && item.loc === targetLoc && normalizeIllustrationId(item.illustration ?? item.another) === illustration) : null;
    if (target && !Number.isSafeInteger(target.qty + qty)) { fail('invalid_qty'); return; }
    source.qty -= qty;
    const cacheItem = (location, quantity) => ({ cardNo, name: cardEntry.name || 'Unknown',
      cid: cardEntry.cid || null, rarity, illustration, loc: location, qty: quantity, isDeleted: quantity === 0 });
    updatedItems.push(cacheItem(loc, source.qty));
    if (operation === 'move') {
      if (target) target.qty += qty;
      else items.push({ rarity, illustration, loc: targetLoc, qty });
      updatedItems.push(cacheItem(targetLoc, target ? target.qty : qty));
    } else {
      inventory.amount -= qty;
      inventory.rarities[rarity] = Math.max(0, (inventory.rarities[rarity] || 0) - qty);
    }
    cardEntry.items = items.filter(item => item.qty > 0);
    changedCardsLocMap[cardNo] = [...new Set(cardEntry.items.map(item => item.loc))];
    if (!cardEntry.items.length) delete inventory.cards[cardNo];
    operationResults.push({ requestIndex, status: 'success', qty });
  });
  updateUserLocationsSummary(inventory, changedCardsLocMap);
  return updatedItems;
}

function processMoveCards(inventory, moves, operationResults = []) {
  return processCardChanges(inventory, moves, 'move', operationResults);
}

function processDiscardCards(inventory, discards, operationResults = []) {
  return processCardChanges(inventory, discards, 'discard', operationResults);
}

module.exports = {
  createEmptyInventory,
  downloadInventory,
  updateInventoryWithRetry,
  deleteInventory,
  updateUserLocationsSummary,
  processAddCards,
  processMoveCards,
  processDiscardCards,
};
