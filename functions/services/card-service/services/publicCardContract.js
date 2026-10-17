const VERSION = '1';
function serializePublicCard(doc) {
  const data = doc.data();
  return { cid: doc.id, data: { names: data.names || [], numbers: data.numbers || [], info: data.info || {} } };
}
function validatePublicCards(result) {
  if (!result || result.success !== true || !Array.isArray(result.cards) || result.cards.length > 100 || result.cards.some(card =>
    !card || typeof card.cid !== 'string' || !/^[1-9]\d{0,9}$/.test(card.cid)
    || !card.data || !Array.isArray(card.data.names) || !Array.isArray(card.data.numbers)
    || !card.data.info || typeof card.data.info !== 'object')) {
    throw new Error('운영 카드 조회 응답이 올바르지 않습니다.');
  }
  return result.cards;
}
module.exports = { VERSION, serializePublicCard, validatePublicCards };
