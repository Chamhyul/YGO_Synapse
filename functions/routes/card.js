const cardService = require("../services/cardService");
const { onRequest } = require("firebase-functions/v2/https");
const { admin } = require("../config/firebase");
const { mapToRowArray } = require("../utils/common");
const { setCors, verifyUser, verifyAppCheck } = require("../utils/auth");
const { crawlByCardNo, crawlByCardName } = require("../scrapers/cardScraper");
const { getCardFromCacheByNo, getCardFromCacheByName, saveCardToFirestore, buildSearchResponse, resolveCardNumber } = require("../services/cardService");
const { updateInventoryWithRetry, processAddCards, processMoveCards, processDiscardCards } = require("../utils/inventoryStorage");
const { findCard, findCards, mapLimited } = require('../services/cardQueryService');
const { resolveGroupCids, inventoryMigrationStatus } = require('../services/inventoryMigrationService');
const { getCardManifest } = require('../utils/indexStorage');

async function handleSearchExecution(req, res, options) {
  const {
    paramKey,
    paramMissingMsg,
    errTypeMsg,
    cacheLookupFn,
    crawlFn,
    tag
  } = options;

  try {
    setCors(res, req);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (!(await verifyAppCheck(req, res))) return;

    const val = (req.query[paramKey] || "").trim();
    const queryVal = paramKey === "cardNo" ? val.toUpperCase() : val;
    if (!queryVal) return res.status(400).json({ isError: true, name: paramMissingMsg });

    try {
      const cached = await cacheLookupFn(queryVal);
      if (cached) {
        const response = buildSearchResponse(cached.cid, cached.info, true, { [paramKey]: queryVal });
        if (!res.headersSent) {
          res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
          return res.json(response);
        }
        return;
      }
    } catch (cacheErr) {
      throw cacheErr;
    }

    let result;
    try {
      result = await crawlFn(queryVal);
    } catch (crawlErr) {
      console.error(`[${tag}] Crawl Exception:`, crawlErr);
      if (!res.headersSent) {
        return res.json({ isError: true, name: errTypeMsg });
      }
      return;
    }

    if (!result || result.isError) {
      if (!res.headersSent) return res.json(result || { isError: true, name: errTypeMsg });
      return;
    }

    const saveResult = await saveCardToFirestore(result);

    const stored = await findCard({ cid: result.cid });
    const response = buildSearchResponse(result.cid, stored?.info || result.mergedInfo, false, { [paramKey]: queryVal });
    if (saveResult && saveResult.rarityChanged) {
      response.rarityMappingRaw = mapToRowArray(saveResult.updatedLangs);
    }
    if (!res.headersSent) return res.json(response);

  } catch (e) {
    console.error(`[${tag}] EXCEPTION:`, e);
    if (!res.headersSent) {
      return res.json({ isError: true, name: errTypeMsg });
    }
  }
}

exports.searchCardByNo = onRequest({ invoker: "public", memory: "512MiB", timeoutSeconds: 60 }, (req, res) => {
  return handleSearchExecution(req, res, {
    paramKey: "cardNo",
    paramMissingMsg: "번호 미입력",
    errTypeMsg: "번호 확인",
    cacheLookupFn: getCardFromCacheByNo,
    crawlFn: crawlByCardNo,
    tag: "searchCardByNo"
  });
});

exports.searchCardByName = onRequest({ invoker: "public", memory: "512MiB", timeoutSeconds: 60 }, (req, res) => {
  return handleSearchExecution(req, res, {
    paramKey: "name",
    paramMissingMsg: "이름 미입력",
    errTypeMsg: "이름 확인",
    cacheLookupFn: getCardFromCacheByName,
    crawlFn: crawlByCardName,
    tag: "searchCardByName"
  });
});

async function runBackgroundCrawlAndSave(query) {
  const queryUpper = query.toUpperCase();
  try {
    console.log(`[Crawl Background] Start crawl for: ${query}`);
    const [noRes, nameRes] = await Promise.allSettled([
      crawlByCardNo(queryUpper),
      crawlByCardName(query)
    ]);

    let successResult = null;
    if (noRes.status === 'fulfilled' && !noRes.value.isError && noRes.value.cid) {
      successResult = noRes.value;
    } else if (nameRes.status === 'fulfilled' && !nameRes.value.isError && nameRes.value.cid) {
      successResult = nameRes.value;
    }

    if (successResult) {
      await saveCardToFirestore(successResult);
      console.log(`[Crawl Background] Successfully crawled & saved: ${query}`);
    } else {
      console.log(`[Crawl Background] Crawl failed or not found for: ${query}`);
    }
  } catch (crawlErr) {
    console.error("[Crawl Background] Error in background crawl:", crawlErr);
  }
}

exports.searchCard = onRequest({ invoker: "public", memory: "512MiB" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const query = (req.query.query || "").trim();
  if (!query) return res.json({ success: true, names: [] });

  try {
    const card = await findCard({ name: query });
    if (card) return res.json({ success: true, cid: card.cid, names: card.data.names || [] });

    res.json({ success: true, names: [], isPendingCrawl: true });

    runBackgroundCrawlAndSave(query).catch(err => console.error("[searchCard] Background crawl unhandled error:", err));

  } catch (e) {
    console.error("searchCard error:", e);
    return res.status(500).json({ isError: true, name: "서버 오류" });
  }
});

