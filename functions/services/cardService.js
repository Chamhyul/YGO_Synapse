/**
 * 카드 info / mergedInfo의 위치별 의미 (Firestore에서는 숫자 문자열 키의 Map으로 저장):
 * 0~9: ko, ja, ae, cn, en, de, fr, it, es, pt 순서의 언어별 정보.
 *   각 언어 배열: [카드명, ciid 배열, 번호별 레어도 정보, 일반 효과, 펜듈럼 효과].
 *   번호별 레어도 정보: { 카드번호: [팩 이름, 레어도1, 레어도2, ...] }.
 * 10: 카드 종류 (0 몬스터, 1 마법, 2 함정).
 * 11: 세부 분류 배열 (ETCs 목록의 인덱스; 마법/함정 분류는 15부터).
 * 12: 레벨 / 랭크 / 링크 수치.
 * 13: 속성 (ATTRIBUTEs 목록의 인덱스), 14: 종족 (TYPEs 목록의 인덱스).
 * 15: 공격력, 16: 수비력 ('?'는 -1), 17: 펜듈럼 스케일.
 * 미수집 항목은 null 또는 키 부재로 표현하며, 배열 순서는 클라이언트와 공유합니다.
 */
const { requestCardIndexWork } = require('./cardIndexDispatchService');
const { db, admin, getBucket, FieldValue } = require("../config/firebase");
const { findCard, getCardByCid, getCardsByCids, documents: cardDocuments, invalidateCardQueries } = require('./cardQueryService');
const { updateRarityMemoryCache, normalizeText } = require("../utils/common");
const { saveCardAndQueueIndex } = require("./cardWriteService");
const { crawlByCardName } = require("../scrapers/cardScraper");

// 이름·번호 검색과 상세 조회는 동일한 원본 문서 캐시를 사용합니다.
const getCardFromCacheByNo = cardNo => findCard({ number: cardNo });
const getCardFromCacheByName = name => findCard({ name });

function getParen(str) {
  if (!str) return null;
  const match = String(str).match(/\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

// 레어도 매핑 동적 업데이트 로직
async function updateRarityMapping(newRarities) {
  if (!newRarities || !Array.isArray(newRarities)) return;

  const bucket = getBucket();
  const file = bucket.file("public/rarityMapping.json");
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let generation = 0;
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      // 파일 부재만 최초 생성으로 취급합니다. 권한·네트워크 오류는 전파합니다.
      if (Number(error.code) !== 404) throw error;
    }

    let langs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), []]));
    if (metadata) {
      generation = metadata.generation;
      let content;
      try {
        // 읽는 내용과 저장 조건에 사용하는 파일 버전을 일치시킵니다.
        [content] = await bucket.file(file.name, { generation }).download();
      } catch (error) {
        // 메타정보 조회 직후 다른 요청이 교체한 경우 최신 버전부터 다시 읽습니다.
        if (Number(error.code) === 404 && attempt < MAX_RETRIES) continue;
        throw error;
      }
      const existingData = JSON.parse(content.toString("utf-8"));
      if (!existingData || !existingData.langs || Array.isArray(existingData.langs) ||
          typeof existingData.langs !== 'object' || !Array.isArray(existingData.langs["10"])) {
        throw new Error('레어도 파일 형식이 잘못되었습니다. 기존 파일을 보존합니다.');
      }
      for (let i = 0; i <= 10; i++) {
        const values = existingData.langs[String(i)];
        if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string'))) {
          throw new Error(`레어도 언어 ${i}의 형식이 잘못되었습니다. 기존 파일을 보존합니다.`);
        }
        langs[String(i)] = values || [];
      }
    }

    const localeToIndex = { 'ko': 0, 'ja': 1, 'ae': 2, 'cn': 3, 'en': 4, 'de': 5, 'fr': 6, 'it': 7, 'es': 8, 'pt': 9 };
    let changed = false;

    for (const r of newRarities) {
      const locIdx = localeToIndex[r.locale];
      if (locIdx === undefined) continue;
      const display = r.display || "Unknown";
      const key = r.key || "Unknown";

      const candidates = [];
      const displayArr = langs["10"] || [];
      for (let i = 0; i < displayArr.length; i++) {
        if (displayArr[i] === display) candidates.push(i);
      }

      if (candidates.length === 0) {
        // 신규 행 생성
        for (let k = 0; k <= 10; k++) {
          langs[String(k)].push("");
        }
        const newIdx = langs["10"].length - 1;
        langs[String(locIdx)][newIdx] = key;
        langs["10"][newIdx] = display;
        changed = true;
      } else if (candidates.length === 1) {
        const id = candidates[0];
        if (!langs[String(locIdx)][id]) {
          langs[String(locIdx)][id] = key;
          changed = true;
        }
      } else {
        // 복수 후보: 괄호 매칭
        const targetParen = getParen(key);
        let bestMatch = -1;
        for (const id of candidates) {
          let matched = false;
          for (let l = 0; l < 10; l++) {
            const exV = langs[String(l)][id];
            if (!exV) continue;
            const exParen = getParen(exV);
            if (targetParen === null && exParen === null) { matched = true; break; }
            if (targetParen !== null && exParen === targetParen) { matched = true; break; }
          }
          if (matched) { bestMatch = id; break; }
        }

        if (bestMatch !== -1) {
          if (!langs[String(locIdx)][bestMatch]) {
            langs[String(locIdx)][bestMatch] = key;
            changed = true;
          }
        } else {
          // 매칭 실패 시 신규 행 생성
          for (let k = 0; k <= 10; k++) {
            langs[String(k)].push("");
          }
          const newIdx = langs["10"].length - 1;
          langs[String(locIdx)][newIdx] = key;
          langs["10"][newIdx] = display;
          changed = true;
        }
      }
    }

    if (changed) {
      const payload = { langs, updatedAt: Date.now() };
      try {
        await file.save(JSON.stringify(payload, null, 2), {
          resumable: false,
          contentType: "application/json",
          public: true,
          metadata: { cacheControl: "public, max-age=3600" },
          preconditionOpts: { ifGenerationMatch: generation }
        });
      } catch (error) {
        // 충돌 시 같은 내용을 덮어쓰지 않고 최신 파일에 변경분을 다시 병합합니다.
        if (Number(error.code) === 412 && attempt < MAX_RETRIES) continue;
        throw error;
      }
      updateRarityMemoryCache(payload);
    }

    return { changed, langs };
  }
}

