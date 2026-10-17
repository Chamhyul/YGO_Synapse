const { onRequest: firebaseOnRequest } = require("firebase-functions/v2/https");
const { withPublicReadRequest } = require("../services/publicReadTransport");
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const { measure, withInventoryRequestTiming } = require('../services/inventoryRequestTiming');
const onRequest = (operation, options, handler) => firebaseOnRequest(options, withInventoryRequestTiming(operation, withUserStorageRequestGuard(withPublicReadRequest(handler))));
const { setCors, verifyRegisteredUser } = require("../utils/auth");
const { resolveCardNumber } = require("../services/inventoryCardLookup");
const { updateInventoryWithRetry, processAddCards, processMoveCards, processDiscardCards } = require("../utils/inventoryStorage");
const { resolveGroupCids, inventoryMigrationStatus } = require("../services/inventoryMigrationService");

async function applyInventoryGuard(req, res, paramKey) {
  setCors(res, req);
  if (req.method === "OPTIONS") { res.status(204).send(""); return null; }
  const uid = await verifyRegisteredUser(req, res);
  if (!uid) return null;
  const items = req.body[paramKey];
  if (!items || !Array.isArray(items)) {
    res.status(400).json({ success: false, message: `Bad Request: Missing ${paramKey}` });
    return null;
  }
  return { uid, items };
}

exports.addCards = onRequest('addCards', { invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "rows");
  if (!guard) return;
  const { uid, items: rows } = guard;

  try {
    const cardGroups = {};
    const invalidResults = [];
    
    for (const [requestIndex, entry] of rows.entries()) {
      const eQty = Number(entry[3]);
      if (!Number.isSafeInteger(eQty) || eQty <= 0) {
        invalidResults.push({ requestIndex, status: 'fail', qty: 0, failReason: 'invalid_qty' });
        continue;
      }
      const eName = entry[0];
      const eRawNo = String(entry[1]).toUpperCase() || "NO_NUMBER";
      const eNo = await measure('card.resolve_number', () => resolveCardNumber(eRawNo, eName));
      const eRarity = entry[2];
      const eLoc = entry[4];
      const eIllust = entry[5] || "";

      // 수량 오류도 입력 인덱스를 보존하여 결과에 돌려준다.
      if (!cardGroups[eNo]) cardGroups[eNo] = { name: eName, requestedCid: entry[6], items: [] };
      cardGroups[eNo].items.push({ rarity: eRarity, loc: eLoc, qty: eQty, illustration: eIllust, requestIndex });
    }

    await measure('card.resolve_cids', () => resolveGroupCids(cardGroups));
    // 기존 API가 허용한 비표준 입력은 전체 호환 경로로 보낸다. 저장 요약의
    // 문자열 조건을 새 HTTP 검증 규칙으로 만들거나 변경 후 재실행하지 않는다.
    const partialCompatible = Object.values(cardGroups).every(group => group.items.every(item =>
      typeof item.rarity === 'string' && item.rarity.length > 0 && typeof item.loc === 'string'));
    let updatedItems = [], operationResults = [];
    const finalData = await measure('inventory.update', () => updateInventoryWithRetry(uid, (inventory) => {
      // generation 충돌 재시도에서는 마지막 저장 시도의 결과만 응답한다.
      operationResults = invalidResults.map(item => ({ ...item }));
      updatedItems = processAddCards(inventory, cardGroups, operationResults);
    }, 3, { cardNumbers: partialCompatible ? Object.keys(cardGroups) : undefined }));

    return res.json({
      success: true,
      updatedItems,
      operationResults,
      inventoryVersion: finalData.version,
      inventoryMigration: inventoryMigrationStatus(finalData),
      amount: finalData.amount,
      locations: finalData.locations,
      rarities: finalData.rarities
    });
  } catch (e) {
    console.error("addCards error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.moveCards = onRequest('moveCards', { invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "moves");
  if (!guard) return;
  const { uid, items: moves } = guard;

  try {
    let updatedItems = [], operationResults = [];
    const finalData = await measure('inventory.update', () => updateInventoryWithRetry(uid, (inventory) => {
      // generation 충돌 재시도에서는 마지막 저장 시도의 결과만 응답한다.
      operationResults = [];
      updatedItems = processMoveCards(inventory, moves, operationResults);
    }, 3, { cardNumbers: moves.every(item => ['rarity', 'proc', 'loc', 'currentLoc', 'targetLoc']
      .every(key => item[key] === undefined || typeof item[key] === 'string'))
      ? moves.map(item => String(item.cardNo || '').trim().toUpperCase()) : undefined }));

    return res.json({
      success: true,
      updatedItems,
      operationResults,
      inventoryVersion: finalData.version,
      inventoryMigration: inventoryMigrationStatus(finalData),
      amount: finalData.amount,
      locations: finalData.locations,
      rarities: finalData.rarities
    });
  } catch (e) {
    console.error("moveCards error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.discardCards = onRequest('discardCards', { invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "discards");
  if (!guard) return;
  const { uid, items: discards } = guard;

  try {
    let updatedItems = [], operationResults = [];
    const finalData = await measure('inventory.update', () => updateInventoryWithRetry(uid, (inventory) => {
      // generation 충돌 재시도에서는 마지막 저장 시도의 결과만 응답한다.
      operationResults = [];
      updatedItems = processDiscardCards(inventory, discards, operationResults);
    }, 3, { cardNumbers: discards.every(item => ['rarity', 'proc', 'loc']
      .every(key => item[key] === undefined || typeof item[key] === 'string'))
      ? discards.map(item => String(item.cardNo || '').trim().toUpperCase()) : undefined }));

    return res.json({
      success: true,
      updatedItems,
      operationResults,
      inventoryVersion: finalData.version,
      inventoryMigration: inventoryMigrationStatus(finalData),
      amount: finalData.amount,
      locations: finalData.locations,
      rarities: finalData.rarities
    });
  } catch (e) {
    console.error("discardCards error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

