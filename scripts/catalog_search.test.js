const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const CatalogFilters = require('../public/catalog-filters.js');
const source = fs.readFileSync(path.join(__dirname, '../public/catalog-search.js'), 'utf8');
const norm = value => String(value).replace(/\s+/g, '').toLowerCase();
const appSource = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');

function fixture(names = [], numbers = [], owned = []) {
    const context = vm.createContext({ CatalogFilters, URLSearchParams, normalizeStr: norm, searchSequence: 1,
        findCidByNameOrNo: () => null, getCardNameByNumber: () => '', cidMetaMemoryCache: new Map(),
        ClientCache: { registerCid() {} }, fetchCardsMetaBatch: async cids => {
            for (const cid of cids) context.cidMetaMemoryCache.set(String(cid), { info: { 10: 1 }, cachedAt: Date.now() });
            return Object.fromEntries(cids.map(cid => [String(cid), context.cidMetaMemoryCache.get(String(cid))]));
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
        return { '7': c.cidMetaMemoryCache.get('7') };
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
    assert.match(renders.at(-1).error, /일부 카드/);
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

function domFixture(mobile = false) {
    const c = fixture();
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this._text = '';
            this.className = ''; this.listeners = {}; this.style = { removeProperty(key) { delete this[key]; } };
            this.classList = { contains: name => this.className.split(' ').includes(name),
                toggle: (name, force) => { const classes = new Set(this.className.split(' ').filter(Boolean));
                    if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); },
                add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false) };
        }
        set textContent(value) { this._text = String(value); this.replaceChildren(); }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        get isConnected() { return this === body || !!this.parentNode?.isConnected; }
        get lastElementChild() { return this.children.at(-1) || null; }
        getBoundingClientRect() { return {left:0,top:0,bottom:100,width:100,height:100}; }
        appendChild(child) { return this.insertBefore(child, null); }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        prepend(...children) { [...children].reverse().forEach(child => this.insertBefore(child, this.children[0] || null)); }
        insertBefore(child, before) {
            child.remove(); const at = before ? this.children.indexOf(before) : -1;
            if (at >= 0) this.children.splice(at, 0, child); else this.children.push(child);
            child.parentNode = this; return child;
        }
        remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
        replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        removeAttribute(key) { delete this.attributes[key]; }
        getAttribute(key) { return this.attributes[key] ?? null; }
        addEventListener(key, listener) { (this.listeners[key] ||= []).push(listener); }
        focus() { c.document.activeElement = this; }
        scrollIntoView() { this.scrolledIntoView = true; }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        querySelectorAll(selector) {
            const found = [];
            const matches = node => selector.startsWith('[data-') ? Object.hasOwn(node.dataset, selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())) : selector.startsWith('.') ? node.classList.contains(selector.slice(1))
                : selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName === selector.toUpperCase();
            const visit = node => { for (const child of node.children) { if (matches(child)) found.push(child); visit(child); } };
            visit(this); return found;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        click(extra = {}) { if (!this.disabled) this.onclick?.({ button: 0, currentTarget: this, target: this, preventDefault() {}, ...extra }); }
    }
    const body = new Element('body'), area = new Element('div'); area.id = 'result-area'; body.appendChild(area);
    const html = new Element('html'); if (mobile) html.classList.add('is-mobile-device');
    const document = { body, documentElement: html, activeElement: body,
        createElement: tag => new Element(tag), createElementNS: (_,tag) => new Element(tag), getElementById: id => body.querySelector(`#${id}`), addEventListener() {} };
    Object.assign(c, { document, requestAnimationFrame: callback => callback(), updateSearchHash() {}, closeDropdowns() {},
        openManagedSheet(root) { root.hidden = false; }, closeManagedSheet(root) { root.hidden = true; },
        saveRecentSearch() {}, renderTargetByCid() {}, startSearch() {} });
    const state = { type: 'broad', items: Array.from({ length: 65 }, (_, i) => ({ cid: String(i), name: `카드 ${i}`, nameMatch: i < 25, numberMatch: i >= 25 })),
        query: '카드', filter: 'auto', page: 2, pageSize: 20, pending: false };
    c.matchKorean = (text,query) => norm(text).includes(norm(query));
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/filter-editor.js'),'utf8'),c);
    c.renderCatalogResults(state);
    return { c, area, body, state };
}