/**
 * 크롤링 원본과 인덱스 반영 대기 기록을 함께 저장
 */
async function saveCardToFirestore(result, { deferIndexFlush = false } = {}) {
  if (!result || !result.cid || result.isError) return;

  // 크롤링 데이터 내 JP -> KR 번호 자동 보정 로직
  if (result.mergedInfo && result.mergedInfo[0] && result.mergedInfo[0][0]) {
    const patterns = [
      { old: "DP15-JP", new: "DP15-KR" },
      { old: "20AP-JP", new: "20AP-KR" }
    ];
    
    let hasChanged = false;

    // 1. result.numbers 업데이트
    if (result.numbers && Array.isArray(result.numbers)) {
      result.numbers = result.numbers.map(no => {
        const upperNo = no.toUpperCase();
        for (const p of patterns) {
          if (upperNo.startsWith(p.old)) {
            hasChanged = true;
            return upperNo.replace(p.old, p.new);
          }
        }
        return no;
      });
      if (hasChanged) {
        result.numbers = [...new Set(result.numbers)];
      }
    }

    // 2. result.newRarities 순회 및 업데이트
    if (result.newRarities && Array.isArray(result.newRarities)) {
      result.newRarities.forEach(r => {
        if (!r.no) return;
        const upperNo = r.no.toUpperCase();
        for (const p of patterns) {
          if (upperNo.startsWith(p.old)) {
            r.no = upperNo.replace(p.old, p.new);
            hasChanged = true;
          }
        }
      });
    }

    // 3. result.mergedInfo 의 raritiesByNo 객체 키 업데이트
    for (let i = 0; i < 10; i++) {
        if (result.mergedInfo[i] && result.mergedInfo[i][2]) {
            const raritiesByNo = result.mergedInfo[i][2];
            const newRaritiesByNo = {};
            for (const no in raritiesByNo) {
                let updatedNo = no;
                const upperNo = no.toUpperCase();
                for (const p of patterns) {
                    if (upperNo.startsWith(p.old)) {
                        updatedNo = upperNo.replace(p.old, p.new);
                        hasChanged = true;
                    }
                }
                newRaritiesByNo[updatedNo] = raritiesByNo[no];
            }
            result.mergedInfo[i][2] = newRaritiesByNo;
        }
    }
    
    if (result.cardNo) {
        let upperNo = result.cardNo.toUpperCase();
        for (const p of patterns) {
            if (upperNo.startsWith(p.old)) {
                result.cardNo = upperNo.replace(p.old, p.new);
            }
        }
    }
  }

  const cid = result.cid;

  // names 배열: 검색에 사용할 모든 언어 이름 추출
  const names = [];
  if (result.mergedInfo) {
    for (let i = 0; i < 10; i++) {
      if (result.mergedInfo[i] && result.mergedInfo[i][0]) {
        const nm = normalizeText(result.mergedInfo[i][0]);
        if (!names.includes(nm)) names.push(nm);
      }
    }
  }

  // 상위 Array를 Map(Object)으로 변환하여 저장
  const infoMap = {};
  if (result.mergedInfo && Array.isArray(result.mergedInfo)) {
    result.mergedInfo.forEach((val, idx) => {
      if (val !== null) infoMap[idx] = val;
    });
  }

  const payload = {
    info: infoMap,
    updatedAt: Date.now(),
  };

  if (names && names.length > 0) {
    payload.names = FieldValue.arrayUnion(...names);
  }

  if (result.numbers && Array.isArray(result.numbers) && result.numbers.length > 0) {
    const formattedNos = result.numbers.map(n => String(n).toUpperCase());
    payload.numbers = FieldValue.arrayUnion(...formattedNos);
  }

  await saveCardAndQueueIndex(cid, payload);

  // 부분 언어 데이터로 상세 캐시를 덮어쓰지 않습니다. 다음 조회에서 병합된 원본을 읽습니다.
  invalidateCardQueries(cid);
  if (!deferIndexFlush) await requestCardIndexWork();

  // 레어도 매핑 동적 업데이트
  let rarityChanged = false;
  let updatedLangs = null;
  if (result.newRarities && result.newRarities.length > 0) {
    try {
      const updateRes = await updateRarityMapping(result.newRarities);
      if (updateRes) {
        rarityChanged = updateRes.changed;
        updatedLangs = updateRes.langs;
      }
    } catch (e) {
      console.error("[RarityMapping] 카드 원본은 저장되었으나 레어도 매핑 갱신에 실패했습니다:", e);
    }
  }

  return { rarityChanged, updatedLangs, names, numbers: result.numbers, validLocales: result.validLocales || [] };
}

