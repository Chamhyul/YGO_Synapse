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

function processAddCards(inventory, cardGroups) {
  const { normalizeIllustrationId } = require('../services/inventoryMigrationService');
  if (!inventory.cards) inventory.cards = {};
  if (!inventory.locations) inventory.locations = {};
  if (!inventory.rarities) inventory.rarities = {};
  if (typeof inventory.amount !== 'number') inventory.amount = 0;

  const updatedItems = [];

  for (const cardNo in cardGroups) {
    const group = cardGroups[cardNo];
    if (!inventory.cards[cardNo]) {
      inventory.cards[cardNo] = { name: group.name, cid: group.cid || null, cidCheckedAt: Date.now(), items: [] };
    }
    const cardEntry = inventory.cards[cardNo];
    const cardName = group.name || cardEntry.name || "Unknown";
    cardEntry.name = cardName;
    if (Object.hasOwn(group, 'cid')) {
      cardEntry.cid = group.cid;
      cardEntry.cidCheckedAt = Date.now();
    }

    group.items.forEach(incoming => {
      incoming = { ...incoming, illustration: normalizeIllustrationId(incoming.illustration ?? incoming.another) };
      let matchIndex = -1;
      for (let i = 0; i < cardEntry.items.length; i++) {
        const iRare = cardEntry.items[i].rarity || cardEntry.items[i].proc;
        const iLoc = cardEntry.items[i].loc;
        const iIllust = cardEntry.items[i].illustration || cardEntry.items[i].another;
        if (iRare === incoming.rarity && iLoc === incoming.loc && iIllust === incoming.illustration) {
          matchIndex = i; break;
        }
      }

      if (matchIndex > -1) {
        cardEntry.items[matchIndex].qty += incoming.qty;
      } else {
        cardEntry.items.push({ ...incoming });
      }

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

function processMoveCards(inventory, moves) {
  const { normalizeIllustrationId } = require('../services/inventoryMigrationService');
  if (!inventory.cards) inventory.cards = {};
  if (!inventory.locations) inventory.locations = {};

  const updatedItems = [];
  const moveGroups = {};
  moves.forEach(m => {
    const cNo = String(m.cardNo).toUpperCase() || "NO_NUMBER";
    if (!moveGroups[cNo]) moveGroups[cNo] = [];
    moveGroups[cNo].push(m);
  });

  const changedCardsLocMap = {};

  for (const cardNo in moveGroups) {
    const cardEntry = inventory.cards[cardNo];
    if (!cardEntry) continue;

    let items = cardEntry.items || [];
    const cardName = cardEntry.name || "Unknown";

    moveGroups[cardNo].forEach(m => {
      const moveQ = parseInt(m.moveQty) || 0;
      if (moveQ <= 0) return;

      const mRare = m.rarity || m.proc || "";
      const mIllust = normalizeIllustrationId(m.illustration ?? m.another);
      const mCurLoc = m.currentLoc || m.loc || "";
      const mTarLoc = m.targetLoc || "";

      let sourceIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const iRare = items[i].rarity || items[i].proc;
        const iIllust = items[i].illustration || items[i].another;
        if (iRare === mRare && items[i].loc === mCurLoc && iIllust === mIllust) {
          sourceIdx = i; break;
        }
      }
      if (sourceIdx === -1) return;

      let newSourceQty = items[sourceIdx].qty - moveQ;
      if (newSourceQty < 0) newSourceQty = 0;
      items[sourceIdx].qty = newSourceQty;
      updatedItems.push({ cardNo, name: cardName, cid: cardEntry.cid || null, rarity: mRare, illustration: mIllust, loc: mCurLoc, qty: newSourceQty, isDeleted: newSourceQty === 0 });

      let targetIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const iRare = items[i].rarity || items[i].proc;
        const iIllust = items[i].illustration || items[i].another;
        if (i !== sourceIdx && iRare === mRare && items[i].loc === mTarLoc && iIllust === mIllust) {
          targetIdx = i; break;
        }
      }

      if (targetIdx > -1) {
        items[targetIdx].qty += moveQ;
      } else {
        items.push({ rarity: mRare, loc: mTarLoc, illustration: mIllust, qty: moveQ });
      }
      updatedItems.push({ cardNo, name: cardName, cid: cardEntry.cid || null, rarity: mRare, illustration: mIllust, loc: mTarLoc, qty: targetIdx > -1 ? items[targetIdx].qty : moveQ, isDeleted: false });
    });

    items = items.filter(it => it.qty > 0);
    cardEntry.items = items;
    changedCardsLocMap[cardNo] = [...new Set(items.map(it => it.loc))];

    if (items.length === 0) {
      delete inventory.cards[cardNo];
    }
  }

  updateUserLocationsSummary(inventory, changedCardsLocMap);
  return updatedItems;
}

function processDiscardCards(inventory, discards) {
  const { normalizeIllustrationId } = require('../services/inventoryMigrationService');
  if (!inventory.cards) inventory.cards = {};
  if (!inventory.locations) inventory.locations = {};
  if (!inventory.rarities) inventory.rarities = {};

  const updatedItems = [];
  const discardGroups = {};
  discards.forEach(d => {
    const cNo = String(d.cardNo).toUpperCase() || "NO_NUMBER";
    if (!discardGroups[cNo]) discardGroups[cNo] = [];
    discardGroups[cNo].push(d);
  });

  const changedCardsLocMap = {};

  for (const cardNo in discardGroups) {
    const cardEntry = inventory.cards[cardNo];
    if (!cardEntry) continue;

    let items = cardEntry.items || [];
    const cardName = cardEntry.name || "Unknown";

    discardGroups[cardNo].forEach(d => {
      const discardQ = parseInt(d.qty) || 0;
      if (discardQ <= 0) return;

      const dRare = d.rarity || d.proc || "";
      const dIllust = normalizeIllustrationId(d.illustration ?? d.another);
      const dLoc = d.loc || "";

      let matchIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const iRare = items[i].rarity || items[i].proc;
        const iIllust = items[i].illustration || items[i].another;
        if (iRare === dRare && items[i].loc === dLoc && iIllust === dIllust) {
          matchIdx = i; break;
        }
      }
      if (matchIdx === -1) return;

      let newQty = items[matchIdx].qty - discardQ;
      if (newQty < 0) newQty = 0;
      items[matchIdx].qty = newQty;

      inventory.amount -= discardQ;
      const rarityKey = items[matchIdx].rarity || items[matchIdx].proc;
      inventory.rarities[rarityKey] = (inventory.rarities[rarityKey] || 0) - discardQ;
      if (inventory.rarities[rarityKey] < 0) inventory.rarities[rarityKey] = 0;

      updatedItems.push({ cardNo, name: cardName, cid: cardEntry.cid || null, rarity: dRare, illustration: dIllust, loc: dLoc, qty: newQty, isDeleted: newQty === 0 });
    });

    items = items.filter(it => it.qty > 0);
    cardEntry.items = items;
    changedCardsLocMap[cardNo] = [...new Set(items.map(it => it.loc))];

    if (items.length === 0) {
      delete inventory.cards[cardNo];
    }
  }

  updateUserLocationsSummary(inventory, changedCardsLocMap);
  if (inventory.amount < 0) inventory.amount = 0;
  return updatedItems;
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
