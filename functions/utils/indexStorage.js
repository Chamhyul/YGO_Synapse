/**
 * indexStorage.js
 * Firebase Storage 기반 카드 인덱스 읽기/쓰기 공통 유틸리티
 *
 * Storage 파일 구조:
 *   - public/indexes/idx_byName.json   : 카드 이름 → {cid, illustrationCount, 번호별 레어도}
 *   - public/indexes/idx_byNumber.json : 카드 번호 → {cid, name, illustrationCount, rarity, locales}
 *   - public/indexes/idx_cid.json      : CID → {names: [모든 언어 이름]}
 *
 * 캐시 전략:
 *   - Cloud Functions 인스턴스 수준 글로벌 변수 캐시
 *   - TTL 10분 기본 + 캐시 미스 시 강제 갱신 (옵션 C)
 */
const { admin, getBucket } = require("../config/firebase");

const INDEX_DIR = "public/indexes";
const INDEX_PATHS = {
  byName: `${INDEX_DIR}/idx_byName.json`,
  byNumber: `${INDEX_DIR}/idx_byNumber.json`,
  cid: `${INDEX_DIR}/idx_cid.json`,
};

// ──────────────────────────────────────────────
// 글로벌 캐시 (인스턴스 수준)
// ──────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

const _cache = {
  byName: { data: null, loadedAt: 0, generation: null },
  byNumber: { data: null, loadedAt: 0, generation: null },
  cid: { data: null, loadedAt: 0, generation: null },
};

/**
 * 캐시가 유효한지 확인합니다.
 */
function isCacheValid(type) {
  const c = _cache[type];
  if (!c.data) return false;
  return (Date.now() - c.loadedAt) < CACHE_TTL_MS;
}

/**
 * Storage에서 인덱스 JSON 파일을 다운로드합니다.
 * @param {string} type - 'byName' | 'byNumber' | 'cid'
 * @returns {Promise<Object>} 인덱스 데이터 객체
 */
async function downloadIndex(type) {
  try {
    const bucket = getBucket();
    if (!bucket) {
      console.warn(`[IndexStorage] getBucket() returned null/undefined for ${type}`);
      return {};
    }
    const file = bucket.file(INDEX_PATHS[type]);
    const [exists] = await file.exists().catch(() => [false]);
    if (!exists) {
      console.warn(`[IndexStorage] File does not exist: ${INDEX_PATHS[type]}`);
      const empty = {};
      _cache[type] = { data: empty, loadedAt: Date.now(), generation: "0" };
      return empty;
    }
    const [metadata] = await file.getMetadata();
    const [content] = await file.download();
    const data = JSON.parse(content.toString("utf-8"));
    // 캐시 갱신
    _cache[type] = { data, loadedAt: Date.now(), generation: metadata.generation };
    return data;
  } catch (e) {
    console.error(`[IndexStorage] downloadIndex(${type}) 실패:`, e.message || e);
    const empty = {};
    _cache[type] = { data: empty, loadedAt: Date.now(), generation: "0" };
    return empty;
  }
}

/**
 * 인덱스 데이터를 Storage에 업로드합니다.
 * @param {string} type - 'byName' | 'byNumber' | 'cid'
 * @param {Object} data - 인덱스 데이터 객체
 * @returns {Promise<void>}
 */
async function uploadIndex(type, data) {
  try {
    const bucket = getBucket();
    const file = bucket.file(INDEX_PATHS[type]);
    await file.save(JSON.stringify(data), {
      contentType: "application/json",
      metadata: {
        cacheControl: "public, max-age=300", // 5분 CDN 캐시
      },
    });
    // 로컬 캐시도 갱신
    _cache[type] = { data, loadedAt: Date.now(), generation: null };
  } catch (err) {
    console.error(`[IndexStorage] uploadIndex(${type}) 실패:`, err.message || err);
  }
}

// ──────────────────────────────────────────────
// 글로벌 캐시 접근자 (TTL + 캐시 미스 강제 갱신)
// ──────────────────────────────────────────────

/**
 * idx_byName 인덱스를 글로벌 캐시에서 반환합니다.
 * TTL 만료 시 또는 캐시 없을 때 Storage에서 다운로드합니다.
 * @param {boolean} [forceRefresh=false] - 강제 갱신 여부
 * @returns {Promise<Object>} idx_byName 데이터
 */
async function getIdxByName(forceRefresh = false) {
  if (!forceRefresh && isCacheValid("byName")) return _cache.byName.data;
  return await downloadIndex("byName");
}

/**
 * idx_byNumber 인덱스를 글로벌 캐시에서 반환합니다.
 * @param {boolean} [forceRefresh=false] - 강제 갱신 여부
 * @returns {Promise<Object>} idx_byNumber 데이터
 */
async function getIdxByNumber(forceRefresh = false) {
  if (!forceRefresh && isCacheValid("byNumber")) return _cache.byNumber.data;
  return await downloadIndex("byNumber");
}

