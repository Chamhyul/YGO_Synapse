/**
 * packsStorage.js
 * Firebase Storage 기반 팩 정보 읽기/쓰기 공통 유틸리티
 *
 * Storage 파일 구조:
 *   - public/packs.json          : 전체 팩 목록 메타데이터 (cids 제외)
 *   - public/packs/{packId}.json : 개별 팩 상세 파일 (cids 포함)
 */
const { admin, getBucket } = require("../config/firebase");

const PACKS_METADATA_PATH = "public/packs.json";
const PACK_DETAIL_DIR = "public/packs";

// ──────────────────────────────────────────────
// 전체 팩 목록 메타데이터 파일 (public/packs.json)
// ──────────────────────────────────────────────

/**
 * Storage에서 public/packs.json을 다운로드하여 파싱된 객체로 반환합니다.
 * 파일이 없는 경우 빈 객체 {}를 반환합니다.
 * @returns {Promise<Object>} 팩 메타데이터 맵 { [packId]: { name, locale, totalCards, updatedAt } }
 */
async function downloadPacksMetadata() {
  const bucket = getBucket();
  const file = bucket.file(PACKS_METADATA_PATH);
  try {
    const [content] = await file.download();
    return JSON.parse(content.toString("utf-8"));
  } catch (e) {
    if (e.code === 404 || (e.message && e.message.includes("No such object"))) {
      return {};
    }
    console.error("[PacksStorage] downloadPacksMetadata 실패:", e.message);
    throw e;
  }
}

/**
 * 팩 메타데이터 맵을 public/packs.json으로 Storage에 업로드합니다.
 * @param {Object} data - 팩 메타데이터 맵
 * @returns {Promise<void>}
 */
async function uploadPacksMetadata(data) {
  const bucket = getBucket();
  const file = bucket.file(PACKS_METADATA_PATH);
  await file.save(JSON.stringify(data, null, 2), {
    contentType: "application/json",
    public: true,
    metadata: {
      cacheControl: "public, max-age=300", // 5분 캐시
    },
  });
}

/**
 * Storage의 public/packs.json 파일 메타데이터(URL, updatedAt)를 반환합니다.
 * 클라이언트에게 packListInfo를 전달하기 위해 getInitialData에서 사용합니다.
 * @returns {Promise<{url: string|null, updatedAt: number}>}
 */
async function getPacksMetadataInfo() {
  const bucket = getBucket();
  const file = bucket.file(PACKS_METADATA_PATH);
  try {
    const [metadata] = await file.getMetadata();
    let url;
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      url = `http://127.0.0.1:9199/download/storage/v1/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media`;
    } else {
      url = `https://storage.googleapis.com/${bucket.name}/${file.name}`;
    }
    return { url, updatedAt: new Date(metadata.updated).getTime() };
  } catch (e) {
    console.warn("[PacksStorage] public/packs.json이 아직 없습니다.");
    return { url: null, updatedAt: 0 };
  }
}

// ──────────────────────────────────────────────
// 개별 팩 상세 파일 (public/packs/{packId}.json)
// ──────────────────────────────────────────────

/**
 * Storage에서 public/packs/{packId}.json을 다운로드하여 파싱된 객체로 반환합니다.
 * 파일이 없는 경우 null을 반환합니다.
 * @param {string} packId
 * @returns {Promise<Object|null>} { id, name, locale, totalCards, cids, updatedAt }
 */
async function downloadPackDetail(packId) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`${PACK_DETAIL_DIR}/${packId}.json`);
  try {
    const [content] = await file.download();
    return JSON.parse(content.toString("utf-8"));
  } catch (e) {
    if (e.code === 404 || (e.message && e.message.includes("No such object"))) {
      return null;
    }
    console.error(`[PacksStorage] downloadPackDetail(${packId}) 실패:`, e.message);
    throw e;
  }
}

/**
 * 개별 팩 상세 데이터를 public/packs/{packId}.json으로 Storage에 업로드합니다.
 * @param {string} packId
 * @param {Object} data - { id, name, locale, totalCards, cids, updatedAt }
 * @returns {Promise<void>}
 */
async function uploadPackDetail(packId, data) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`${PACK_DETAIL_DIR}/${packId}.json`);
  await file.save(JSON.stringify(data, null, 2), {
    contentType: "application/json",
    public: true,
    metadata: {
      cacheControl: "public, max-age=300", // 5분 캐시
    },
  });
}

// ──────────────────────────────────────────────
// 통합 갱신 헬퍼
// ──────────────────────────────────────────────

/**
 * 단일 팩의 메타데이터를 packs.json에 병합하고, 상세 파일도 동시에 갱신합니다.
 * searchPack, getPackCids, crawlSinglePack에서 공통으로 사용합니다.
 *
 * @param {string} packId - "{PID}_{locale}" 형식의 복합키
 * @param {{ name: string, totalCards: number, cids?: string[], updatedAt?: number }} packData
 * @returns {Promise<void>}
 */