test('필터·표시 수량을 변경해도 toolbar/status/현재 행 DOM과 편집기는 유지한다', () => {
    const { c, area, body, state } = domFixture();
    const toolbar = area.querySelector('.catalog-search-toolbar'), status = area.querySelector('.catalog-search-progress');
    assert.equal(area.querySelector('.catalog-search-list').children.length, 20);
    assert.equal(c.applyCatalogFilter(state, 'target', ['name']), null);
    assert.equal(state.page, 1); assert.equal(state.filter, 'name');
    assert.equal(area.querySelector('.catalog-search-toolbar'), toolbar);
    assert.equal(area.querySelector('.catalog-search-progress'), status);
    const link = area.querySelector('.catalog-search-row');
    const trigger = area.querySelector('.catalog-search-chip__edit');
    trigger.click();
    const editor = body.querySelector('#catalog-filter-editor');
    const checkbox = editor.querySelector('input'); checkbox.focus();
    c.renderCatalogResults(state);
    assert.equal(editor.querySelector('input'), checkbox); assert.equal(c.document.activeElement, checkbox);
    assert.equal(area.querySelector('.catalog-search-row'), link);
    toolbar.querySelector('.region-dropdown-list').children[1].click();
    assert.equal(state.pageSize, 50); assert.equal(state.page, 1);
    assert.equal(area.querySelector('.catalog-search-list').children.length, 25);
    assert.equal(area.querySelector('.catalog-search-page').tagName, 'SPAN');
});

test('전체 후보를 필터링하며 미확정 항목은 0건 확정 안내에 섞지 않는다', () => {
    const { c, area, state } = domFixture();
    for (const item of state.items.slice(40)) c.cidMetaMemoryCache.set(item.cid, { info: { 10: 0, 13: 1 } });
    c.applyCatalogFilter(state, 'attribute', ['light']);
    state.pending = true; c.renderCatalogResults(state);
    assert.equal(area.querySelector('.catalog-search-total').textContent, '확인된 25장');
    assert.equal(area.querySelector('.catalog-search-list').children.length, 20);
    assert.match(area.querySelector('.catalog-search-loading').textContent, /40장 대기/);
    assert.equal(area.querySelector('.catalog-search-list').getAttribute('aria-busy'), 'true');
    state.pending = false; state.error = 'failed'; c.renderCatalogResults(state);
    assert.match(area.querySelector('.catalog-search-progress').textContent, /40장의 조건 확인 불가/);
    assert.equal(area.querySelector('.catalog-search-list').getAttribute('aria-busy'), 'false');
});

