'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('public/script.js', 'utf8');
const cls = source.slice(source.indexOf('class ClientCache {'), source.indexOf('\nconst cardCacheInstance'));
const chosung = source.slice(source.indexOf('const HANGUL_CHOSUNG_LIST'), source.indexOf('// 디바운스', source.indexOf('const HANGUL_CHOSUNG_LIST')));
function fixture() {
    const counts = { normalized: 0, lookups: 0 };
    const context = vm.createContext({ counts, normalizeStr: value => String(value).replace(/\s+/g, '').toLowerCase(),
        refreshLocalLookups() { counts.lookups++; } });
    vm.runInContext(chosung + `
        const originalChosung = getChosung;
        getChosung = value => { counts.normalized++; return originalChosung(value); };
        ${cls}
        this.cache = new ClientCache(); this.chosung = originalChosung;
    `, context);
    return { cache: context.cache, counts, chosung: context.chosung };
}
const row = (name, no, qty = 1, cid = '100', loc = '상자') => [name, no, 'N', qty, loc, '1', cid];
const plain = value => JSON.parse(JSON.stringify(value));
function assertSearch(f, publicNames, rows) {
    const names = [...new Set([...publicNames, ...rows.map(r => String(r[0]).trim()).filter(Boolean)])].sort();
    assert.deepEqual(plain(f.cache.getAllNames()), names);
    assert.deepEqual(plain(f.cache.getAllNamesNormalized()), names.map(original => {
        const normalized = original.replace(/\s+/g, '').toLowerCase();
        return { original, normalized, chosung: f.chosung(normalized) };
    }));
}

test('공개 이름은 계정 전환·로그아웃·보유 수량 수정에서 다시 정규화하지 않는다', () => {
    const f = fixture(), names = Array.from({ length: 2000 }, (_, i) => `공개 카드 ${i}`);
    f.cache.setAllKnownNames(names); assert.equal(f.counts.normalized, names.length);
    const ordered = f.cache.getAllNames(), entries = f.cache.getAllNamesNormalized();
    f.counts.normalized = 0;
    f.cache.setInventorySnapshot([row(names[0], 'A')], 1, {}, {});
    f.cache.updateInventory([{ cardNo: 'A', rarity: 'N', loc: '상자', illustration: '1', qty: 8 }]);
    assert.equal(f.cache.getAmount(), 8);
    f.cache.clearAll(); f.cache.setInventory([row(names[1], 'B', 3, '200')]); f.cache.clearAll();
    assert.equal(f.counts.normalized, 0);
    assert.strictEqual(f.cache.getAllNames(), ordered);
    assert.strictEqual(f.cache.getAllNamesNormalized(), entries);
    assert.equal(f.cache.getInventory().length, 0); assert.equal(f.cache.getOwnedNamesSet().size, 0);
    assert.equal(f.cache.getOwnedNumbersSet().size, 0); assert.equal(f.cache._ownedByCid.size, 0);
    assert.equal(f.cache._inventoryNoToCid.A, undefined); assert.equal(f.cache._inventoryNoToCid.B, undefined);
});

test('공개 목록에 없는 보유 이름도 정렬·중복·공백·초성 검색 의미를 유지한다', () => {
    const f = fixture(), names = ['청안의 백룡', '가나다', ' ABC ', 'ABC', '😀 카드'];
    const rows = [row('사설 별칭', 'A'), row('사설 별칭', 'B'), row(' 청안의 백룡 ', 'C'),
        row('abc', 'D'), row('영수량 별칭', 'E', 0), row('😀 카드', 'F')];
    f.cache.setAllKnownNames(names); f.counts.normalized = 0; f.cache.setInventory(rows);
    assert.equal(f.counts.normalized, 3); assertSearch(f, names, rows);
    assert(f.cache.getAllNamesNormalized().some(x => x.original === '사설 별칭' && x.chosung === 'ㅅㅅㅂㅊ'));
    assert.deepEqual(plain(f.cache.getNosByName('사설 별칭')), ['A', 'B']);
    assert.equal(f.cache.getOwnedNamesSet().has('영수량 별칭'), false);
    const combined = f.cache.getAllNamesNormalized();
    f.counts.normalized = 0;
    f.cache.updateInventory([{ cardNo: 'A', rarity: 'N', loc: '상자', illustration: '1', qty: 9 }]);
    assert.equal(f.counts.normalized, 0); assert.strictEqual(f.cache.getAllNamesNormalized(), combined);
    assertSearch(f, names, rows);
});