async function upsertPackToStorage(packId, packData) {
  const now = packData.updatedAt || Date.now();

  // 1. 두 파일 동시 다운로드 (순차 2회 → 병렬 1라운드)
  const [metadata, existing] = await Promise.all([
    downloadPacksMetadata(),
    downloadPackDetail(packId)
  ]);

  // locale은 키({PID}_{locale})에 포함되므로 값 객체에서 제거
  metadata[packId] = {
    name: packData.name,
    totalCards: packData.totalCards || 0,
    updatedAt: now,
  };

  const detail = {
    id: packId,
    name: packData.name,
    totalCards: packData.totalCards || 0,
    cids: packData.cids || (existing ? existing.cids : []),
    updatedAt: now,
  };

  // 2. 두 파일 동시 업로드 (순차 2회 → 병렬 1라운드)
  await Promise.all([
    uploadPacksMetadata(metadata),
    uploadPackDetail(packId, detail)
  ]);
}

/**
 * [Race Condition 방지] 여러 팩을 일괄 저장합니다.
 * packs.json은 단 1회만 갱신하여 동시 실행에 의한 데이터 유실을 방지합니다.
 * searchPackNew처럼 동일 이름의 다국어 팩을 동시에 저장할 때 사용합니다.
 *
 * @param {Array<{ packId: string, name: string, totalCards: number, cids?: string[], updatedAt?: number }>} packsArray
 *        packId는 "{PID}_{locale}" 형식의 복합키
 * @returns {Promise<void>}
 */
async function upsertPacksBatchToStorage(packsArray) {
  if (!packsArray || packsArray.length === 0) return;

  const now = Date.now();

  // 1. 기존 전체 메타데이터 1회만 다운로드
  const metadata = await downloadPacksMetadata();

  // 2. 모든 팩을 메타데이터에 반영 + 개별 상세 파일 병렬 업로드
  await Promise.all(
    packsArray.map(async (p) => {
      const packId = p.packId; // "{PID}_{locale}" 형식
      const updatedAt = p.updatedAt || now;

      // 2-1. 메타데이터 맵 갱신 (공유 객체, 동기 연산이므로 안전)
      // locale은 키에 포함되므로 값 객체에서 제거
      metadata[packId] = {
        name: p.name,
        totalCards: p.totalCards || 0,
        updatedAt,
      };

      // 2-2. 개별 상세 파일 업로드 (독립 경로이므로 병렬 가능)
      const existing = await downloadPackDetail(packId);
      const detail = {
        id: packId,
        name: p.name,
        totalCards: p.totalCards || 0,
        cids: p.cids || (existing ? existing.cids : []),
        updatedAt,
      };
      await uploadPackDetail(packId, detail);
    })
  );

  // 3. 모든 팩 데이터가 반영된 메타데이터를 packs.json에 단 1회 업로드
  await uploadPacksMetadata(metadata);
}

/**
 * Storage의 public/packs.json 메타데이터 및 public/packs/{packId}.json 파일 중
 * totalCards가 0인 팩들을 수집하여 일괄 삭제 및 정리합니다.
 * @returns {Promise<{ removedCount: number, removedPids: string[] }>}
 */
async function cleanZeroCardPacksFromStorage() {
  const bucket = admin.storage().bucket();
  const metadata = await downloadPacksMetadata();

  const zeroPids = Object.keys(metadata).filter((pid) => {
    const p = metadata[pid];
    return !p || !p.totalCards || p.totalCards === 0;
  });

  if (zeroPids.length === 0) {
    return { removedCount: 0, removedPids: [] };
  }

  // 1. 개별 상세 파일 (public/packs/{packId}.json) 삭제 및 메타데이터 key 제거
  await Promise.all(
    zeroPids.map(async (pid) => {
      delete metadata[pid];
      const file = bucket.file(`${PACK_DETAIL_DIR}/${pid}.json`);
      await file.delete().catch((e) => {
        if (e.code !== 404 && (!e.message || !e.message.includes("No such object"))) {
          console.warn(`[PacksStorage] cleanZeroCardPacks delete file error (${pid}):`, e.message);
        }
      });
    })
  );

  // 2. 갱신된 메타데이터를 public/packs.json에 다시 업로드
  await uploadPacksMetadata(metadata);

  console.log(`[PacksStorage] totalCards: 0 팩 ${zeroPids.length}개 정리 완료:`, zeroPids);
  return { removedCount: zeroPids.length, removedPids: zeroPids };
}

/**
 * 개별 팩 상세 파일 (public/packs/{packId}.json)을 Storage에서 삭제합니다.
 * @param {string} packId
 * @returns {Promise<boolean>} 성공 시 true, 존재하지 않으면 false
 */
async function deletePackDetail(packId) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`${PACK_DETAIL_DIR}/${packId}.json`);
  try {
    await file.delete();
    return true;
  } catch (e) {
    if (e.code === 404 || (e.message && e.message.includes("No such object"))) {
      return false;
    }
    console.error(`[PacksStorage] deletePackDetail(${packId}) 실패:`, e.message);
    throw e;
  }
}

module.exports = {
  downloadPacksMetadata,
  uploadPacksMetadata,
  getPacksMetadataInfo,
  downloadPackDetail,
  uploadPackDetail,
  deletePackDetail,
  upsertPackToStorage,
  upsertPacksBatchToStorage,
  cleanZeroCardPacksFromStorage,
};

