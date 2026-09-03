/**
 * 카드 info / mergedInfo의 위치별 의미 (Firestore에서는 숫자 문자열 키의 Map으로 저장):
 * 0~9: ko, ja, ae, cn, en, de, fr, it, es, pt 순서의 언어별 정보.
 *   각 언어 배열: [카드명, 일러스트 수, 번호별 레어도 정보, 일반 효과, 펜듈럼 효과].
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
const { getIdxByName, getIdxByNumber, getIdxCid } = require("../utils/indexStorage");
const { updateRarityMemoryCache, normalizeText } = require("../utils/common");
const { saveCardAndQueueIndex } = require("./cardWriteService");
const { crawlByCardName } = require("../scrapers/cardScraper");

// [전역 RAM 인메모리 캐시 맵] - 개별 카드 TTL (10분) 만료 캐시
const _fullMetaMemoryMap = new Map();
const RAM_CARD_CACHE_TTL_MS = 10 * 60 * 1000; // 10분 후 RAM에서 자동 만료

/**
 * 카드 이름을 Firestore 문서 ID로 사용하기 위한 정규화
 * - 제로폭 문자 제거, 공백 정규화, NFC 정규화
 * - '/' → '_SLASH_' 치환 (Firestore 문서 ID 제약)
 */
function normalizeNameForDocId(name) {
  return normalizeText(name).replace(/\//g, "_SLASH_");
}

/**
 * 인덱스 기반 카드 번호 검색
 * Storage 번호 인덱스에서 조회
 */
async function getCardFromCacheByNo(cardNo) {
  const upper = cardNo.toUpperCase();

  try {
    // 1단계: Storage 인덱스 캐시 조회 (가장 빠름)
    let idxByNumber = await getIdxByNumber();
    let entry = idxByNumber ? idxByNumber[upper] : null;
    
    // 캐시 미스 시 강제 갱신 후 재시도 (옵션 C)
    if (!entry) {
      idxByNumber = await getIdxByNumber(true);
      entry = idxByNumber ? idxByNumber[upper] : null;
    }
    
    if (entry) {
      return { cid: entry.cid, fromIndex: true, indexData: entry };
    }
  } catch (idxErr) {
    console.warn("Index lookup error in getCardFromCacheByNo:", idxErr.message);
  }

  // 2단계: 인덱스에 번호 부재 시 null 반환 (실시간 크롤링 파이프라인으로 전환)
  return null;
}

/**
 * 인덱스 기반 카드 이름 검색
 * Storage 이름 인덱스에서 조회
 */
async function getCardFromCacheByName(cardName) {
  const normName = normalizeText(cardName);
  const docId = normalizeNameForDocId(cardName);

  try {
    // 1단계: Storage 인덱스 캐시 조회 (가장 빠름)
    let idxByName = await getIdxByName();
    let entry = idxByName ? idxByName[docId] : null;
    
    // 캐시 미스 시 강제 갱신 후 재시도 (옵션 C)
    if (!entry) {
      idxByName = await getIdxByName(true);
      entry = idxByName ? idxByName[docId] : null;
    }
    
    if (entry) {
      return { cid: entry.cid, fromIndex: true, indexData: entry };
    }
  } catch (idxErr) {
    console.warn("Index lookup error in getCardFromCacheByName:", idxErr.message);
  }

  // 2단계: 기존 cards 컬렉션 fallback (하위 호환)
  try {
    const snapshot = await db.collection("cards")
      .where("names", "array-contains", normName)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const data = doc.data();
    const info = data.info || {};
    return { cid: doc.id, info, fromIndex: false };
  } catch (dbErr) {
    console.error("Firestore lookup error in getCardFromCacheByName:", dbErr);
    return null;
  }
}

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
  _fullMetaMemoryMap.delete(String(cid));
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

function buildSearchResponse(cid, info, isCached) {
  if (!info) return { success: false, name: "정보 없음", numbers: [], status: 'error' };

  const allNumbers = new Set();
  const mergedRarities = {};
  
  // info는 배열(희소 배열) 또는 객체 형태일 수 있으므로 유효한 키(인덱스)를 추출
  const validKeys = Object.keys(info);
  if (validKeys.length === 0) return { success: false, name: "데이터 부족", numbers: [], status: 'error' };

  // 모든 로케일의 정보를 순회하며 카드 번호와 레어리티 정보를 완전 병합
  validKeys.forEach((key) => {
    const data = info[key];
    // data[2]는 해당 언어에서의 raritiesByNo 객체
    if (data && Array.isArray(data) && data[2]) {
      const rByNo = data[2];
      for (const no in rByNo) {
        const upperNo = no.toUpperCase();
        allNumbers.add(upperNo);

        const currentRars = rByNo[no]; // [PackName, rarity1, rarity2, ...]
        if (!mergedRarities[upperNo]) {
          mergedRarities[upperNo] = [...currentRars];
        } else {
          // 이미 해당 번호의 데이터가 있으면 팩 이름을 제외한 레어리티 정보만 중복 없이 추가
          const existingList = mergedRarities[upperNo];
          const incomingRars = currentRars.slice(1);
          incomingRars.forEach((r) => {
            if (r && !existingList.includes(r)) existingList.push(r);
          });
        }
      }
    }
  });

  // 대표 데이터 선정: 한국어(0) 우선, 없으면 첫 번째 유효 데이터 사용
  const infoIndexKeys = Object.keys(info).filter(k => !isNaN(k) && Number(k) >= 0 && Number(k) <= 9);
  
  // 실제 데이터(이름)가 있는 인덱스들 중 우선순위 선정
  const validDataIndices = infoIndexKeys.filter(k => {
    const d = info[k];
    return d && Array.isArray(d) && d[0] && String(d[0]).trim() !== "";
  });

  // 한국어(0)가 유효하면 0, 아니면 유효한 것 중 첫 번째, 아예 없으면 첫 번째 키
  const primaryIdx = validDataIndices.includes("0") ? "0" : (validDataIndices.includes(0) ? 0 : (validDataIndices[0] || infoIndexKeys[0]));
  const primaryData = info[primaryIdx] || ["-", 0, {}];
  const [primaryName, illustrationCount] = primaryData;

  const localeToIndex = { 'ko': 0, 'ja': 1, 'ae': 2, 'cn': 3, 'en': 4, 'de': 5, 'fr': 6, 'it': 7, 'es': 8, 'pt': 9 };
  const indexToLocale = Object.keys(localeToIndex).reduce((obj, key) => {
    obj[localeToIndex[key]] = key;
    return obj;
  }, {});

  // info 객체(0~9 키)에서 실제 데이터가 있는 로케일만 추출
  const infoLocales = validDataIndices.map(k => indexToLocale[k]).filter(Boolean);

  // 프론트엔드(script.js) 기댓값에 100% 맞춘 성공 응답 객체
  return {
    success: true,
    status: 'success',
    isCached: !!isCached,
    name: primaryName || "-",
    numbers: Array.from(allNumbers).sort(),
    raritiesByNo: mergedRarities,
    illustrationCount: illustrationCount || 0,
    linkData: { 
      id: cid, 
      // 단일 이동 시 사용할 로케일: 유효한 로케일 중 첫 번째 혹은 대표 로케일
      locale: infoLocales[0] || indexToLocale[primaryIdx] || 'ko',
      locales: infoLocales 
    },
    rarityMappingRaw: null 
  };
}

/**
 * 인덱스 항목 엔트리에서 번호 목록과 레어도 맵을 추출하는 공통 유틸리티
 */
function extractNumbersAndRarities(entryObj) {
  const raritiesByNo = {};
  const numbers = [];
  for (const key in entryObj) {
    if (key === 'cid' || key === 'illustrationCount' || key === 'locales') continue;
    if (Array.isArray(entryObj[key])) {
      numbers.push(key);
      raritiesByNo[key] = ["", ...entryObj[key]];
    }
  }
  return { numbers, raritiesByNo };
}

/**
 * 인덱스 데이터로부터 검색 응답 생성 (idx_byNumber용)
 */
async function buildSearchResponseFromIndexByNo(cardNo, indexData) {
  const name = indexData.name;
  let numbers = [cardNo];
  let raritiesByNo = { [cardNo]: ["", ...(indexData.rarity || [])] };
  let locales = indexData.locales || ['ko'];

  if (name) {
    try {
      const docId = normalizeNameForDocId(name);
      const idxByName = await getIdxByName();
      const nameEntry = idxByName[docId];
      if (nameEntry) {
        const { numbers: entryNumbers, raritiesByNo: entryRaritiesByNo } = extractNumbersAndRarities(nameEntry);
        if (entryNumbers.length > 0) {
          numbers = entryNumbers;
          raritiesByNo = entryRaritiesByNo;
        }
        if (nameEntry.locales) {
          locales = nameEntry.locales;
        }
      }
    } catch (err) {
      console.warn("buildSearchResponseFromIndexByNo - failed to merge other numbers:", err);
    }
  }

  return {
    success: true,
    isCached: true,
    name: name || "-",
    numbers: numbers.sort(),
    raritiesByNo: raritiesByNo,
    illustrationCount: indexData.illustrationCount || 0,
    linkData: { 
      id: indexData.cid, 
      locale: (locales && locales.length > 0) ? locales[0] : 'ko',
      locales: locales || ['ko']
    },
    rarityMappingRaw: null
  };
}

/**
 * 인덱스 데이터로부터 검색 응답 생성 (idx_byName용)
 */
function buildSearchResponseFromIndexByName(indexData) {
  const { numbers, raritiesByNo } = extractNumbersAndRarities(indexData);

  // 이름은 idx_byName 문서 ID에서 복원 (호출 측에서 전달)
  return {
    success: true,
    isCached: true,
    name: null, // 호출 측에서 설정
    numbers,
    raritiesByNo,
    illustrationCount: indexData.illustrationCount || 0,
    linkData: { 
      id: indexData.cid, 
      locale: (indexData.locales && indexData.locales.length > 0) ? indexData.locales[0] : 'ko',
      locales: indexData.locales || ['ko']
    },
    rarityMappingRaw: null
  };
}

/**
 * 카드 번호 자동 보정 (JP -> KR)
 * - 특정 패턴(DP15-JP, 20AP-JP)인 경우 이름을 비교하여 적절히 변환
 */
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
      const idxByNumber = await getIdxByNumber();
      const idxEntry = idxByNumber[upperNo];
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
  if (!Array.isArray(cids) || cids.length === 0) {
    return { success: true, results: {} };
  }

  const results = {};
  const missingCids = [];

  for (const rawCid of cids) {
    if (!rawCid) continue;
    const cidStr = String(rawCid).trim();
    if (_fullMetaMemoryMap.has(cidStr)) {
      const entry = _fullMetaMemoryMap.get(cidStr);
      if (entry && (Date.now() - entry.timestamp) < RAM_CARD_CACHE_TTL_MS && entry.data) {
        const infoObj = entry.data.info || entry.data.mergedInfo || {};
        results[cidStr] = extractFilterMeta(infoObj);
        continue;
      }
    }
    missingCids.push(cidStr);
  }

  if (missingCids.length > 0) {
    try {
      const refs = missingCids.map(c => db.collection("cards").doc(c));
      const snaps = await db.getAll(...refs);
      snaps.forEach(snap => {
        if (snap.exists) {
          const data = snap.data();
          const cardCid = snap.id;
          const fullDataObj = {
            cid: cardCid,
            name: data.name || "",
            info: data.info || {},
            numbers: data.numbers || [],
            raritiesByNo: data.raritiesByNo || {}
          };
          _fullMetaMemoryMap.set(cardCid, { data: fullDataObj, timestamp: Date.now() });
          results[cardCid] = extractFilterMeta(data.info || {});
        }
      });
    } catch (e) {
      console.warn("getCardsMetaBatch getAll error:", e.message);
    }
  }

  return { success: true, results };
}

