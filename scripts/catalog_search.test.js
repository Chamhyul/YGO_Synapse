const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/catalog-search.js'), 'utf8');
const norm = value => String(value).replace(/\s+/g, '').toLowerCase();
const appSource = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');

function fixture(names = [], numbers = [], owned = []) {
    const context = vm.createContext({ normalizeStr: norm, searchSequence: 1,
        findCidByNameOrNo: () => null, getCardNameByNumber: () => '', cidMetaMemoryCache: new Map(),
        ClientCache: { registerCid() {} }, fetchCardsMetaBatch: async cids => {
            for (const cid of cids) context.cidMetaMemoryCache.set(String(cid), { info: { 10: 1 }, cachedAt: Date.now() });
        },
        mergeCardMetaToCache(cid, data) { context.cidMetaMemoryCache.set(String(cid), { info: data.rawSlot, cachedAt: Date.now() }); },
        CardDataStore: { allCardNamesNormalized: names.map(original => ({ original, normalized: norm(original), chosung: norm(original) })), allCardNumbers: numbers },
        cardCacheInstance: { getOwnedNamesSet: () => new Set(owned), getOwnedNumbersSet: () => new Set(owned),
            getAllNamesNormalized: () => [], getOwnedNumbers: () => [], getInventory: () => [] },
        Hangul: { search: (text, query) => text.indexOf(query) },
    });
    vm.runInContext(source, context);
    return context;
}

test('번호는 공백을 제외한 6자부터, 이름은 길이와 무관하게 검색한다', () => {
    const c = fixture(['ABCDE 카드'], ['ABCDE-001']);
    assert.deepEqual(Array.from(c.collectCatalogMatches('ABCDE'), x => x.type), ['name']);
    assert.deepEqual(Array.from(c.collectCatalogMatches(' ABCDE- '), x => x.val), ['ABCDE-001']);
});

test('CID 응답 전후 모두 CID 없는 보유 행을 포함하고 같은 행을 중복 합산하지 않는다', () => {
    const c = fixture();
    c.cardCacheInstance.getInventory = () => [
        ['카드 A', 'ABC-KR001', '', 2, '서랍', '', '7'],
        ['카드 A', 'ABC-KR002', '', 3, '상자', '', null],
        ['Card A', 'ABC-EN001', '', 4, '상자', '', '7'],
        ['카드 A', 'ABC-KR999', '', 9, '상자', '', '99'],
    ];
    const pending = c.getCatalogQuantityIndexes([{ cid: null, name: '카드 A', number: null }]);
    assert.equal(pending.nameQuantities.get(norm('카드 A')), 14);
    const resolved = c.getCatalogQuantityIndexes([{ cid: '7', name: '카드 A', number: 'ABC-KR002' }]);
    assert.equal(resolved.quantities.get('7'), 9);
    assert.equal(resolved.quantities.get('99'), 9);
});

test('구형 CID 응답은 세부 정보를 보충하고 연결 캐시만 있어도 재확인한다', async () => {
    const c = fixture(['카드 A']);
    let lookup = 0, metadata = 0;
    c.callApi = async () => { lookup++; return { success: true, results: { '카드 A': ['7'] } }; };
    c.fetchCardsMetaBatch = async cids => {
        metadata++;
        c.cidMetaMemoryCache.set('7', { info: { 10: 2 }, cachedAt: Date.now() });
    };
    await c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1);
    assert.equal(c.cidMetaMemoryCache.get('7').info[10], 2);
    c.cidMetaMemoryCache.clear();
    await c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1);
    assert.equal(lookup, 1); assert.equal(metadata, 2);
});

test('동봉된 메타데이터는 실제 캐시 병합과 카드 종류 판독에 반영된다', async () => {
    const c = fixture(['카드 A']);
    vm.runInContext(appSource.slice(appSource.indexOf('function mergeCardMetaToCache('),
        appSource.indexOf('async function fetchCardMetaWithCache(')), c);
    c.callApi = async () => ({ success: true, results: { '카드 A': ['7'] }, metadata: { '7': { 0: ['카드 A', [], {}], 10: 2 } } });
    c.fetchCardsMetaBatch = async () => { throw new Error('중복 조회'); };
    await c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1);
    assert.equal(c.parseMetaKind(c.cidMetaMemoryCache.get('7')).kindStr, '함정');
});