function buildSearchResponse(cid, info, isCached, { name, cardNo } = {}) {
  if (!info) return { success: false, name: '정보 없음', numbers: [], status: 'error' };
  const locales = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
  const available = locales.map((locale, index) => ({ locale, data: info[index] }))
    .filter(entry => Array.isArray(entry.data) && entry.data[0]);
  if (!available.length) return { success: false, name: '정보 없음', numbers: [], status: 'error' };
  const number = String(cardNo || '').trim().toUpperCase();
  let selected = number ? available.filter(entry => Object.keys(entry.data[2] || {})
    .some(no => no.trim().toUpperCase() === number)) : [];
  if (!selected.length && name) selected = available.filter(entry => normalizeText(entry.data[0]) === normalizeText(name));
  if (!selected.length) selected = [available[0]];
  const illustrationEntries = selected.slice();
  // 같은 이름을 공유하는 언어 항목은 기존 이름 인덱스와 동일하게 합칩니다.
  const primary = selected[0];
  selected = available.filter(entry => normalizeText(entry.data[0]) === normalizeText(primary.data[0]));
  const raritiesByNo = {};
  for (const entry of selected) for (const [rawNo, details] of Object.entries(entry.data[2] || {})) {
    if (!Array.isArray(details)) continue;
    const no = rawNo.trim().toUpperCase();
    const old = raritiesByNo[no];
    raritiesByNo[no] = old ? [old[0], ...new Set([...old.slice(1), ...details.slice(1)])] : details.slice();
  }
  const illustrations = [...new Set(illustrationEntries.flatMap(entry => {
    const value = entry.data[1];
    // 기존 문서의 count 형식도 재크롤링 전까지 안전하게 읽습니다.
    return Array.isArray(value) ? value : Array.from({ length: Number(value) || 0 }, (_, i) => i + 1);
  }).map(Number).filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  return {
    success: true, status: 'success', isCached: !!isCached, cid: String(cid),
    name: primary.data[0], numbers: Object.keys(raritiesByNo).sort(), raritiesByNo,
    illustrations,
    illustrationCount: illustrations.length,
    linkData: { id: String(cid), locale: primary.locale, locales: available.map(entry => entry.locale) },
    // 전체 문서의 언어·스탯을 상세 화면에서도 재사용합니다.
    info, names: [...new Set(available.map(entry => entry.data[0]))], rarityMappingRaw: null,
  };
}

async function resolveCardNumber(cardNo, cardName, cacheMap = null) {
  if (!cardNo || !cardName) return cardNo;

  const upperNo = cardNo.toUpperCase();
  const patterns = [
    { old: "DP15-JP", new: "DP15-KR" },
    { old: "20AP-JP", new: "20AP-KR" }
  ];

  const matched = patterns.find(p => upperNo.startsWith(p.old));
  if (!matched) return cardNo;

  try {
    let exists = false;
    let dbName = null;

    if (cacheMap && typeof cacheMap === "object") {
      if (cacheMap.hasOwnProperty(upperNo)) {
        exists = cacheMap[upperNo].exists;
        dbName = cacheMap[upperNo].name;
      } else {
        exists = false;
      }
    } else {
      // [Storage 전환] 인메모리 캐시에서 조회
      const card = await findCard({ number: upperNo });
      const idxEntry = card && buildSearchResponse(card.cid, card.info, true, { cardNo: upperNo });
      exists = !!idxEntry;
      if (exists) {
        dbName = idxEntry.name;
      }
    }

    if (exists) {
      const normInputName = normalizeText(cardName);
      const normDbName = normalizeText(dbName);

      // DB에 저장된 이름과 입력된 이름이 다른 경우 (입력 이름이 한국어일 때) 번호 변환
      if (normInputName !== normDbName) {
        return upperNo.replace(matched.old, matched.new);
      }
    } else {
      // 인덱스에 구 버전 번호가 없다는 것은 마스터 데이터가 KR로 이미 변경되었음을 의미함
      return upperNo.replace(matched.old, matched.new);
    }
  } catch (e) {
    console.error("resolveCardNumber error:", e);
  }
  return cardNo;
}


/**
 * 카드 상세 메타데이터 표준 응답 경량화 포맷터 (langOnly 옵션 지원)
 */
function formatMetaResponse(cid, name, rawData, langOnly = false) {
  const fullInfo = rawData.info || rawData.mergedInfo || {};
  const normalizedInfoMap = {};

  if (Array.isArray(fullInfo)) {
    fullInfo.forEach((val, idx) => {
      if (val !== undefined && val !== null) {
        normalizedInfoMap[idx] = val;
      }
    });
  } else if (typeof fullInfo === 'object') {
    Object.keys(fullInfo).forEach(k => {
      if (fullInfo[k] !== undefined && fullInfo[k] !== null) {
        normalizedInfoMap[k] = fullInfo[k];
      }
    });
  }

  let finalInfo = {};

  if (langOnly) {
    Object.keys(normalizedInfoMap).forEach(k => {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && idx < 10) {
        finalInfo[k] = normalizedInfoMap[k];
      }
    });
  } else {
    finalInfo = normalizedInfoMap;
  }

  // 대표 카드 이름(primaryName) 단일 문자열 정교 추출
  let primaryName = name || rawData.name || "";
  if (!primaryName) {
    const firstLang = normalizedInfoMap["0"] || normalizedInfoMap["ko"] || normalizedInfoMap[0];
    if (Array.isArray(firstLang) && typeof firstLang[0] === 'string') {
      primaryName = firstLang[0];
    } else if (typeof firstLang === 'string') {
      primaryName = firstLang;
    }
  }

  return {
    success: true,
    cid: String(cid || rawData.cid || ""),
    name: primaryName,
    info: finalInfo,
    numbers: rawData.numbers || [],
    raritiesByNo: rawData.raritiesByNo || {}
  };
}

/**
 * info[10] 이상 스탯/필터 정보만 경량화 추출하는 헬퍼
 */
function extractFilterMeta(infoData) {
  if (!infoData) return {};
  const filterMeta = {};
  if (Array.isArray(infoData)) {
    for (let i = 10; i < infoData.length; i++) {
      if (infoData[i] !== undefined) filterMeta[i] = infoData[i];
    }
  } else if (typeof infoData === 'object') {
    Object.keys(infoData).forEach(k => {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && idx >= 10) {
        filterMeta[k] = infoData[k];
      }
    });
  }
  return filterMeta;
}