async function getCardMetadata(cid, name, cardNo = "", langOnly = false) {
  const normCid = cid ? String(cid).trim() : "";
  const normName = name ? String(name).trim() : "";
  const normCardNo = cardNo ? String(cardNo).trim().toUpperCase() : "";

  // 0단계: CID 키로 백엔드 RAM 인메모리 맵 탐색
  let targetCid = normCid;

  // 카드 번호(cardNo)가 들어왔으나 targetCid가 없는 경우: Firestore cards 컬렉션 numbers 배열 인덱스 0.01초 핀포인트 쿼리
  if (!targetCid && normCardNo) {
    try {
      const snapshot = await db.collection("cards")
        .where("numbers", "array-contains", normCardNo)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        targetCid = snapshot.docs[0].id;
      }
    } catch (err) {
      console.warn("idx_byNumber cards lookup warning:", err.message || err);
    }
  }

  // 카드 이름만 들어온 경우 인덱스에서 CID 추출
  if (!targetCid && normName) {
    const cached = await getCardFromCacheByName(normName);
    if (cached) targetCid = cached.cid;
  }

  let memData = null;
  if (targetCid && _fullMetaMemoryMap.has(targetCid)) {
    const entry = _fullMetaMemoryMap.get(targetCid);
    if (entry && (Date.now() - entry.timestamp) < RAM_CARD_CACHE_TTL_MS) {
      memData = entry.data;
    } else {
      // 10분 이상 경과 시 RAM 캐시 자동 만료/제거
      _fullMetaMemoryMap.delete(targetCid);
    }
  }

  if (memData) {
    return formatMetaResponse(targetCid, normName, memData, langOnly);
  }

  // 1단계: RAM 미스/만료 시 DB (cards 컬렉션/문서) 직접 조회 ➔ 읽어온 결과를 RAM 맵에 10분 TTL로 상주
  let cardCid = targetCid;
  if (cardCid) {
    try {
      const docRef = db.collection("cards").doc(String(cardCid));
      const docSnap = await docRef.get();
      
      if (docSnap.exists) {
        const data = docSnap.data();
        const fullDataObj = {
          cid: String(cardCid),
          name: data.name || normName,
          info: data.info || {},
          numbers: data.numbers || [],
          raritiesByNo: data.raritiesByNo || {}
        };
        // 백엔드 RAM 메모리 맵에 10분 TTL로 상주
        _fullMetaMemoryMap.set(String(cardCid), { data: fullDataObj, timestamp: Date.now() });

        return formatMetaResponse(cardCid, normName, fullDataObj, langOnly);
      }
    } catch (err) {
      console.warn("getCardMetadata firestore lookup error:", err);
    }
  }

  // 2단계: DB 미스 및 CID 부재 시 실시간 크롤링 파이프라인 수행 ➔ RAM 맵 & DB 동시 수록
  if (name) {
    try {
      const crawlRes = await crawlByCardName(name);
      if (crawlRes && !crawlRes.isError) {
        await saveCardToFirestore(crawlRes);

        // 백엔드 RAM 메모리 맵에 즉시 상주
        const fullMetaObj = {
          cid: crawlRes.cid,
          name: name,
          info: crawlRes.mergedInfo || crawlRes.info || {},
          numbers: crawlRes.numbers || [],
          raritiesByNo: crawlRes.raritiesByNo || {}
        };
        _fullMetaMemoryMap.set(String(crawlRes.cid), { data: fullMetaObj, timestamp: Date.now() });

        return formatMetaResponse(crawlRes.cid, name, fullMetaObj, langOnly);
      }
    } catch (crawlErr) {
      console.error("getCardMetadata crawl error:", crawlErr);
    }
  }

  return { success: false, message: "카드 상세 데이터를 찾을 수 없습니다." };
}

async function getRamMemoryStats() {
  if (!_isMemoryWarmedUp) {
    await warmUpMemoryCache();
  }
  const mem = process.memoryUsage();
  return {
    success: true,
    isWarmedUp: _isMemoryWarmedUp,
    totalRamCards: _fullMetaMemoryMap.size,
    rssRamMB: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
    heapRamMB: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`
  };
}

function flushMemoryCache() {
  _fullMetaMemoryMap.clear();
  return { success: true, message: "백엔드 RAM 인메모리 캐시가 클리어되었습니다." };
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
  buildSearchResponseFromIndexByNo,
  buildSearchResponseFromIndexByName,
  normalizeNameForDocId,
  resolveCardNumber
};
