const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyUser } = require("../utils/auth");
const { fetchMyCardData_Node } = require("../services/migrationService");
const { resolveCardNumber } = require("../services/cardService");
const { downloadInventory, uploadInventory } = require("../utils/inventoryStorage");
const { getIdxByNumber } = require("../utils/indexStorage");

/**
 * [공통] 마이그레이션 대상 데이터에서 구버전 일판 카드를 파악하고 캐시맵을 빌드
 * [Storage 전환] Firestore idx_byNumber 대신 인메모리 캐시 사용
 */
async function buildJpCardCache(items, noExtractor) {
  const jpCardNos = [];
  for (const item of items) {
    const rawNo = noExtractor(item);
    if (rawNo) {
      const upperNo = String(rawNo).toUpperCase().trim();
      if (upperNo.startsWith("DP15-JP") || upperNo.startsWith("20AP-JP")) {
        if (!jpCardNos.includes(upperNo)) {
          jpCardNos.push(upperNo);
        }
      }
    }
  }

  const cacheMap = {};
  if (jpCardNos.length > 0) {
    // [Storage 전환] idx_byNumber 캐시에서 조회
    const idxByNumber = await getIdxByNumber();
    for (const cardNo of jpCardNos) {
      const entry = idxByNumber[cardNo];
      if (entry) {
        cacheMap[cardNo] = { exists: true, name: entry.name };
      } else {
        cacheMap[cardNo] = { exists: false, name: null };
      }
    }
  }
  return cacheMap;
}

exports.migrateFromSheet = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  
  const uid = await verifyUser(req, res);
  if (!uid) return;

  const { spreadsheetId } = req.body;
  if (!spreadsheetId) return res.status(400).json({ success: false, message: "Missing spreadsheetId" });

  try {
    const sheetData = await fetchMyCardData_Node(spreadsheetId);
    if (sheetData.allCards.length === 0) {
      return res.json({ success: true, message: "이전할 데이터가 없습니다.", importedCount: 0 });
    }

    const cacheMap = await buildJpCardCache(sheetData.allCards, row => row[1]);

    const cardGroups = {};
    for (const row of sheetData.allCards) {
      const [name, rawNo, rarity, qty, loc, illustration] = row;
      const cardNo = await resolveCardNumber(rawNo, name, cacheMap);
      if (!cardGroups[cardNo]) cardGroups[cardNo] = { name, items: [] };
      cardGroups[cardNo].items.push({ rarity, loc, qty, illustration });
    }

    // [Storage 전환] Firestore 배치 쳀크 조회/쓰기 → Storage 인벤토리 다운로드/머지/업로드
    const { data: inventory } = await downloadInventory(uid);
    if (!inventory.cards) inventory.cards = {};
    if (!inventory.locations) inventory.locations = {};
    if (!inventory.rarities) inventory.rarities = {};
    if (typeof inventory.amount !== 'number') inventory.amount = 0;

    const updatedItems = [];

    for (const cardNo in cardGroups) {
      const group = cardGroups[cardNo];
      if (!inventory.cards[cardNo]) {
        inventory.cards[cardNo] = { name: group.name, items: [] };
      }
      const cardEntry = inventory.cards[cardNo];
      const cardName = group.name || cardEntry.name || "Unknown";
      cardEntry.name = cardName;

      group.items.forEach(incoming => {
        let matchIndex = cardEntry.items.findIndex(item =>
          (item.rarity || item.proc) === incoming.rarity &&
          item.loc === incoming.loc &&
          (item.illustration || item.another) === incoming.illustration
        );

        if (matchIndex > -1) {
          cardEntry.items[matchIndex].qty += incoming.qty;
        } else {
          cardEntry.items.push(incoming);
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
          rarity: incoming.rarity,
          qty: incoming.qty,
          loc: incoming.loc,
          illustration: incoming.illustration
        });
      });
    }

    await uploadInventory(uid, inventory);

    return res.json({
      success: true,
      message: `${sheetData.allCards.length}개의 카드 데이터 이관 완료`,
      importedCount: sheetData.allCards.length,
      updatedItems
    });

  } catch (e) {
    console.error("migrateFromSheet error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.migrateFromData = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  
  const uid = await verifyUser(req, res);
  if (!uid) return;

  const { data } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ success: false, message: "Missing or invalid data" });
  }

  try {
    const cacheMap = await buildJpCardCache(data, item => item.no);

    const cardGroups = {};
    for (const item of data) {
      const rawNo = String(item.no || "").trim().toUpperCase();
      const name = String(item.name || "").trim();
      const cardNo = await resolveCardNumber(rawNo, name, cacheMap);
      const rarity = String(item.rare || "기본").trim();
      const loc = String(item.loc || "미보관").trim();
      const illustration = String(item.illust || "").trim();
      const qty = 1;

      if (!cardNo) continue;
      if (!cardGroups[cardNo]) cardGroups[cardNo] = { name, items: [] };
      cardGroups[cardNo].items.push({ rarity, loc, qty, illustration });
    }

    // [Storage 전환] Firestore 배치 쳀크 조회/쓰기 → Storage 인벤토리 다운로드/머지/업로드
    const { data: inventory } = await downloadInventory(uid);
    if (!inventory.cards) inventory.cards = {};
    if (!inventory.locations) inventory.locations = {};
    if (!inventory.rarities) inventory.rarities = {};
    if (typeof inventory.amount !== 'number') inventory.amount = 0;

    const updatedItems = [];

    for (const cardNo in cardGroups) {
      const group = cardGroups[cardNo];
      if (!inventory.cards[cardNo]) {
        inventory.cards[cardNo] = { name: group.name, items: [] };
      }
      const cardEntry = inventory.cards[cardNo];
      const cardName = group.name || cardEntry.name || "Unknown";
      cardEntry.name = cardName;

      group.items.forEach(incoming => {
        let matchIndex = cardEntry.items.findIndex(item =>
          (item.rarity || item.proc) === incoming.rarity &&
          item.loc === incoming.loc &&
          (item.illustration || item.another) === incoming.illustration
        );

        if (matchIndex > -1) {
          cardEntry.items[matchIndex].qty += incoming.qty;
        } else {
          cardEntry.items.push(incoming);
        }

        inventory.amount += incoming.qty;
        inventory.rarities[incoming.rarity] = (inventory.rarities[incoming.rarity] || 0) + incoming.qty;

        if (!inventory.locations[incoming.loc]) inventory.locations[incoming.loc] = [];
        if (!inventory.locations[incoming.loc].includes(cardNo)) {
          inventory.locations[incoming.loc].push(cardNo);
        }

        updatedItems.push({ cardNo, name: cardName, rarity: incoming.rarity, qty: incoming.qty, loc: incoming.loc, illustration: incoming.illustration });
      });
    }

    await uploadInventory(uid, inventory);

    return res.json({ success: true, message: `${data.length}개의 데이터 이관 완료`, importedCount: data.length, updatedItems });

  } catch (e) {
    console.error("migrateFromData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});
