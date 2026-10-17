const { normalizeText } = require('../utils/text');

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

module.exports = { buildSearchResponse };
