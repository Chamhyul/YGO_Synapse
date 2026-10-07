const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../public/data-transfer');
const headers = ['카드 이름', '카드 번호', '레어도', '수량', '보관 위치', '일러스트'];
const row = ['쉼표, "따옴표"\n이름', 'AB-KR001', '레어', 7, '서랍, A', '2'];
test('UTF-8 BOM CSV 내보내기를 재입력해 수량·쉼표·인용·개행·일러스트를 보존한다', () => {
  const csv = api.toCsv([row]);
  for (const text of [csv, csv.replace(/^\uFEFF/, '')]) {
    const parsed = api.parseRows(api.parseCsv(text));
    assert.deepEqual(parsed.data, [{ name: row[0], no: row[1], rare: row[2], qty: 7, loc: row[4], illust: '2' }]);
    assert.equal(parsed.totalQty, 7);
  }
});
test('열 순서 변경, 수량 없는 예전 파일, 0장 제외를 구분한다', () => {
  const order = [5, 4, 3, 2, 1, 0];
  const parsed = api.parseRows([order.map(i => headers[i]), order.map(i => row[i]), order.map(i => i === 3 ? 0 : row[i])]);
  assert.equal(parsed.skippedZeroCount, 1);
  assert.equal(parsed.totalQty, 7);
  const noQuantity = api.parseRows([headers.filter((_, i) => i !== 3), row.filter((_, i) => i !== 3)]);
  assert.equal(noQuantity.legacyQuantity, true);
  assert.equal(noQuantity.data[0].qty, 1);
});
test('빈값·음수·소수·텍스트·과도한 수량과 헤더 오류는 전체 가져오기를 거부한다', () => {
  for (const qty of ['', undefined, -1, 1.2, '2장', '1.2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => api.parseRows([headers, [...row.slice(0, 3), qty, ...row.slice(4)]]));
  }
  assert.throws(() => api.parseRows([headers.filter(h => h !== '일러스트'), row]));
  assert.throws(() => api.parseRows([[...headers, '수량'], row]));
  assert.throws(() => api.parseRows([headers, [...row.slice(0, 3), 0, ...row.slice(4)]]), /0인 1개/);
});
test('닫히지 않은 인용 및 인용 후 잘못된 CSV 텍스트를 거부한다', () => {
  for (const csv of ['"unterminated', '"a"x,b', 'a"b,c']) assert.throws(() => api.parseCsv(csv));
});
test('CID로 수록 번호가 다른 카드를 합치고 5종 이후 추가 매수만 집계한다', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ cid: String(i), name: `카드${i}`, qty: i + 1 }));
  items.push({ cid: '0', name: '다른 언어 이름', qty: 3 });
  const result = api.summarize(items);
  assert.equal(result.cardCount, 7);
  assert.equal(result.summary.length, 5);
  assert.equal(result.summary[0].qty, 4);
  assert.equal(result.restQty, 13);
  assert.equal(result.totalQty, 31);
});
