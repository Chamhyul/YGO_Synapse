// 사용자 데이터 처리에서 사용할 카드 읽기 계약. 수집·저장 기능은 노출하지 않는다.
const { createCardNumberResolver } = require('./cardNumberResolver');
function createInventoryCardLookup(read, buildSearchResponse) {
  return Object.freeze({
    findCard: (...args) => read.findCard(...args),
    getCardByCid: (...args) => read.getCardByCid(...args),
    resolveInventoryCid: (...args) => read.resolveInventoryCid(...args),
    normalizeNumber: (...args) => read.normalizeNumber(...args),
    mapLimited: (...args) => read.mapLimited(...args),
    buildSearchResponse,
    resolveCardNumber: createCardNumberResolver({ findCard: (...args) => read.findCard(...args), buildSearchResponse }),
  });
}
let local;
function current() {
  return local ||= createInventoryCardLookup(process.env.CARD_SERVICE_URL
    ? require('./cardReadLookup').getRemoteCardLookup() : require('./cardQueryService'), require('./cardPresentation').buildSearchResponse);
}
module.exports = { createInventoryCardLookup };
for (const name of ['findCard', 'getCardByCid', 'resolveInventoryCid', 'normalizeNumber', 'mapLimited', 'buildSearchResponse', 'resolveCardNumber']) {
  module.exports[name] = (...args) => current()[name](...args);
}