for (const mobile of [false, true]) {
    test(`${mobile ? '모바일' : '데스크톱'} 조회 중에는 필터 자리의 live 안내만 표시하고 완료·실패 후 같은 칩으로 복구한다`, () => {
        const { c, area, body, state } = domFixture(mobile);
        c.applyCatalogFilter(state, 'target', ['name']);
        const filterArea = area.querySelector('.catalog-search-filter-area');
        const desktopChips = area.querySelector('.catalog-search-filters');
        const mobileChips = area.querySelector('.catalog-search-filters--mobile');
        const activeChips = mobile ? mobileChips : desktopChips;
        const trigger = activeChips.querySelector('.catalog-search-chip__edit');
        const loading = area.querySelector('.catalog-search-loading');
        const status = area.querySelector('.catalog-search-progress');
        const storedFilters = JSON.stringify(state.filters);
        const storedAdded = JSON.stringify(state.addedFilters);
        assert.ok(filterArea.contains(desktopChips) && filterArea.contains(mobileChips));
        assert.equal(loading.parentNode, filterArea, '진행 안내가 필터 컨트롤과 같은 영역을 사용한다');
        assert.equal(loading.getAttribute('role'), 'status');
        assert.equal(loading.getAttribute('aria-live'), 'polite');
        assert.equal(loading.hidden, true);

        for (const error of ['', '조회 실패']) {
            state.error = ''; state.pending = true; c.renderCatalogResults(state);
            assert.equal(desktopChips.hidden, true);
            assert.equal(mobileChips.hidden, true);
            assert.equal(loading.hidden, false);
            assert.equal(status.hidden, true, '필터 자리 아래에 별도 진행 안내를 중복하지 않는다');
            assert.match(loading.textContent, /확인 중/);
            assert.equal(area.querySelector('.catalog-search-list').getAttribute('aria-busy'), 'true');
            for (let node = loading; node; node = node.parentNode) {
                assert.notEqual(node.getAttribute('aria-busy'), 'true', 'live 안내는 갱신을 기다리는 결과 목록 밖에 둔다');
            }
            trigger.click();
            c.openCatalogFilterEditor(state, 'add', trigger);
            assert.ok(!body.querySelector('#catalog-filter-editor') || body.querySelector('#catalog-filter-editor').hidden);
            assert.match(c.applyCatalogFilter(state, 'target', ['number']), /확인.*뒤/);
            assert.equal(JSON.stringify(state.filters), storedFilters);
            assert.equal(JSON.stringify(state.addedFilters), storedAdded);

            state.pending = false; state.error = error; c.renderCatalogResults(state);
            assert.equal(loading.hidden, true);
            assert.equal(desktopChips.hidden, false);
            assert.equal(mobileChips.hidden, false);
            assert.equal(activeChips.querySelector('.catalog-search-chip__edit'), trigger);
            assert.equal(JSON.stringify(state.filters), storedFilters);
            assert.equal(JSON.stringify(state.addedFilters), storedAdded);
            assert.equal(status.hidden, false);
            assert.equal(status.classList.contains('visually-hidden'), !error);
            if (error) assert.match(status.textContent, /확인하지 못/);
            trigger.click();
            assert.equal(body.querySelector('#catalog-filter-editor').hidden, false, '완료와 실패 후 모두 편집을 다시 열 수 있다');
            c.closeCatalogFilterEditor();
        }
    });
}

test('필터 초안은 닫기로 버리고 적용으로만 확정하며 대상이 없으면 적용 불가', () => {
    const {c,body,area,state}=domFixture(); const trigger=area.querySelector('.catalog-search-chip__edit');trigger.click();
    const editor=body.querySelector('#catalog-filter-editor');let inputs=editor.querySelectorAll('input');
    inputs[0].checked=false;inputs[0].onchange();c.closeCatalogFilterEditor();
    assert.deepEqual(Array.from(state.filters.target),['name','number']);
    trigger.click();inputs=editor.querySelectorAll('input');inputs[1].checked=false;inputs[1].onchange();
    const apply=editor.querySelector('.ui-overlay__footer').children[0];apply.click();assert.deepEqual(Array.from(state.filters.target),['name']);
    trigger.click();const header=editor.querySelector('.ui-overlay__header');header.children[1].children[0].click();
    assert.deepEqual(Array.from(state.filters.target),['name']);assert.equal(apply.disabled,true);
    assert.equal(editor.querySelector('.ui-overlay__footer').children.length,1);
});
test('모바일 특성은 별도 편집창이며 다른 종류의 적용값을 유지한다',()=>{
 const {c,body,area,state}=domFixture(true);const chips=area.querySelector('.catalog-search-filters--mobile');
 assert.equal(chips.children.length,11);
 c.applyCatalogFilter(state,'monster',{values:['effect'],operator:'and'});
 const trigger=chips.children.find(node=>node.dataset.filterKey==='spell').children[0];c.openCatalogFilterEditor(state,'spell',trigger);
 const editor=body.querySelector('#catalog-filter-editor');const inputs=editor.querySelectorAll('input');const quick=inputs.find(input=>input.value==='quick');quick.checked=true;quick.onchange();
 editor.querySelector('.ui-overlay__footer').children[0].click();
 assert.deepEqual(Array.from(state.filters.spell.values),['quick']);assert.deepEqual(Array.from(state.filters.monster.values),['effect']);
 c.applyCatalogFilter(state,'kind',['spell']);assert.deepEqual(chips.children.map(node=>node.dataset.filterKey),['target','kind','spell']);
 c.applyCatalogFilter(state,'kind',['monster']);assert.ok(chips.children.some(node=>node.dataset.filterKey==='monster'));assert.deepEqual(Array.from(state.filters.monster.values),['effect']);
});

