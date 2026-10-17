'use strict';
const { normalizeText } = require('../utils/text');
const { toRuntimeInfo } = require('../utils/cardSchema');
// 순수 조회 호출자만 사용한다. 미발견 시 수집하는 기존 조정 코드는 전환하지 않는다.
function createRemoteCardLookup(readCards) {
  const normalizeNumber = value => String(value || '').trim().toUpperCase();
  async function getCardsByCids(cids) {
    const ids = [...new Set(cids.map(value => String(value).trim()))].filter(id => /^[1-9]\d{0,9}$/.test(id));
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const cards = await readCards({ cids: ids.slice(offset, offset + 100) });
      for (const card of cards) found.set(card.cid, { ...card, info: toRuntimeInfo(card.data.info) });
    }
    return ids.map(id => found.get(id)).filter(Boolean);
  }
  const getCardByCid = async cid => (await getCardsByCids([cid || '']))[0] || null;
  async function findCards(field, input) {
    const value = field === 'numbers' ? normalizeNumber(input) : normalizeText(input);
    if (!value) return [];
    return (await readCards({ field, value })).map(card => ({ ...card, info: toRuntimeInfo(card.data.info) }));
  }
  async function findCard({ cid, name, number } = {}) {
    if (cid) return getCardByCid(cid);
    let cards = number ? await findCards('numbers', number) : await findCards('names', name);
    if (cards.length > 1 && name) cards = cards.filter(card => card.data.names.some(n => normalizeText(n) === normalizeText(name)));
    if (cards.length > 1) throw Object.assign(new Error('여러 카드가 일치합니다. 이름과 번호를 함께 확인해 주세요.'), { code: 'AMBIGUOUS_CARD' });
    return cards[0] || null;
  }
  async function resolveInventoryCid(number, name) {
    const numbered = await findCards('numbers', number), named = normalizeText(name);
    if (numbered.length) {
      const matches = numbered.filter(card => !named || card.data.names.some(n => normalizeText(n) === named));
      return matches.length === 1 ? matches[0].cid : null;
    }
    const matches = await findCards('names', name);
    return matches.length === 1 && (!number || number === 'NO_NUMBER') ? matches[0].cid : null;
  }
  async function mapLimited(values, fn, concurrency = 5) {
    const results = new Array(values.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) { const index = cursor++; results[index] = await fn(values[index], index); }
    }));
    return results;
  }
  return Object.freeze({ getCardByCid, getCardsByCids, findCard, findCards, resolveInventoryCid, normalizeNumber, mapLimited });
}
let lookup;
function getRemoteCardLookup() {
  return lookup ||= createRemoteCardLookup(body => require('./cardReadClient').getCardReadClient().readCards(body));
}
module.exports = { createRemoteCardLookup, getRemoteCardLookup };
