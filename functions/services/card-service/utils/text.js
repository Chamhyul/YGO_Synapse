// 저장소·인증 의존성이 없는 공통 문자열 정규화 계약.
function normalizeText(str) {
  return String(str || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

module.exports = { normalizeText };