/**
 * idx_cid 인덱스를 글로벌 캐시에서 반환합니다.
 * @param {boolean} [forceRefresh=false] - 강제 갱신 여부
 * @returns {Promise<Object>} idx_cid 데이터
 */
async function getIdxCid(forceRefresh = false) {
  if (!forceRefresh && isCacheValid("cid")) return _cache.cid.data;
  return await downloadIndex("cid");
}

/**
 * 특정 또는 전체 인덱스 캐시를 무효화합니다.
 * @param {string} [type] - 'byName' | 'byNumber' | 'cid' (미지정 시 전체)
 */
function invalidateCache(type) {
  if (type) {
    _cache[type] = { data: null, loadedAt: 0, generation: null };
  } else {
    for (const key of Object.keys(_cache)) {
      _cache[key] = { data: null, loadedAt: 0, generation: null };
    }
  }
}

// ──────────────────────────────────────────────
// Generation 기반 조건부 인덱스 업데이트
// ──────────────────────────────────────────────

/**
 * 인덱스 파일을 Generation 기반 낙관적 잠금으로 안전하게 업데이트합니다.
 *
 * @param {string} type - 'byName' | 'byNumber' | 'cid'
 * @param {Function} updateFn - (indexData) => void 형태의 인메모리 수정 함수
 * @param {number} [maxRetries=3] - 최대 재시도 횟수
 * @returns {Promise<Object>} 업데이트된 인덱스 데이터
 */
async function updateIdxWithRetry(type, updateFn, maxRetries = 3) {
  const bucket = getBucket();
  const filePath = INDEX_PATHS[type];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const file = bucket.file(filePath);
    let data, generation;

    try {
      const [metadata] = await file.getMetadata();
      generation = metadata.generation;
      const [content] = await file.download();
      data = JSON.parse(content.toString("utf-8"));
    } catch (e) {
      if (e.code === 404 || (e.message && e.message.includes("No such object"))) {
        data = {};
        generation = "0";
      } else {
        throw e;
      }
    }

    // 인메모리 수정 실행
    updateFn(data);

    // 조건부 업로드
    try {
      const preconditionOpts = generation === "0"
        ? { ifGenerationMatch: 0 }
        : { ifGenerationMatch: parseInt(generation) };

      await file.save(JSON.stringify(data), {
        contentType: "application/json",
        metadata: { cacheControl: "public, max-age=300" },
        preconditionOpts,
      });

      // 캐시 갱신
      _cache[type] = { data, loadedAt: Date.now(), generation: null };
      return data;
    } catch (err) {
      if (err.code === 412 || (err.message && err.message.includes("conditionNotMet"))) {
        if (attempt < maxRetries - 1) {
          console.warn(`[IndexStorage] 동시성 충돌 감지 (${type}, 시도 ${attempt + 1}/${maxRetries}), 재시도...`);
          continue;
        }
        console.error(`[IndexStorage] 최대 재시도 초과. 강제 저장.`);
        await file.save(JSON.stringify(data), {
          contentType: "application/json",
          metadata: { cacheControl: "public, max-age=300" },
        });
        _cache[type] = { data, loadedAt: Date.now(), generation: null };
        return data;
      }
      throw err;
    }
  }
}

// ──────────────────────────────────────────────
// 매니페스트 재빌드 (Firestore 스캔 제거)
// ──────────────────────────────────────────────

/**
 * 캐시된 인덱스 데이터에서 cardNames.json 매니페스트를 재빌드합니다.
 * 기존의 idx_byName/idx_byNumber Firestore 전체 스캔을 완전히 대체합니다.
 *
 * @returns {Promise<{nameCount: number, numberCount: number}>}
 */
async function rebuildCardManifestFromCache() {
  try {
    const [byNameData, byNumberData] = await Promise.all([
      getIdxByName(true),  // 최신 데이터 보장
      getIdxByNumber(true),
    ]);

    const allNames = Object.keys(byNameData).filter(id => !id.startsWith("##"));
    const allNumbers = Object.keys(byNumberData).filter(id => !id.startsWith("##"));

    const bucket = getBucket();
    const file = bucket.file("public/cardNames.json");

    const payload = {
      names: allNames,
      numbers: allNumbers,
      updatedAt: Date.now()
    };

    await file.save(JSON.stringify(payload), {
      contentType: "application/json",
      metadata: {
        cacheControl: "public, max-age=3600"
      }
    });

    console.log(`[IndexStorage] cardNames.json 재빌드 완료. Names: ${allNames.length}, Numbers: ${allNumbers.length}`);
    return { nameCount: allNames.length, numberCount: allNumbers.length };
  } catch (e) {
    console.error("[IndexStorage] rebuildCardManifestFromCache 실패:", e);
    throw e;
  }
}

module.exports = {
  downloadIndex,
  uploadIndex,
  getIdxByName,
  getIdxByNumber,
  getIdxCid,
  invalidateCache,
  updateIdxWithRetry,
  rebuildCardManifestFromCache,
  INDEX_PATHS,
};
