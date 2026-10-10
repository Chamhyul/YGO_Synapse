const sheets = require("../integrations/googleSheets");
const { createHash } = require('node:crypto');
const headers = ['카드 이름', '카드 번호', '레어도', '수량', '보관 위치', '일러스트'];
const text = value => String(value ?? '').trim();
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_IMPORT' });

// 파일·시트 모두 저장 전에 전체 행을 검증한다. 없는 수량 열과 빈 수량은 구분한다.
function validateImportData(data) {
  if (!Array.isArray(data) || !data.length) throw invalid('가져올 카드가 없습니다.');
  const items = [];
  let skippedZeroCount = 0, legacyQuantity = false, totalQty = 0;
  data.forEach((item, index) => {
    if (!item || typeof item !== 'object') throw invalid(`${index + 1}번째 항목이 올바르지 않습니다.`);
    const absent = !Object.hasOwn(item, 'qty');
    legacyQuantity ||= absent;
    const value = absent ? 1 : item.qty;
    const qty = typeof value === 'number' ? value : /^\d+$/.test(text(value)) ? Number(text(value)) : NaN;
    if (!Number.isSafeInteger(qty) || qty < 0) throw invalid(`${index + 1}번째 항목의 수량은 0 이상의 정수여야 합니다.`);
    if (!qty) { skippedZeroCount++; return; }
    const name = text(item.name), no = text(item.no).toUpperCase();
    if (!name || !no) throw invalid(`${index + 1}번째 항목의 카드 이름과 번호를 확인해주세요.`);
    totalQty += qty;
    if (!Number.isSafeInteger(totalQty)) throw invalid('총수량이 지원 범위를 초과했습니다.');
    items.push({ name, no, rare: text(item.rare) || '기본', qty,
      loc: text(item.loc) || '미보관', illust: text(item.illust) || '1' });
  });
  if (!items.length) throw invalid(`가져올 카드가 없습니다. 수량 0인 ${skippedZeroCount}개 행을 제외했습니다.`);
  return { data: items, skippedZeroCount, legacyQuantity, totalQty };
}

function parseMyCardRows(values) {
  if (!values.length) throw invalid('MyCard 시트에 데이터가 없습니다.');
  const names = values[0].map(value => text(value).replace(/^\uFEFF/, ''));
  const missing = headers.filter(name => name !== '수량' && !names.includes(name));
  if (missing.length) throw invalid(`필수 항목이 누락되었습니다: ${missing.join(', ')}`);
  for (const name of headers) {
    if (names.indexOf(name) !== names.lastIndexOf(name)) throw invalid(`중복된 열을 확인해주세요: ${name}`);
  }
  const column = Object.fromEntries(headers.map(name => [name, names.indexOf(name)]));
  const raw = values.slice(1).filter(row => row.some(value => text(value) !== '')).map(row => {
    const item = { name: row[column['카드 이름']], no: row[column['카드 번호']], rare: row[column['레어도']],
      loc: row[column['보관 위치']], illust: row[column['일러스트']] };
    if (column['수량'] >= 0) item.qty = row[column['수량']];
    return item;
  });
  return validateImportData(raw);
}

async function migrationFetchPublicMyCardData(spreadsheetId) {
  const values = await sheets.sheetsReadPublicMyCardRows(spreadsheetId);
  const parsed = parseMyCardRows(values);
  const locations = Object.create(null), rarities = Object.create(null), names = new Set();
  const allCards = parsed.data.map(item => {
    names.add(item.name);
    if (!locations[item.loc]) locations[item.loc] = [];
    if (!locations[item.loc].includes(item.no)) locations[item.loc].push(item.no);
    rarities[item.rare] = (rarities[item.rare] || 0) + item.qty;
    return [item.name, item.no, item.rare, item.qty, item.loc, item.illust];
  });
  return { ...parsed, allCards, locations, rarities, amount: parsed.totalQty, names: [...names].sort(),
    fingerprint: createHash('sha256').update(JSON.stringify(values)).digest('hex') };
}
module.exports = { migrationFetchPublicMyCardData, parseMyCardRows, validateImportData };