exports.resolveCardNames = onRequest({ invoker: 'public', timeoutSeconds: 60 }, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (!(await verifyAppCheck(req, res))) return;
  const names = req.body?.names;
  if (!Array.isArray(names) || names.length > 40 || names.some(n => typeof n !== 'string' || n.length > 300)) {
    return res.status(400).json({ success: false, message: '이름은 최대 40개까지 조회할 수 있습니다.' });
  }
  try {
    const results = Object.fromEntries(await mapLimited([...new Set(names)], async name => {
      const cards = await findCards('names', name);
      return [name, cards.map(card => card.cid)];
    }));
    return res.json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, message: '카드 연결 정보를 조회하지 못했습니다.' });
  }
});

async function applyInventoryGuard(req, res, paramKey) {
  setCors(res, req);
  if (req.method === "OPTIONS") { res.status(204).send(""); return null; }
  const uid = await verifyUser(req, res);
  if (!uid) return null;
  const items = req.body[paramKey];
  if (!items || !Array.isArray(items)) {
    res.status(400).json({ success: false, message: `Bad Request: Missing ${paramKey}` });
    return null;
  }
  return { uid, items };
}

exports.addCards = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "rows");
  if (!guard) return;
  const { uid, items: rows } = guard;

  try {
    const cardGroups = {};
    
    for (const entry of rows) {
      const eName = entry[0];
      const eRawNo = String(entry[1]).toUpperCase() || "NO_NUMBER";
      const eNo = await resolveCardNumber(eRawNo, eName);
      const eRarity = entry[2];
      const eQty = parseInt(entry[3]) || 0;
      const eLoc = entry[4];
      const eIllust = entry[5] || "";

      if(eQty <= 0) continue;
      if (!cardGroups[eNo]) cardGroups[eNo] = { name: eName, requestedCid: entry[6], items: [] };
      cardGroups[eNo].items.push({ rarity: eRarity, loc: eLoc, qty: eQty, illustration: eIllust });
    }

    await resolveGroupCids(cardGroups);
    let updatedItems = [];
    const finalData = await updateInventoryWithRetry(uid, (inventory) => {
      updatedItems = processAddCards(inventory, cardGroups);
    });

    return res.json({
      success: true,
      updatedItems,
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

exports.moveCards = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "moves");
  if (!guard) return;
  const { uid, items: moves } = guard;

  try {
    let updatedItems = [];
    const finalData = await updateInventoryWithRetry(uid, (inventory) => {
      updatedItems = processMoveCards(inventory, moves);
    });

    return res.json({
      success: true,
      updatedItems,
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

exports.discardCards = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  const guard = await applyInventoryGuard(req, res, "discards");
  if (!guard) return;
  const { uid, items: discards } = guard;

  try {
    let updatedItems = [];
    const finalData = await updateInventoryWithRetry(uid, (inventory) => {
      updatedItems = processDiscardCards(inventory, discards);
    });

    return res.json({
      success: true,
      updatedItems,
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

exports.suggestCardNames = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const query = (req.query.q || "").trim();
  if (!query) return res.json({ success: true, results: [] });

  try {
    // [Storage 전환] 인메모리 캐시에서 접두사 필터링
    const allNames = (await getCardManifest()).names;
    const results = allNames
      .filter(name => name.startsWith(query))
      .sort()
      .slice(0, 8);
    return res.json({ success: true, results });
  } catch (e) {
    console.error("suggestCardNames error:", e);
    return res.status(500).json({ success: false, results: [] });
  }
});

/**
 * [공통] 전체 카드 이름과 카드 번호 목록을 Storage에 JSON 파일로 동기화 (재빌드)
 * 카드 원본에서 목록을 재생성합니다. 기존 경로는 관리자 전용 별칭입니다.
 */


exports.getCardMetadata = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 60 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  // warmup=true: 초기 로딩 시 컨테이너를 사전 부팅(Hot-Start)시키기 위한 선제 핑 — 즉시 반환
  if (req.query.warmup === 'true') {
    return res.json({ success: true, message: "warmed up" });
  }

  const cid = (req.query.cid || req.body?.cid || "").trim();
  const name = (req.query.name || req.body?.name || "").trim();
  const cardNo = (req.query.cardNo || req.body?.cardNo || "").trim();
  const langOnly = req.query.langOnly === 'true' || req.body?.langOnly === true;

  if (!cid && !name && !cardNo) {
    return res.status(400).json({ success: false, message: "CID, 이름 또는 카드 번호 미입력" });
  }

  try {
    const result = await cardService.getCardMetadata(cid, name, cardNo, langOnly);
    if (result && result.success) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    }
    return res.json(result);
  } catch (e) {
    console.error("getCardMetadata error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.getCardsMetaBatch = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 60 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const cids = req.body?.cids || (req.query.cids ? String(req.query.cids).split(',') : []);

  try {
    const result = await cardService.getCardsMetaBatch(cids);
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.json(result);
  } catch (e) {
    console.error("getCardsMetaBatch error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

// 크롤링 전용 독립 Cloud Function (메모리 100% 분리 격리)
exports.crawlCardMetaByName = onRequest({ invoker: "public", memory: "512MiB" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const name = (req.query.name || req.body?.name || "").trim();
  if (!name) return res.status(400).json({ isError: true, message: "카드 이름 미입력" });

  try {
    const crawlRes = await crawlByCardName(name);
    if (crawlRes && !crawlRes.isError) {
      await saveCardToFirestore(crawlRes);
      return res.json({ success: true, ...crawlRes });
    }
    return res.status(404).json({ isError: true, message: "크롤링 실패" });
  } catch (e) {
    console.error("crawlCardMetaByName error:", e);
    return res.status(500).json({ isError: true, message: e.toString() });
  }
});

exports.getRamMemoryStats = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;
  const stats = await cardService.getRamMemoryStats();
  return res.json(stats);
});
