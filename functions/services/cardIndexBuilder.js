const { normalizeText } = require('../utils/common');

// 카드 간에 공유하는 이름/번호를 보존하기 위해 전체 원본의 합집합을 만듭니다.
function createCardManifest() { return { names: new Set(), numbers: new Set() }; }
function addCardToManifest(manifest, card) {
  for (const raw of card.names || []) {
    const name = normalizeText(raw);
    if (name && !name.startsWith('##')) manifest.names.add(name);
  }
  for (const raw of card.numbers || []) {
    const number = String(raw).trim().toUpperCase();
    if (number && !number.startsWith('##')) manifest.numbers.add(number);
  }
}
module.exports = { createCardManifest, addCardToManifest };