test('데스크톱 칩 삭제와 기본 대상 초기화는 즉시 적용하고 수정키 링크 클릭은 그대로 둔다', () => {
    const { c, area, state } = domFixture();
    c.applyCatalogFilter(state, 'kind', ['monster']);
    c.applyCatalogFilter(state, 'attribute', ['dark']);
    c.applyCatalogFilter(state, 'kind', ['spell']);
    const chips = area.querySelector('.catalog-search-filters').querySelectorAll('.catalog-search-chip');
    const attribute = chips.find(chip => chip.dataset.filterKey === 'attribute');
    assert.equal(attribute.children[0].disabled, true);
    assert.equal(!!attribute.hidden, false, '데스크톱은 비활성 필터를 숨기지 않는다');
    attribute.children[1].click();
    assert.deepEqual(Array.from(state.filters.attribute), []); assert.equal(state.addedFilters.includes('attribute'), false);
    c.applyCatalogFilter(state, 'kind', []);
    c.applyCatalogFilter(state, 'target', ['name']);
    area.querySelector('.catalog-search-chip__remove').click();
    assert.deepEqual(Array.from(state.filters.target), []);
    const link = area.querySelector('.catalog-search-row'); let prevented = false;
    link.click({ ctrlKey: true, preventDefault() { prevented = true; } }); assert.equal(prevented, false);
    assert.match(link.href, /^#search\?cid=/);
});

test('부분 메타를 보충한 완료 응답만 실제 값 없음으로 판정하고 실패한 캐시를 완료 처리하지 않는다', async () => {
    const c = fixture(['카드 A']);
    c.findCidByNameOrNo = () => '7';
    c.cidMetaMemoryCache.set('7', { info: { 10: 0 }, cachedAt: Date.now() });
    const state = CatalogFilters.create(); state.attack = { from: 0, to: 0 };
    const card = { cid: '7', nameMatch: true };
    assert.equal(CatalogFilters.evaluate(card, state, c.getCatalogNormalizedMeta(card)), 'pending');
    c.fetchCardsMetaBatch = async () => ({});
    await assert.rejects(c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1));
    assert.equal(CatalogFilters.evaluate(card, state, c.getCatalogNormalizedMeta(card)), 'pending');
    c.fetchCardsMetaBatch = async () => ({ '7': c.cidMetaMemoryCache.get('7') });
    await c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1);
    assert.equal(CatalogFilters.evaluate(card, state, c.getCatalogNormalizedMeta(card)), 'miss');
});

test('한 이름 조회 묶음이 실패해도 뒤 묶음까지 확인하고 부분 결과를 유지한다', async () => {
    const c = fixture(Array.from({ length: 85 }, (_, i) => `카드 ${i}`));
    let calls = 0; const progress = [];
    c.callApi = async (_, params, body) => {
        calls++;
        if (calls === 1) throw new Error('첫 묶음 실패');
        return { success: true, results: Object.fromEntries(body.names.map(name => [name, [name]])),
            metadata: Object.fromEntries(body.names.map(name => [name, { 10: 0, 11: [0] }])) };
    };
    await assert.rejects(c.resolveCatalogMatches(c.collectCatalogMatches('카드'), 1, items => progress.push(items)), /첫 묶음/);
    assert.equal(calls, 3);
    assert.equal(progress.at(-1).filter(item => item.cid).length, 45);
    assert.equal(progress.at(-1).length, 85);
});