test('이름 100개·번호 50개 이후에도 검색하고 보유 우선 순위를 적용한다', () => {
    const names = Array.from({ length: 120 }, (_, i) => `abcdef 카드 ${i}`);
    const numbers = Array.from({ length: 80 }, (_, i) => `ABCDEF-${i}`);
    const c = fixture(names, numbers, [names[119], numbers[79]]);
    const found = c.collectCatalogMatches('abcdef');
    assert.equal(found.length, 200);
    assert.ok(found.slice(0, 2).every(x => x.isOwned));
    assert.ok(found.some(x => x.val === numbers[79]));
});

test('번호 목록 갱신 시 정규화 캐시도 새 목록을 따른다', () => {
    const c = fixture([], ['ABCDEF-001']);
    assert.equal(c.collectCatalogMatches('abcdef').length, 1);
    c.CardDataStore.allCardNumbers = ['ABCDEF-002', 'ABCDEF-003'];
    assert.equal(c.collectCatalogMatches('abcdef').length, 2);
});

test('이름과 번호가 겹쳐도 CID당 하나이며 각 필터의 일치 상태를 보존한다', () => {
    const c = fixture();
    const matches = [{ type: 'name', val: '카드 A' }, { type: 'number', val: 'ABCDEF-001' }, { type: 'name', val: '미보유 카드' }];
    const links = new Map([['name:카드 A', [{ cid: '1', name: '카드 A' }]],
        ['number:ABCDEF-001', [{ cid: '1', name: '카드 A' }]],
        ['name:미보유 카드', [{ cid: '2', name: '미보유 카드' }]]]);
    const items = c.groupCatalogResults(matches, links);
    assert.equal(items.length, 2);
    assert.equal(items[0].nameMatch, true);
    assert.equal(items[0].numberMatch, true);
    assert.equal(items[0].number, 'ABCDEF-001');
    assert.equal(items[1].cid, '2');
});

test('전체 후보를 40개 단위로 연결하고 다음 검색에서 연결 캐시를 재사용한다', async () => {
    const c = fixture(Array.from({ length: 85 }, (_, i) => `카드 ${i}`));
    const calls = [];
    c.callApi = async (_, params, body) => {
        calls.push(body.names.length + body.numbers.length);
        return { success: true, results: Object.fromEntries(body.names.map(n => [n, [n]])), numberResults: {} };
    };
    const matches = c.collectCatalogMatches('카드');
    assert.equal((await c.resolveCatalogMatches(matches, 1)).length, 85);
    assert.deepEqual(calls, [40, 40, 5]);
    await c.resolveCatalogMatches(matches, 1);
    assert.equal(calls.length, 3);
});

test('늦게 도착한 이전 검색 응답은 결과에 반영하지 않는다', async () => {
    const c = fixture(['카드']);
    c.callApi = async () => { c.searchSequence = 2; return { success: true, results: { 카드: ['1'] } }; };
    assert.equal(await c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1), null);
});

test('번호 조회 API가 준비되지 않았으면 빈 검색 결과로 오인하지 않는다', async () => {
    const c = fixture([], ['ABCDEF-001']);
    c.callApi = async () => ({ success: true, results: {} });
    await assert.rejects(c.resolveCatalogMatches(c.collectCatalogMatches('abcdef'), 1), /다시 시도/);
});

