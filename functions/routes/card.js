const { refreshCardManifest } = require("../services/cardIndexService");
const cardService = require("../services/cardService");
const { onRequest } = require("firebase-functions/v2/https");
const { admin } = require("../config/firebase");
const { mapToRowArray } = require("../utils/common");
const { setCors, verifyUser, verifyAppCheck } = require("../utils/auth");
const { crawlByCardNo, crawlByCardName } = require("../scrapers/cardScraper");
const { getCardFromCacheByNo, getCardFromCacheByName, saveCardToFirestore, buildSearchResponse, buildSearchResponseFromIndexByNo, buildSearchResponseFromIndexByName, resolveCardNumber, normalizeNameForDocId } = require("../services/cardService");
const { updateInventoryWithRetry, processAddCards, processMoveCards, processDiscardCards } = require("../utils/inventoryStorage");
const { getIdxByName, getIdxByNumber, getIdxCid } = require("../utils/indexStorage");

async function handleSearchExecution(req, res, options) {
  const {
    paramKey,
    paramMissingMsg,
    errTypeMsg,
    cacheLookupFn,
    indexResponseFn,
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
        let response;
        if (cached.fromIndex) {
          response = await indexResponseFn(queryVal, cached.indexData);
        } else {
          response = buildSearchResponse(cached.cid, cached.info, true);
        }
        if (!res.headersSent) {
          res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
          return res.json(response);
        }
        return;
      }
    } catch (cacheErr) {
      console.warn(`[${tag}] Cache lookup warning:`, cacheErr.message || cacheErr);
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

    const response = buildSearchResponse(result.cid, result.mergedInfo, false);
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

exports.searchCardByNo = onRequest({ invoker: "public", memory: "1GiB", timeoutSeconds: 60 }, (req, res) => {
  return handleSearchExecution(req, res, {
    paramKey: "cardNo",
    paramMissingMsg: "번호 미입력",
    errTypeMsg: "번호 확인",
    cacheLookupFn: getCardFromCacheByNo,
    indexResponseFn: (queryVal, indexData) => buildSearchResponseFromIndexByNo(queryVal, indexData),
    crawlFn: crawlByCardNo,
    tag: "searchCardByNo"
  });
});

exports.searchCardByName = onRequest({ invoker: "public", memory: "1GiB", timeoutSeconds: 60 }, (req, res) => {
  return handleSearchExecution(req, res, {
    paramKey: "name",
    paramMissingMsg: "이름 미입력",
    errTypeMsg: "이름 확인",
    cacheLookupFn: getCardFromCacheByName,
    indexResponseFn: (queryVal, indexData) => {
      const response = buildSearchResponseFromIndexByName(indexData);
      response.name = queryVal;
      return response;
    },
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

exports.searchCard = onRequest({ invoker: "public", memory: "1GiB" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const query = (req.query.query || "").trim();
  if (!query) return res.json({ success: true, names: [] });

  try {
    // [Storage 전환] 인메모리 캐시에서 조회
    const docId = normalizeNameForDocId(query);
    const idxByName = await getIdxByName();
    const nameEntry = idxByName[docId];

    if (nameEntry) {
      const cid = nameEntry.cid;
      const idxCid = await getIdxCid();
      const cidEntry = idxCid[cid];
      const names = cidEntry ? (cidEntry.names || []) : [];
      return res.json({ success: true, names });
    }

    res.json({ success: true, names: [], isPendingCrawl: true });

    runBackgroundCrawlAndSave(query).catch(err => console.error("[searchCard] Background crawl unhandled error:", err));

  } catch (e) {
    console.error("searchCard error:", e);
    return res.status(500).json({ isError: true, name: "서버 오류" });
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

exports.addCards = onRequest({ invoker: "public", memory: "512MiB" }, async (req, res) => {
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
      if (!cardGroups[eNo]) cardGroups[eNo] = { name: eName, items: [] };
      cardGroups[eNo].items.push({ rarity: eRarity, loc: eLoc, qty: eQty, illustration: eIllust });
    }

    let updatedItems = [];
    const finalData = await updateInventoryWithRetry(uid, (inventory) => {
      updatedItems = processAddCards(inventory, cardGroups);
    });

    return res.json({
      success: true,
      updatedItems,
      amount: finalData.amount,
      locations: finalData.locations,
      rarities: finalData.rarities
    });
  } catch (e) {
    console.error("addCards error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.moveCards = onRequest({ invoker: "public", memory: "512MiB" }, async (req, res) => {
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
      amount: finalData.amount,
      locations: finalData.locations,
      rarities: finalData.rarities
    });
  } catch (e) {
    console.error("moveCards error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.discardCards = onRequest({ invoker: "public", memory: "512MiB" }, async (req, res) => {
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
    const idxByName = await getIdxByName();
    const allNames = Object.keys(idxByName).filter(name => !name.startsWith("##"));
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
 * [Storage 전환] Firestore 전체 스캔 대신 캐시된 인덱스에서 직접 키 추출
 */
exports.syncCardManifestToStorage = onRequest({ invoker: "public", memory: "1GiB", timeoutSeconds: 300 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  if (!(await verifyAppCheck(req, res))) return;

  try {
    const result = await refreshCardManifest();
    return res.status(result.busy ? 409 : 200).json(result);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.toString() });
  }
});



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
exports.crawlCardMetaByName = onRequest({ invoker: "public", memory: "1GiB" }, async (req, res) => {
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