test('목록 복귀 후 미완료 조회를 재개해도 적용 필터·페이지·표시 수량을 초기화하지 않는다', async () => {
    const c = fixture(Array.from({ length: 65 }, (_, i) => `카드 ${i}`));
    const state = { type: 'broad', query: '카드', items: [], filters: CatalogFilters.create(), addedFilters: ['target', 'kind'],
        page: 2, pageSize: 50, pending: true };
    state.filters.kind = ['monster'];
    const renders = [];
    Object.assign(c, { lastSearchState: state, UIStore: { mode: 'search' }, renderCatalogResults: () => renders.push(true),
        callApi: async (_, params, body) => ({ success: true, results: Object.fromEntries(body.names.map(name => [name, [name]])),
            metadata: Object.fromEntries(body.names.map(name => [name, { 10: 0, 11: [0] }])) }) });
    await c.resumeCatalogSearch(state, 1);
    assert.deepEqual(state.filters.kind, ['monster']); assert.equal(state.page, 2); assert.equal(state.pageSize, 50);
    assert.equal(state.items.length, 65); assert.equal(state.pending, false); assert.ok(renders.length > 0);
});

test('메타데이터 force 보충은 부분 캐시를 조회하며 실패한 100개 묶음 뒤의 성공만 반환한다', async () => {
    const c = fixture();
    const begin = appSource.indexOf('async function fetchCardsMetaBatch(');
    const end = appSource.indexOf('\n/**', begin);
    vm.runInContext(appSource.slice(begin, end), c);
    c.console = { warn() {} };
    let calls = 0;
    c.callApi = async (_, params, body) => {
        calls++;
        if (calls === 1) throw new Error('첫 묶음 실패');
        return { success: true, results: Object.fromEntries(body.cids.map(cid => [cid, { 10: 0 }])) };
    };
    const cids = Array.from({ length: 105 }, (_, i) => String(i));
    cids.forEach(cid => c.cidMetaMemoryCache.set(cid, { info: { 10: 0 }, cachedAt: Date.now() }));
    const response = await c.fetchCardsMetaBatch(cids, { force: true });
    assert.equal(calls, 2); assert.equal(Object.keys(response).length, 5);
    assert.equal(Object.hasOwn(response, '0'), false); assert.ok(response['104']);
});

test('CID를 확인하지 못한 로컬 후보를 확정 카드 총수로 표시하지 않는다', () => {
    const { c, area, state } = domFixture();
    state.items = [{ cid: '7', name: '연결된 카드', nameMatch: true }, { cid: null, name: '미확인 이름', nameMatch: true }];
    state.error = '부분 실패'; state.page = 1;
    c.renderCatalogResults(state);
    assert.equal(area.querySelector('.catalog-search-total').textContent, '확인된 1장');
    assert.match(area.querySelector('.catalog-search-progress').textContent, /미확인 후보 1개/);
    assert.equal(area.querySelector('.catalog-search-list').children.length, 2, '필터 없는 로컬 후보는 계속 표시');
});


test('정상 확정 총수의 live 상태는 시각적으로 중복하지 않고 진행·오류 때만 노출한다', () => {
    const { c, area, state } = domFixture();
    const status = area.querySelector('.catalog-search-progress');
    assert.equal(status.classList.contains('visually-hidden'), true);
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(status.textContent, '총 65장');
    state.pending = true; c.renderCatalogResults(state);
    assert.equal(status.hidden, true);
    assert.equal(area.querySelector('.catalog-search-loading').hidden, false);
    assert.match(area.querySelector('.catalog-search-loading').textContent, /확인 중/);
    state.pending = false; state.error = '조회 실패'; c.renderCatalogResults(state);
    assert.equal(status.hidden, false);
    assert.equal(status.classList.contains('visually-hidden'), false);
    state.error = ''; c.renderCatalogResults(state);
    assert.equal(status.classList.contains('visually-hidden'), true);
});