test('필터·표시 수량 변경은 첫 페이지로 이동하고 별도 상세 조회를 하지 않는다', async () => {
    const c = fixture();
    const area = element();
    function element() {
        return { children: [], className: '', attributes: {},
            set innerHTML(value) { this.children = []; this.html = value; },
            appendChild(child) { this.children.push(child); },
            setAttribute(key, value) { this.attributes[key] = value; },
            focus() {}, querySelector() { return element(); } };
    }
    const batches = [];
    Object.assign(c, { document: { getElementById: () => area, createElement: element },
        escapeHTML: x => x, updateSearchHash() {}, closeDropdowns() {}, cidMetaMemoryCache: new Map(),
        fetchCardsMetaBatch: async ids => { batches.push(ids.length); } });
    const state = { items: Array.from({ length: 65 }, (_, i) => ({ cid: String(i), name: `카드 ${i}`, nameMatch: i < 25, numberMatch: i >= 25 })),
        query: '카드', filter: 'auto', page: 2, pageSize: 20 };
    c.renderCatalogResults(state);
    assert.equal(area.children[1].children.length, 20);
    area.children[0].children[0].children[1].onclick();
    assert.equal(state.filter, 'name'); assert.equal(state.page, 1);
    const size = area.children[0].children[1];
    size.children[0].children[0].children[1].onclick();
    assert.equal(state.pageSize, 50); assert.equal(area.children[1].children.length, 25);
    assert.deepEqual(batches, []);
});

test('DB 응답 전에 로컬 결과를 표시하고 실패하더라도 목록을 유지한다', async () => {
    const c = fixture(['카드 A', '카드 B']);
    const renders = [];
    let fail;
    Object.assign(c, { UIStore: { mode: 'home' }, switchToMode(mode) { c.UIStore.mode = mode; },
        renderCatalogResults: state => renders.push({ count: state.items.length, pending: state.pending, error: state.error }),
        refreshPublicDataQuietly: async () => {}, callApi: () => new Promise((_, reject) => { fail = reject; }) });
    const pending = c.showCatalogSearch('카드', 'auto', 1, true);
    assert.equal(renders[0].count, 2);
    assert.equal(renders[0].pending, true);
    fail(new Error('오프라인')); await pending;
    assert.equal(renders.at(-1).count, 2);
    assert.equal(renders.at(-1).pending, false);
    assert.match(renders.at(-1).error, /그대로 표시/);
});

test('CID와 메타데이터 응답이 함께 반영되고 중복 카드가 합쳐진다', async () => {
    const c = fixture(['abcdef 카드'], ['ABCDEF-001']);
    const updates = [];
    let reply;
    c.callApi = () => new Promise(resolve => { reply = resolve; });
    const pending = c.resolveCatalogMatches(c.collectCatalogMatches('abcdef'), 1, items => updates.push(items));
    assert.equal(updates[0].length, 2);
    reply({ success: true, results: { 'abcdef 카드': ['7'] },
        numberResults: { 'ABCDEF-001': [{ cid: '7', name: 'abcdef 카드' }] },
        metadata: { '7': { 0: ['abcdef 카드'], 10: 1 } } });
    const items = await pending;
    assert.equal(items.length, 1);
    assert.equal(items[0].nameMatch, true);
    assert.equal(items[0].numberMatch, true);
    assert.equal(c.cidMetaMemoryCache.get('7').info[10], 1);
    assert.equal(updates.at(-1).length, 1);
});

test('로컬 CID와 최신 메타데이터가 있으면 즉시 합치고 DB 요청을 생략한다', async () => {
    const c = fixture(['abcdef 카드'], ['ABCDEF-001']);
    c.findCidByNameOrNo = () => '7';
    c.cidMetaMemoryCache.set('7', { name: 'abcdef 카드', info: { 10: 1 }, cachedAt: Date.now() });
    c.callApi = () => { throw new Error('DB 요청 금지'); };
    const items = await c.resolveCatalogMatches(c.collectCatalogMatches('abcdef'), 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 'ABCDEF-001');
});