/**
 * 포괄 검색 / 필터용 CID 묶음 배치(Batch) 메타데이터 조회
 */
async function getCardsMetaBatch(cids = []) {
  if (!Array.isArray(cids) || cids.length > 200) throw new Error('카드는 최대 200개까지 조회할 수 있습니다.');
  const cards = await getCardsByCids(cids);
  return { success: true, results: Object.fromEntries(cards.filter(Boolean)
    .map(card => [card.cid, extractFilterMeta(card.info)])) };
}

async function getCardMetadata(cid, name, cardNo = '', langOnly = false) {
  const card = await findCard({ cid, name, number: cardNo });
  if (card) {
    const displayName = name || buildSearchResponse(card.cid, card.info, true, { cardNo }).name;
    return formatMetaResponse(card.cid, displayName, card.data, langOnly);
  }
  if (name) {
    const result = await crawlByCardName(name);
    if (result && !result.isError) {
      await saveCardToFirestore(result);
      const saved = await getCardByCid(result.cid);
      if (saved) return formatMetaResponse(saved.cid, name, saved.data, langOnly);
    }
  }
  return { success: false, message: '카드 상세 데이터를 찾을 수 없습니다.' };
}

async function getRamMemoryStats() {
  const mem = process.memoryUsage();
  return { success: true, totalRamCards: cardDocuments.size,
    rssRamMB: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
    heapRamMB: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB` };
}

module.exports = {
  getCardFromCacheByNo,
  getCardFromCacheByName,
  getCardMetadata,
  getCardsMetaBatch,
  getRamMemoryStats,
  saveCardToFirestore,
  updateRarityMapping,
  buildSearchResponse,
  resolveCardNumber
};