test('특성 OR/AND 스위치는 적용 전 초안에만 반영하고 기존 입력 노드를 유지한다',()=>{
 const {c,body,area,state}=domFixture(true);c.openCatalogFilterEditor(state,'monster',area.querySelector('.catalog-search-chip__edit'));
 const editor=body.querySelector('#catalog-filter-editor');const toggle=editor.querySelectorAll('input').find(input=>input.getAttribute('role')==='switch');
 toggle.focus();toggle.checked=true;toggle.onchange();assert.equal(c.document.activeElement,toggle);assert.equal(state.filters.monster.operator,'or');
});

function inventoryFixture(mobile=false) {
 const {c,body}=domFixture(mobile);
 for (const id of ['inventory-filter-popup','mobile-grid-filter-sheet','grid-filter-sheet-overlay']) {const root=c.document.createElement('section');root.id=id;body.append(root);}
 c.inventoryGridState={allData:[['백룡','SDK-001','UR',1,'A','기본'],['흑룡','SDK-002','SR',10,'B','2nd'],['백룡','SDK-001','UR',2,'B','기본']],filters:{},sort:{colIndex:1,dir:'asc'}};
 c.getLocalizedRarity=value=>value;c.startGridRendering=()=>{c.renderCount=(c.renderCount||0)+1;};
 c.AppOverlays={openPopup(root){root.hidden=false;},closePopup(root){root.hidden=true;}};
 const start=appSource.indexOf('let inventoryFilterEditor = null;'),end=appSource.indexOf('function switchToMode(',start);
 vm.runInContext(appSource.slice(start,end),c);
 const filterStart=appSource.indexOf('function applyGridFiltersAndSort()'),filterEnd=appSource.indexOf('function renderInventoryListTable()',filterStart);
 vm.runInContext(appSource.slice(filterStart,filterEnd),c);return {c,body};
}
test('보유 이름 체크박스는 닫기에 미반영하고 빈 선택과 전체 선택을 구분한다',()=>{
 const {c,body}=inventoryFixture();c.openGridFilter(null,0);
 let root=body.querySelector('#inventory-filter-popup');let inputs=root.querySelectorAll('input');
 inputs.forEach(input=>{input.checked=false;input.onchange?.();});c.closeGridFilter();assert.deepEqual(c.inventoryGridState.filters,{});
 c.openGridFilter(null,0);root=body.querySelector('#inventory-filter-popup');inputs=root.querySelectorAll('input');
 inputs.filter(input=>input.type==='checkbox').forEach(input=>{input.checked=false;input.onchange();});
 root.querySelector('#inventory-filter-apply').click();assert.equal(c.inventoryGridState.filters[0].size,0);
 c.applyGridFiltersAndSort();assert.equal(c.inventoryGridState.filteredData.length,0);
 c.openGridFilter(null,0);root=body.querySelector('#inventory-filter-popup');root.querySelector('header').children[1].children[1].click();root.querySelector('#inventory-filter-apply').click();assert.equal(c.inventoryGridState.filters[0],undefined);
});
test('보유 필터 정렬 버튼은 후보의 숫자 순서를 바꾸고 적용 때만 목록 정렬을 확정한다',()=>{
 const {c,body}=inventoryFixture();c.openGridFilter(null,3);const root=body.querySelector('#inventory-filter-popup'),sort=root.querySelector('header').children[1].children[0];
 sort.click();sort.click();assert.deepEqual(root.querySelectorAll('.filter-option-item').map(row=>row.textContent),['10','2','1']);
 assert.equal(c.inventoryGridState.sort.colIndex,1);root.querySelector('#inventory-filter-apply').click();assert.equal(c.inventoryGridState.sort.colIndex,3);assert.equal(c.inventoryGridState.sort.dir,'desc');
 c.applyGridFiltersAndSort();assert.deepEqual(Array.from(c.inventoryGridState.filteredData,row=>row[3]),[10,2,1]);
});