test('이전 검색 응답은 새 검색 결과를 덮어쓰지 않는다', async () => {
    const c = fixture(['카드 A', '카드 B']);
    const replies = [];
    const renders = [];
    Object.assign(c, { UIStore: { mode: 'search' }, renderCatalogResults: state => renders.push(state.query),
        refreshPublicDataQuietly: async () => {}, callApi: () => new Promise(resolve => replies.push(resolve)) });
    const first = c.showCatalogSearch('카드 A', 'auto', 1, true);
    c.searchSequence = 2;
    const second = c.showCatalogSearch('카드 B', 'auto', 2, true);
    replies[0]({ success: true, results: { '카드 A': ['1'] } }); await first;
    assert.deepEqual(renders, ['카드 A', '카드 B']);
    replies[1]({ success: true, results: { '카드 B': ['2'] } }); await second;
    assert.equal(renders.at(-1), '카드 B');
});

test('데스크톱 Enter는 강조된 추천이나 드롭다운 표시 여부와 무관하게 입력어를 검색한다', () => {
    const begin = appSource.indexOf("        searchInput.addEventListener('keydown', function (e) {");
    const end = appSource.indexOf("        searchInput.addEventListener('blur'", begin);
    let keydown;
    const calls = [];
    const input = { value: '입력어', blur() {}, addEventListener(_, fn) { keydown = fn; } };
    const list = { style: { display: 'block' }, querySelectorAll: () => [{ dataset: { val: '다른 추천' } }] };
    vm.runInNewContext(appSource.slice(begin, end), { searchInput: input,
        document: { getElementById: () => list }, UIStore: { dropdownFocus: 0 },
        startSearch: (...args) => calls.push(args) });
    for (const display of ['block', 'none']) {
        list.style.display = display;
        keydown.call(input, { key: 'Enter', preventDefault() {} });
    }
    assert.equal(input.value, '입력어');
    assert.deepEqual(calls, [[false, 'auto', false], [false, 'auto', false]]);
    keydown.call(input, { key: 'Enter', isComposing: true });
    assert.equal(calls.length, 2);
});

test('언어·표시 수량은 같은 드롭다운 열기, 닫기, 키보드 선택 동작을 사용한다', () => {
    const frames = [];
    function wrapper() {
        const classes = new Set();
        const button = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, focus() { this.focused = true; } };
        const options = Array.from({ length: 3 }, () => ({ focus() { this.focused = true; }, click() { this.selected = true; } }));
        return { button, options, height: '',
            classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x) },
            style: { setProperty(k, value) { this[k] = value; } },
            querySelector: selector => selector === '.region-capsule' ? button : { scrollHeight: 120 },
            querySelectorAll: () => options };
    }
    const region = wrapper(), size = wrapper();
    const c = vm.createContext({ document: { getElementById: () => region,
        querySelectorAll: () => [region, size].filter(w => w.classList.contains('active')) },
        requestAnimationFrame: fn => frames.push(fn) });
    for (const name of ['closeDropdowns', 'toggleRegionDropdown', 'handleRegionButtonKeydown', 'handleRegionOptionKeydown']) {
        const start = appSource.indexOf(`function ${name}(`);
        const end = appSource.indexOf('\nfunction ', start + 1);
        vm.runInContext(appSource.slice(start, end), c);
    }
    const event = { stopPropagation() {}, preventDefault() {} };
    c.toggleRegionDropdown(event);
    assert.equal(region.button.attributes['aria-expanded'], 'true');
    c.toggleRegionDropdown(event, size);
    assert.equal(region.button.attributes['aria-expanded'], 'false');
    assert.equal(size.button.attributes['aria-expanded'], 'true');
    frames.forEach(fn => fn());
    assert.equal(region.style['--region-dropdown-height'], '0px');
    assert.equal(size.style['--region-dropdown-height'], '120px');
    c.handleRegionButtonKeydown({ ...event, key: 'ArrowDown' }, size);
    assert.equal(size.options[0].focused, true);
    c.handleRegionOptionKeydown({ ...event, key: 'Enter', target: { closest: () => size.options[0] } }, size);
    assert.equal(size.options[0].selected, true);
    c.handleRegionButtonKeydown({ ...event, key: 'Escape' }, size);
    assert.equal(size.button.attributes['aria-expanded'], 'false');
});
