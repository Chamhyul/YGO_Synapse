const { onRequest: firebaseOnRequest } = require("firebase-functions/v2/https");
const { withPublicReadRequest } = require("../services/publicReadTransport");
const onRequest = (options, handler) => firebaseOnRequest(options, withPublicReadRequest(handler));
const { setCors, verifyRegisteredUser } = require("../utils/auth");
const { migrationFetchPublicMyCardData, validateImportData } = require("../services/migrationService");
const { sheetsIsValidSpreadsheetId } = require('../integrations/googleSheets');
const { resolveCardNumber } = require("../services/cardService");
const { updateInventoryWithRetry, processAddCards } = require("../utils/inventoryStorage");
const { findCard } = require('../services/cardQueryService');
const { resolveGroupCids, inventoryMigrationStatus, normalizeIllustrationId } = require('../services/inventoryMigrationService');

/**
 * [공통] 마이그레이션 대상 데이터에서 구버전 일판 카드를 파악하고 캐시맵을 빌드
 * 카드 원본 DB와 조회 캐시 사용
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
    // 카드 원본에서 번호로 조회

    for (const cardNo of jpCardNos) {
      const card = await findCard({ number: cardNo });
      const entry = card && require('../services/cardService').buildSearchResponse(card.cid, card.info, true, { cardNo });
      if (entry) {
        cacheMap[cardNo] = { exists: true, name: entry.name };
      } else {
        cacheMap[cardNo] = { exists: false, name: null };
      }
    }
  }
  return cacheMap;
}

const { safeErrorSummary } = require('../utils/safeError');

async function importValidated(uid, parsed) {
  const cacheMap = await buildJpCardCache(parsed.data, item => item.no);
  const cardGroups = Object.create(null);
  for (const item of parsed.data) {
    const cardNo = await resolveCardNumber(item.no, item.name, cacheMap);
    if (!cardNo) throw Object.assign(new Error('카드 번호를 확인할 수 없습니다.'), { code: 'INVALID_IMPORT' });
    if (!cardGroups[cardNo]) cardGroups[cardNo] = { name: item.name, items: [] };
    cardGroups[cardNo].items.push({ rarity: item.rare, loc: item.loc, qty: item.qty,
      illustration: normalizeIllustrationId(item.illust) });
  }
  await resolveGroupCids(cardGroups);
  // 추가량은 Storage 충돌 재시도 및 기존 보유 수량과 독립적으로 한 번만 집계한다.
  const deltas = new Map(), kinds = new Set();
  for (const [cardNo, group] of Object.entries(cardGroups)) {
    kinds.add(group.cid ? `cid:${group.cid}` : `name:${group.name}`);
    for (const item of group.items) {
      const key = JSON.stringify([cardNo, item.rarity, item.loc, item.illustration]);
      if (!deltas.has(key)) deltas.set(key, { cardNo, name: group.name, cid: group.cid || null, ...item, qty: 0 });
      deltas.get(key).qty += item.qty;
    }
  }
  const importedItems = [...deltas.values()];
  let updatedItems = [];
  const finalData = await updateInventoryWithRetry(uid, inventory => {
    if (!Number.isSafeInteger((inventory.amount || 0) + parsed.totalQty)) {
      throw Object.assign(new Error('보유 총수량이 지원 범위를 초과했습니다.'), { code: 'INVALID_IMPORT' });
    }
    for (const item of importedItems) {
      const existing = inventory.cards[item.cardNo]?.items.find(entry => entry.rarity === item.rarity
        && entry.loc === item.loc && normalizeIllustrationId(entry.illustration) === item.illustration);
      if (existing && !Number.isSafeInteger(existing.qty + item.qty)) {
        throw Object.assign(new Error('보유 항목의 수량이 지원 범위를 초과했습니다.'), { code: 'INVALID_IMPORT' });
      }
    }
    updatedItems = processAddCards(inventory, cardGroups);
  });
  return { success: true, importedCount: parsed.data.length, importedCardCount: kinds.size,
    importedQty: parsed.totalQty, importedItems, updatedItems,
    skippedZeroCount: parsed.skippedZeroCount, legacyQuantity: parsed.legacyQuantity,
    inventoryVersion: finalData.version, inventoryMigration: inventoryMigrationStatus(finalData) };
}

function importRoute(source) {
  return onRequest({ invoker: 'public' }, async (req, res) => {
    setCors(res, req);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청만 지원합니다.' });
    const uid = await verifyRegisteredUser(req, res);
    if (!uid) return;
    try {
      let parsed;
      if (source === 'sheet') {
        const { spreadsheetId, fingerprint } = req.body || {};
        if (!sheetsIsValidSpreadsheetId(spreadsheetId)) {
          return res.status(400).json({ success: false, message: '올바른 시트 ID가 필요합니다.' });
        }
        parsed = await migrationFetchPublicMyCardData(spreadsheetId);
        if (!fingerprint || fingerprint !== parsed.fingerprint) {
          return res.status(409).json({ success: false, message: '시트 내용이 변경되었습니다. 링크를 다시 확인해주세요.', code: 'SHEET_CHANGED' });
        }
      } else parsed = validateImportData(req.body?.data);
      return res.json(await importValidated(uid, parsed));
    } catch (error) {
      console.error('Data import failed:', safeErrorSummary(error));
      if (error.code === 'PUBLIC_SHEET_NO_ACCESS') return res.status(403).json({ success: false,
        code: 'PUBLIC_SHEET_NO_ACCESS', message: '공개·링크 공유 및 다운로드 허용 설정을 확인해 주세요.' });
      if (error.code === 'PUBLIC_SHEET_UNAVAILABLE') return res.status(503).json({ success: false,
        message: '시트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return res.status(error.code === 'INVALID_IMPORT' ? 400 : 500).json({ success: false,
        message: error.code === 'INVALID_IMPORT' ? error.message : '카드 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }
  });
}
exports.migrateFromSheet = importRoute('sheet');
exports.migrateFromData = importRoute('file');
