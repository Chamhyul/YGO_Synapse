const { normalizeText } = require('../utils/text');

function createCardNumberResolver({ findCard, buildSearchResponse }) {
  async function resolveCardNumber(cardNo, cardName, cacheMap = null) {
    if (!cardNo || !cardName) return cardNo;

    const upperNo = cardNo.toUpperCase();
    const patterns = [
      { old: "DP15-JP", new: "DP15-KR" },
      { old: "20AP-JP", new: "20AP-KR" }
    ];

    const matched = patterns.find(p => upperNo.startsWith(p.old));
    if (!matched) return cardNo;

    try {
      let exists = false;
      let dbName = null;

      if (cacheMap && typeof cacheMap === "object") {
        if (cacheMap.hasOwnProperty(upperNo)) {
          exists = cacheMap[upperNo].exists;
          dbName = cacheMap[upperNo].name;
        } else {
          exists = false;
        }
      } else {
        // [Storage 전환] 인메모리 캐시에서 조회
        const card = await findCard({ number: upperNo });
        const idxEntry = card && buildSearchResponse(card.cid, card.info, true, { cardNo: upperNo });
        exists = !!idxEntry;
        if (exists) {
          dbName = idxEntry.name;
        }
      }

      if (exists) {
        const normInputName = normalizeText(cardName);
        const normDbName = normalizeText(dbName);

        // DB에 저장된 이름과 입력된 이름이 다른 경우 (입력 이름이 한국어일 때) 번호 변환
        if (normInputName !== normDbName) {
          return upperNo.replace(matched.old, matched.new);
        }
      } else {
        // 인덱스에 구 버전 번호가 없다는 것은 마스터 데이터가 KR로 이미 변경되었음을 의미함
        return upperNo.replace(matched.old, matched.new);
      }
    } catch (e) {
      console.error("resolveCardNumber error:", e);
    }
    return cardNo;
  }

  return resolveCardNumber;
}

module.exports = { createCardNumberResolver };