test('계정 전환·로그아웃은 이전 계정의 추가 이름·CID·위치·보유 표시를 제거한다', () => {
    const f = fixture(), names = ['공개 카드']; f.cache.setAllKnownNames(names);
    f.cache.setInventory([row('A 계정 별칭', 'A-NO', 2, '101', 'A 위치')]);
    const revision = f.cache._inventoryRevision;
    f.cache.clearAll(); assert(f.cache._inventoryRevision > revision); assertSearch(f, names, []);
    assert.equal(f.cache._inventoryNameToCid['a계정별칭'], undefined);
    assert.equal(f.cache._ownedByCid.has('101'), false); assert.equal(f.cache.getAllLocations().length, 0);
    f.cache.setInventory([row('B 계정 별칭', 'B-NO', 3, '202', 'B 위치')]);
    assertSearch(f, names, [row('B 계정 별칭', 'B-NO')]);
    assert.equal(f.cache.getOwnedNamesSet().has('A 계정 별칭'), false);
    assert.equal(f.cache._inventoryNoToCid['A-NO'], undefined);
    f.cache.clearAll(); assertSearch(f, names, []); assert.equal(f.cache.getAmount(), 0);
});

test('공개 목록의 실제 변경만 색인을 갱신하며 현재 계정의 보유 이름을 보존한다', () => {
    const f = fixture(); f.cache.setAllKnownNames(['가나다', '공개 카드']);
    f.cache.setInventory([row('가나다', 'A'), row('계정 별칭', 'B')]);
    f.counts.normalized = 0;
    const current = f.cache.getAllNamesNormalized(); f.cache.setAllKnownNames(['공개 카드', '가나다', '가나다']);
    assert.equal(f.counts.normalized, 0); assert.strictEqual(f.cache.getAllNamesNormalized(), current);
    f.cache.setAllKnownNames(['새 공개', '계정 별칭']);
    assertSearch(f, ['새 공개', '계정 별칭'], [row('가나다', 'A'), row('계정 별칭', 'B')]);
    f.cache.clearAll(); assertSearch(f, ['새 공개', '계정 별칭'], []);
    f.cache.setAllKnownNames([]); assertSearch(f, [], []);
});

test('부분 삭제·초기화로 사라진 추가 이름은 다음 검색 결과에 남지 않는다', () => {
    const f = fixture(), names = ['공개 카드']; f.cache.setAllKnownNames(names);
    f.cache.setInventory([row('추가 이름', 'A'), row('추가 이름', 'B'), row('마지막 이름', 'C')]);
    f.cache.updateInventory([{ cardNo: 'A', rarity: 'N', loc: '상자', illustration: '1', isDeleted: true }]);
    assert(f.cache.getAllNames().includes('추가 이름'));
    f.cache.updateInventory([{ cardNo: 'B', rarity: 'N', loc: '상자', illustration: '1', isDeleted: true }]);
    assert.equal(f.cache.getAllNames().includes('추가 이름'), false);
    f.cache.setInventorySnapshot([], 0, {}, {}); assertSearch(f, names, []);
});

test('같은 이름의 CID 충돌·CID 교체도 현재 보유 정보만으로 계산한다', () => {
    const f = fixture(); f.cache.setAllKnownNames(['공개 카드']);
    f.cache.setInventory([row('공개 카드', 'A', 1, '100'), row('공개 카드', 'B', 1, '200')]);
    assert.equal(f.cache._inventoryNameToCid['공개카드'], null);
    f.cache.setInventory([row('공개 카드', 'A', 1, '300')]);
    assert.equal(f.cache._inventoryNameToCid['공개카드'], '300'); assert.equal(f.cache._ownedByCid.has('100'), false);
    assert.equal(f.cache._inventoryNoToCid.B, undefined);
});
