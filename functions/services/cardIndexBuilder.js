const { normalizeText } = require('../utils/common');

const LOCALES = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
const normalizeName = name => normalizeText(name).replace(/\//g, '_SLASH_');

function emptyIndexes() {
  return { byName: Object.create(null), byNumber: Object.create(null), cid: Object.create(null) };
}

// 원본 info를 기준으로 생성합니다. 전체 재생성과 증분 처리의 유일한 생성 규칙입니다.
function applyCardChanges(indexes, cards, { replace = true } = {}) {
  const changed = new Set(cards.map(card => String(card.cid)));
  if (replace) for (const type of ['byName', 'byNumber']) {
    for (const [key, entry] of Object.entries(indexes[type])) {
      if (changed.has(String(entry.cid))) delete indexes[type][key];
    }
  }
  if (replace) for (const cid of changed) delete indexes.cid[cid];
  for (const card of cards) {
    if (!card.data) continue; // 삭제된 원본의 검색 항목도 제거합니다.
    const cid = String(card.cid);
    const info = card.data.info || {};
    const names = [];
    const locales = LOCALES.filter((_, index) => info[index]?.[0]);
    for (let index = 0; index < LOCALES.length; index++) {
      const lang = info[index];
      if (!Array.isArray(lang) || !lang[0]) continue;
      const name = normalizeText(lang[0]);
      if (!names.includes(name)) names.push(name);
      const key = normalizeName(name);
      let entry = indexes.byName[key];
      if (!entry || entry.cid !== cid) {
        entry = { cid, illustrationCount: lang[1] || 0, locales };
        Object.defineProperty(indexes.byName, key, { value: entry, enumerable: true, writable: true, configurable: true });
      }
      entry.illustrationCount = Math.max(entry.illustrationCount || 0, lang[1] || 0);
      for (const [rawNumber, details] of Object.entries(lang[2] || {})) {
        const number = rawNumber.trim().toUpperCase();
        if (!number || !Array.isArray(details)) continue;
        const rarity = details.slice(1);
        Object.defineProperty(entry, number, { value: rarity, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(indexes.byNumber, number, {
          value: { cid, name: lang[0], illustrationCount: lang[1] || 0, rarity, locales },
          enumerable: true, writable: true, configurable: true,
        });
      }
    }
    if (names.length) Object.defineProperty(indexes.cid, cid, {
      value: { names }, enumerable: true, writable: true, configurable: true,
    });
  }
  return indexes;
}

module.exports = { emptyIndexes, applyCardChanges };
