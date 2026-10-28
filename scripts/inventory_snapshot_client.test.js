'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('public/script.js', 'utf8');
const start = source.indexOf('class ClientCache {'), end = source.indexOf('\nconst cardCacheInstance', start);
function fixture() {
  const context = { normalizeStr: x => String(x).replace(/\s+/g, '').toLowerCase(), getChosung: x => x,
    refreshLocalLookups() {}, MasterDB: {}, document: { querySelectorAll: () => [] } };
  vm.createContext(context);
  // 클래스만 사용해 메서드의 실제 집계·위치·CID 인덱스 동작을 검사한다.
  const cls = source.slice(start, end > start ? end : source.indexOf('\n}', start) + 2);
  vm.runInContext(cls + '\nthis.cache=new ClientCache();', context);
  return context.cache;
}
test('전체 보유 응답은 기존 결과와 같으며 집계·검색 인덱스를 한 번만 구성한다', () => {
  const rows = [['합성', ' A ', '기본', 2, '상자', '1', '101'], ['합성', 'B', '레어', 3, '다른 상자', '2', '102']];
  const old = fixture(), next = fixture();
  old.setInventory(rows); old.setSummary(5, { 상자: ['A'] }, { 기본: 5 }); old.rebuildSummaryFromInventory();
  let indexes = 0, summaries = 0;
  const refresh = next.refreshIndexes.bind(next), rebuild = next.rebuildSummaryFromInventory.bind(next);
  next.refreshIndexes = () => { indexes++; return refresh(); };
  next.rebuildSummaryFromInventory = () => { summaries++; return rebuild(); };
  next.setInventorySnapshot(rows, 5, { 상자: ['A'] }, { 기본: 5 });
  for (const read of ['getInventory', 'getAmount', 'getLocationsMap', 'getRaritiesMap', 'getAllNames', 'getOwnedNumbers', 'getAllLocations'])
    assert.equal(JSON.stringify(next[read]()), JSON.stringify(old[read]()), read);
  assert.equal(indexes, 1); assert.equal(summaries, 1);
  assert.equal(next._inventoryRevision, 1); rows[0][3] = 99; assert.equal(next.getInventory()[0][3], 2);
});
test('빈 목록·구형 서버 집계와 후속 수정/초기화도 기존 의미를 유지한다', () => {
  for (const amount of [0, 4]) {
    const a = fixture(), b = fixture(); a.setInventory([]); a.setSummary(amount, { 상자: ['A'] }, { 기본: amount }); a.rebuildSummaryFromInventory();
    b.setInventorySnapshot([], amount, { 상자: ['A'] }, { 기본: amount });
    assert.equal(JSON.stringify(b._summary), JSON.stringify(a._summary));
    b.setInventorySnapshot([['카드', 'A', '기본', 2, '상자', '1', '101']], 2, {}, {});
    const before = b._inventoryRevision;
    b.updateInventory([{ cardNo: 'A', rarity: '기본', loc: '상자', illustration: '1', isDeleted: true }]);
    assert(b._inventoryRevision > before); b.clearAll(); assert.equal(b.getInventory().length, 0); assert.equal(b.getAmount(), 0);
  }
});
