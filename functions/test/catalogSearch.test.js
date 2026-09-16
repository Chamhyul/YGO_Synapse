const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../routes/card.js'), 'utf8');
const handlerSource = source.slice(source.indexOf('exports.resolveCardNames ='), source.indexOf('\nasync function applyInventoryGuard'));
function fixture() {
    const calls = [];
    const c = vm.createContext({ exports: {}, onRequest: (_, handler) => handler, setCors() {},
        verifyAppCheck: async () => true, mapLimited: async (items, fn) => Promise.all(items.map(fn)),
        findCards: async (field, value) => {
            calls.push([field, value]);
            return [{ cid: '123', info: { 0: ['테스트 카드'] }, data: { names: ['테스트 카드'] } }];
        } });
    vm.runInContext(handlerSource, c);
    return { calls, async request(body) {
        const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
        await c.exports.resolveCardNames({ method: 'POST', body }, res);
        return res;
    } };
}
test('기존 이름 조회 응답을 보존하면서 번호의 CID와 카드명을 반환한다', async () => {
    const f = fixture();
    const res = await f.request({ names: ['테스트 카드'], numbers: ['ABCD-KR001'] });
    assert.equal(res.code, 200);
    assert.equal(res.body.results['테스트 카드'][0], '123');
    assert.equal(res.body.numberResults['ABCD-KR001'][0].name, '테스트 카드');
    assert.equal(res.body.metadata['123'][0][0], '테스트 카드');
    assert.deepEqual(f.calls, [['names', '테스트 카드'], ['numbers', 'ABCD-KR001']]);
});
test('이름만 요청하는 기존 클라이언트도 지원한다', async () => {
    const res = await fixture().request({ names: ['테스트 카드'] });
    assert.equal(res.body.success, true);
    assert.equal(res.body.results['테스트 카드'][0], '123');
});
test('합계 40개 제한과 입력 자료형을 검사한다', async () => {
    const f = fixture();
    for (const body of [{ names: Array(40).fill('카드'), numbers: ['ABCD-KR001'] }, { names: '카드' }, { numbers: [42] }]) {
        assert.equal((await f.request(body)).code, 400);
    }
    assert.equal(f.calls.length, 0);
});
