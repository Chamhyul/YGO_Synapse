const { admin, getBucket } = require("../config/firebase");

let cachedRarityUpdatedAt = 0;

async function getRarityMappingFromStorage() {
  const bucket = getBucket();
  const file = bucket.file("public/rarityMapping.json");

  try {
    const [metadata] = await file.getMetadata().catch(() => [null]);
    const fileUpdatedAt = metadata && metadata.updated ? new Date(metadata.updated).getTime() : Date.now();
    cachedRarityUpdatedAt = fileUpdatedAt;

    const [content] = await file.download();
    const parsed = JSON.parse(content.toString("utf-8"));
    return { data: parsed, updatedAt: fileUpdatedAt };
  } catch (e) {
    console.error("[Storage] Failed to download rarityMapping.json:", e);
    return {
      data: {
        langs: { "0": [], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [], "8": [], "9": [], "10": [] },
        updatedAt: 0
      },
      updatedAt: cachedRarityUpdatedAt
    };
  }
}

function updateRarityMemoryCache(data) {
  cachedRarityUpdatedAt = Date.now();
}

// Map 구조를 2D 배열(11개 언어)로 변환 (마스터 캐시 호환용)
function mapToLangsArray(langs) {
  if (!langs) return [[], [], [], [], [], [], [], [], [], [], []];
  const result = [];
  for (let i = 0; i < 11; i++) {
    result.push(langs[String(i)] || []);
  }
  return result;
}

// 열 기준 데이터를 행 기준(2D Matrix)으로 변환 (프론트엔드 UI 호환용)
function mapToRowArray(langsMap) {
  const headers = ['display', 'ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
  const result = [headers];

  if (!langsMap || !langsMap["10"]) return result;

  const rowCount = langsMap["10"].length;
  for (let i = 0; i < rowCount; i++) {
    const row = [langsMap["10"][i]]; // 첫 번째 열은 display (인덱스 10)
    for (let l = 0; l < 10; l++) { // 나머지 0~9번 인덱스 (언어별 코드)
      row.push(langsMap[String(l)] ? (langsMap[String(l)][i] || "") : "");
    }
    result.push(row);
  }
  return result;
}

// 괄호 내용 추출 유틸리티 (레어도 매칭용)
const getParen = (str) => {
  const m = (str || "").match(/\(([^)]+)\)/);
  return m ? m[1].trim() : null;
};

/**
 * 불가시 유니코드 문자 제거 및 공백/NFC 정규화
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  return String(str || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

module.exports = {
  mapToLangsArray,
  mapToRowArray,
  getParen,
  getRarityMappingFromStorage,
  updateRarityMemoryCache,
  normalizeText
};
