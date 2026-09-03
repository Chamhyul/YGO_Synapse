const sheets = require("../integrations/googleSheets");

/**
 * [HELPER] 구글 시트에서 MyCard 데이터 파싱
 */
async function fetchMyCardData_Node(spreadsheetId) {
  const values = await sheets.getSheetValues(spreadsheetId, "MyCard!A2:F");
  const allCards = [];
  const locations = {};
  const rarities = {};
  const namesSet = new Set();
  let totalAmount = 0;

  values.forEach((r) => {
    const cName = String(r[0] || "").trim();
    const cNo = String(r[1] || "").trim().toUpperCase();
    const cRare = String(r[2] || "기본").trim();
    const cQty = parseInt(r[3] || 0);
    const cLoc = String(r[4] || "미보관").trim();
    const cIllust = String(r[5] || "").trim();

    if (cQty > 0 && cNo) {
      allCards.push([cName, cNo, cRare, cQty, cLoc, cIllust]);
      if (cName) namesSet.add(cName);
      
      totalAmount += cQty;
      
      // 위치별 카드 번호 매핑
      if (!locations[cLoc]) locations[cLoc] = [];
      if (!locations[cLoc].includes(cNo)) locations[cLoc].push(cNo);
      
      // 레어도별 수량 집계
      rarities[cRare] = (rarities[cRare] || 0) + cQty;
    }
  });

  return {
    allCards,
    locations,
    rarities,
    amount: totalAmount,
    names: Array.from(namesSet).sort(),
  };
}

module.exports = { fetchMyCardData_Node };
