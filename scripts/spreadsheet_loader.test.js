const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/spreadsheet-loader.js'), 'utf8');
const api = () => ({ read() {}, utils: { sheet_to_json() {} } });
function fixture() {
    const scripts = [], timers = new Map();
    let id = 0;
    const window = { setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(n) { timers.delete(n); } };
    const document = { createElement() { return { remove() { this.removed = true; } }; }, head: { appendChild(s) { scripts.push(s); } } };
    vm.runInNewContext(source, { window, document });
    return { window, document, scripts, timers, load: window.AppSpreadsheet.load };
}
test('초기 표시에는 Excel CDN을 요청하지 않고 동시 선택은 한 번의 준비를 공유한다', async () => {
    const f = fixture(); assert.equal(f.scripts.length, 0);
    const first = f.load(), second = f.load(); assert.equal(first, second);
    assert.equal(f.scripts.length, 1);
    f.window.XLSX = api(); f.scripts[0].onload();
    assert.equal(await first, f.window.XLSX); assert.equal(await f.load(), f.window.XLSX);
    assert.equal(f.scripts.length, 1); assert.equal(f.timers.size, 0);
});
test('이미 준비된 Excel API는 새 다운로드 없이 재사용한다', async () => {
    const f = fixture(); f.window.XLSX = api(); assert.equal(await f.load(), f.window.XLSX);
    assert.equal(f.scripts.length, 0);
});
test('다운로드 실패·API 누락·시간 초과 뒤 새 선택은 재시도할 수 있다', async () => {
    for (const failure of ['network', 'missing-api', 'timeout']) {
        const f = fixture(), first = f.load();
        const rejected = assert.rejects(first, { code: 'SPREADSHEET_LOAD_FAILED' });
        if (failure === 'network') f.scripts[0].onerror();
        else if (failure === 'missing-api') { f.window.XLSX = {}; f.scripts[0].onload(); }
        else [...f.timers.values()][0]();
        await rejected; assert.equal(f.scripts[0].removed, true); assert.equal(f.timers.size, 0);
        const retry = f.load(); f.window.XLSX = api(); f.scripts[1].onload();
        assert.equal(await retry, f.window.XLSX);
    }
});
test('시간 초과 뒤 늦은 완료는 새 다운로드의 준비 상태를 덮어쓰지 않는다', async () => {
    const f = fixture(), first = f.load(), late = f.scripts[0].onload;
    const rejected = assert.rejects(first, { code: 'SPREADSHEET_LOAD_FAILED' });
    [...f.timers.values()][0](); await rejected;
    const retry = f.load(); late(); assert.equal(f.load(), retry);
    f.window.XLSX = api(); f.scripts[1].onload(); await retry;
});
test('스크립트 삽입 실패도 현재 요청을 종료하고 재시도를 허용한다', async () => {
    const f = fixture(), append = f.document.head.appendChild;
    f.document.head.appendChild = () => { throw new Error('synthetic'); };
    await assert.rejects(f.load(), { code: 'SPREADSHEET_LOAD_FAILED' });
    f.document.head.appendChild = append;
    const retry = f.load(); f.window.XLSX = api(); f.scripts[0].onload(); await retry;
});