test('모바일 보유 필터는 검색란을 목록 아래에 놓고 수량은 정렬만 제공한다',()=>{
 const {c,body}=inventoryFixture(true);c.openGridFilterMobile(0);
 let root=body.querySelector('#mobile-grid-filter-sheet');const group=root.querySelector('[data-selection-group]');
 assert.equal(group.lastElementChild.type,'text');assert.equal(root.querySelectorAll('[role="switch"]').length,0);
 c.closeGridFilterSheet();c.openGridFilterMobile(3);root=body.querySelector('#mobile-grid-filter-sheet');
 assert.equal(root.querySelectorAll('.filter-option-item').length,0);assert.match(root.querySelector('header').textContent,/수량/);
 c.closeGridFilterSheet();c.openGridFilterMobile(5);root=body.querySelector('#mobile-grid-filter-sheet');
 assert.equal(root.querySelector('header').children[1].children.length,2);
});

test('데스크톱 추가 칩은 즉시 표시하고 미적용 상태로 닫으면 제거한다', () => {
    const { c, area, body, state } = domFixture();
    let updates = 0;
    c.AppOverlays = { openPopup() {}, closePopup() {}, updatePopup(panel, update) { updates++; update(); } };
    area.querySelector('.catalog-search-add').click();
    const editor = body.querySelector('#catalog-filter-editor');
    const options = editor.querySelector('.catalog-search-filters');
    assert.ok(options);
    options.querySelectorAll('button').find(button => button.textContent === '몬스터 유형').click();
    assert.equal(updates, 1);
    assert.equal(state.addedFilters.includes('monster'), true);
    assert.deepEqual(Array.from(state.filters.monster.values), []);
    const chip = area.querySelectorAll('.catalog-search-chip').find(node => node.dataset.filterKey === 'monster');
    assert.ok(chip);
    assert.equal(chip.classList.contains('color-tint-neutral'), true);
    const input = editor.querySelector('.filter-option-list').querySelector('input');
    input.checked = true; input.onchange();
    editor.querySelectorAll('button').find(button => button.getAttribute('aria-label') === '필터 편집 닫기').click();
    assert.deepEqual(Array.from(state.filters.monster.values), []);
    assert.equal(state.addedFilters.includes('monster'), false);
    assert.equal(chip.isConnected, false);
});

test('필터 편집 취소는 기존 적용 조건과 칩을 유지하며 숫자 0도 설정으로 취급한다', () => {
    const { c, area, body, state } = domFixture();
    c.applyCatalogFilter(state, 'monster', { values: ['effect'], operator: 'or' });
    c.openCatalogFilterEditor(state, 'monster', area.querySelector('.catalog-search-add'));
    const editor = body.querySelector('#catalog-filter-editor');
    editor.querySelectorAll('button').find(button => button.getAttribute('aria-label') === '초기화').click();
    c.closeCatalogFilterEditor();
    assert.deepEqual(Array.from(state.filters.monster.values), ['effect']);
    assert.equal(state.addedFilters.includes('monster'), true);
    c.applyCatalogFilter(state, 'level', 0);
    c.openCatalogFilterEditor(state, 'level', area.querySelector('.catalog-search-add'));
    c.closeCatalogFilterEditor();
    assert.equal(state.filters.level, 0);
    assert.equal(state.addedFilters.includes('level'), true);
    c.openCatalogFilterEditor(state, 'target', area.querySelector('.catalog-search-add'));
    c.closeCatalogFilterEditor();
    assert.equal(state.addedFilters.includes('target'), true);
});

test('모바일 미설정 필터 종료는 상시 칩과 데스크톱 추가 상태를 제거하지 않는다', () => {
    const { c, area, state } = domFixture(true);
    state.addedFilters.push('monster');
    c.openCatalogFilterEditor(state, 'monster', area.querySelector('.catalog-search-add'));
    c.closeCatalogFilterEditor();
    assert.equal(state.addedFilters.includes('monster'), true);
    assert.equal(area.querySelectorAll('.catalog-search-chip').some(node => node.dataset.filterKey === 'monster' && !node.hidden), true);
});
