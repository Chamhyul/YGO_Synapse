const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSearchNavigation } = require('../public/search-navigation');

function fixture({ reduced = false, initialHash = '#home', initialState = {}, animated = true } = {}) {
    const animations = [], observers = [], calls = { renderCatalog: [], renderTarget: [], resume: [], errors: [], invalidations: 0, close: 0 };
    const document = { activeElement: null };
    class Element {
        constructor(tagName) {
            this.tagName = tagName.toUpperCase();
            this.attributes = new Map();
            this.children = [];
            this.parentNode = null;
            this.dataset = {};
            this.inert = false;
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.height = 300;
            this.classes = new Set();
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name),
            };
            if (animated) this.animate = (frames, timing) => {
                let resolve, reject;
                const animation = { frames, timing, node: this, cancelled: false,
                    finished: new Promise((res, rej) => { resolve = res; reject = rej; }),
                    complete: () => resolve(), cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
                animation.finished.catch(() => {});
                animations.push(animation);
                return animation;
            };
        }
        set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
        get className() { return [...this.classes].join(' '); }
        set id(value) { this.setAttribute('id', value); }
        get id() { return this.getAttribute('id') || ''; }
        set href(value) { this.setAttribute('href', value); }
        get href() { return this.getAttribute('href'); }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        get firstElementChild() { return this.children[0] || null; }
        appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
        prepend(node) { node.remove(); node.parentNode = this; this.children.unshift(node); }
        replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; nodes.forEach(node => this.appendChild(node)); }
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        querySelectorAll(selector) {
            const match = node => selector.split(',').some(value => {
                value = value.trim();
                if (value === '[id]') return node.attributes.has('id');
                if (value.startsWith('.')) return node.classes.has(value.slice(1));
                return node.tagName === value.toUpperCase();
            });
            return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        getBoundingClientRect() { return { height: this.height }; }
        focus(options) { document.activeElement = this; this.focusOptions = options; }
    }
    const area = new Element('div'), page = new Element('section');
    area.id = 'result-area'; page.id = 'app-page-search'; page.appendChild(area);
    document.createElement = tag => new Element(tag);
    document.getElementById = id => id === 'result-area' ? area : id === 'app-page-search' ? page : null;
    const location = { hash: initialHash };
    const stack = [{ state: structuredClone(initialState), hash: initialHash }];
    let pointer = 0, navigation;
    const history = {
        get state() { return stack[pointer].state; },
        get length() { return stack.length; },
        pushState(state, _, hash) { stack.splice(pointer + 1); stack.push({ state: structuredClone(state), hash }); pointer++; location.hash = hash; },
        replaceState(state, _, hash) { stack[pointer] = { state: structuredClone(state), hash }; location.hash = hash; },
        back() { this.go(-1); }, forward() { this.go(1); },
        go(delta) {
            const next = pointer + delta;
            if (next < 0 || next >= stack.length) return;
            pointer = next; location.hash = stack[pointer].hash;
            navigation.onPopState({ state: this.state });
            navigation.handleHashChange();
        },
    };
    const window = { scrollX: 0, scrollY: 0, matchMedia: () => ({ matches: reduced }),
        scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
            observe(node) { this.node = node; }
            disconnect() { this.disconnected = true; }
        },
    };
    const env = { document, history, location, window, currentMode: 'search', state: null,
        mode: () => env.currentMode,
        activate: () => { env.currentMode = 'search'; },
        setState: state => { env.state = state; },
        setQuery: query => { env.query = query; },
        closeEditor: () => { calls.close++; },
        invalidate: () => { calls.invalidations++; },
        remember: (...args) => { calls.remember = args; },
        report: error => calls.errors.push(error),
        resumeCatalog: state => calls.resume.push(state),
        renderCatalog(state, mount) {
            calls.renderCatalog.push({ state, mount });
            mount.replaceChildren();
            const title = new Element('h2'); title.id = 'catalog-title'; mount.appendChild(title);
            for (const item of state.items || []) {
                const link = new Element('a'); link.className = 'catalog-search-row'; link.href = navigation.cardHref(item); mount.appendChild(link);
            }
        },
        renderTarget(state, mount) {
            calls.renderTarget.push({ state, mount });
            mount.replaceChildren();
            const title = new Element('h2'); title.id = 'card-title'; mount.appendChild(title);
        },
        openByCid(cid, code, options) {
            const state = { type: 'target', targetCid: cid, prioritizeNumber: code, targetCardName: '카드 이름' };
            navigation.showTarget(state, mount => env.renderTarget(state, mount), options);
        },
        openByName(type, options) {
            const state = { type: 'target', targetCardName: env.query };
            navigation.showTarget(state, mount => env.renderTarget(state, mount), options);
        },
    };
    navigation = createSearchNavigation(env);
    const catalog = (overrides = {}, options = {}) => {
        const state = { type: 'broad', query: '카드', filter: 'auto', page: 3, pageSize: 50,
            filters: { attribute: [0], monsterTraits: { values: [0, 1], operator: 'and' } },
            items: [{ cid: '100', number: 'ABC-001', name: '카드 이름' }], ...overrides };
        navigation.showCatalog(state, mount => env.renderCatalog(state, mount), options);
        return state;
    };
    const openFirst = state => {
        const trigger = navigation.currentPane().querySelector('.catalog-search-row');
        navigation.openCard(state.items[0], state, trigger);
    };
    const finish = async () => { animations.forEach(animation => animation.complete()); await new Promise(resolve => setImmediate(resolve)); };
    return { navigation, env, calls, document, page, area, window, history, location, stack, animations, observers, catalog, openFirst, finish };
}

test('목록→단일은 별도 기록을 만들고 뒤로가기로 조건·페이지·스크롤·선택 행 초점을 복원한다', async () => {
    const f = fixture();
    const state = f.catalog();
    const listHistory = structuredClone(f.history.state);
    f.page.scrollTop = 845; f.page.scrollLeft = 12; f.window.scrollTo(4, 75);
    f.openFirst(state);
    assert.equal(f.history.length, 3);
    assert.notEqual(f.history.state.searchNavigation.id, listHistory.searchNavigation.id);
    assert.equal(f.area.dataset.transition, 'forward');
    assert.equal(f.animations.find(animation => animation.node === f.navigation.currentPane()).frames[0].transform,
        'translateX(calc(100% + 24px))');
    assert.equal(f.location.hash, '#search?cid=100&code=ABC-001');
    assert.equal(f.navigation.currentPane().querySelector('.search-results__back').href, '#search?m=0&key=%EC%B9%B4%EB%93%9C');
    await f.finish();
    f.history.back();
    assert.equal(f.area.dataset.transition, 'back');
    assert.equal(f.animations.find(animation => animation.node === f.navigation.currentPane()).frames[0].transform,
        'translateX(calc(-100% - 24px))');
    await f.finish();
    assert.equal(f.env.state, state);
    assert.equal(f.env.state.page, 3);
    assert.equal(f.env.state.pageSize, 50);
    assert.deepEqual(f.env.state.filters, { attribute: [0], monsterTraits: { values: [0, 1], operator: 'and' } });
    assert.equal(f.page.scrollTop, 845); assert.equal(f.page.scrollLeft, 12);
    assert.equal(f.window.scrollX, 4); assert.equal(f.window.scrollY, 75);
    assert.equal(f.document.activeElement, f.navigation.currentPane().querySelector('.catalog-search-row'));
    assert.equal(f.document.activeElement.focusOptions.preventScroll, true);
    assert.equal(f.calls.renderCatalog.length, 2);
    assert.equal(f.calls.resume.length, 1);
    f.history.forward();
    assert.equal(f.area.dataset.transition, 'forward');
    await f.finish();
    assert.equal(f.env.state.type, 'target');
});

test('전환은 나가는 pane만 정리하고 애니메이션용 원본 내용과 돌아갈 스크롤 기록을 보존한다', async () => {
    const f = fixture();
    const disposed = [];
    f.env.disposePane = pane => disposed.push({ pane, children: [...pane.children],
        headingId: pane.querySelector('h2')?.id, top: f.page.scrollTop, left: f.page.scrollLeft });
    const state = f.catalog();
    assert.equal(disposed.length, 0, '첫 진입에는 정리할 이전 pane이 없음');
    const outgoing = f.navigation.currentPane();
    const originalChildren = [...outgoing.children];
    f.page.scrollTop = 720; f.page.scrollLeft = 11; f.window.scrollTo(3, 54);
    f.openFirst(state);
    const incoming = f.navigation.currentPane();
    assert.equal(disposed.length, 1);
    assert.equal(disposed[0].pane, outgoing);
    assert.notEqual(disposed[0].pane, incoming);
    assert.equal(disposed[0].headingId, 'catalog-title', '기존 ID가 제거되기 전에 정리 콜백 실행');
    assert.equal(disposed[0].top, 720); assert.equal(disposed[0].left, 11);
    assert.deepEqual(disposed[0].children, originalChildren);
    assert.deepEqual(outgoing.children, originalChildren, '나가는 화면의 내용은 복제하거나 비우지 않음');
    assert.equal(outgoing.parentNode, f.area, '전환이 끝나기 전까지 원본 pane을 유지');
    assert.equal(outgoing.inert, true);
    assert.equal(incoming.parentNode, f.area);
    assert.equal(incoming.inert, false);
    await f.finish();
    assert.equal(outgoing.parentNode, null);
    assert.equal(disposed.length, 1, '애니메이션 종료 시 이미 정리한 pane을 중복 정리하지 않음');
    f.history.back();
    assert.deepEqual(disposed.map(call => call.pane), [outgoing, incoming]);
    assert.ok(disposed.every(call => call.pane !== f.navigation.currentPane()));
    await f.finish();
    assert.equal(f.page.scrollTop, 720); assert.equal(f.page.scrollLeft, 11);
    assert.equal(f.window.scrollX, 3); assert.equal(f.window.scrollY, 54);
    assert.equal(f.env.state, state);
});

test('화면 복귀 링크는 같은 history 경로를 사용하고 수정키 클릭은 가로채지 않는다', async () => {
    const f = fixture({ animated: false });
    const state = f.catalog(); f.openFirst(state);
    const back = f.navigation.currentPane().querySelector('.search-results__back');
    let prevented = false;
    back.onclick({ button: 0, ctrlKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false); assert.equal(f.env.state.type, 'target');
    back.onclick({ button: 0, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(f.env.state, state);
    assert.equal(f.area.dataset.transition, 'back');
});

test('단일 카드 이름 영역의 왼쪽에 결과 복귀 링크를 배치한다', () => {
    const f = fixture({ animated: false });
    f.env.renderTarget = (_, mount) => {
        const header = f.document.createElement('header');
        header.className = 'search-card__name';
        header.appendChild(f.document.createElement('h2'));
        mount.replaceChildren(header);
    };
    f.openFirst(f.catalog());
    const header = f.navigation.currentPane().querySelector('.search-card__name');
    const back = header.querySelector('.search-results__back');
    assert.equal(header.firstElementChild, back);
    assert.equal(back.getAttribute('aria-label'), '검색 결과로 돌아가기');
    assert.match(back.innerHTML, /<svg[^>]*class="search-results__back-icon"/);
    assert.match(back.innerHTML, /<span class="search-results__back-label">뒤로 가기<\/span>/);
    assert.equal(back.href, '#search?m=0&key=%EC%B9%B4%EB%93%9C');
});

test('단일에서 새 검색은 하강하고 과거 목록의 복귀 버튼을 넘겨받지 않는다', async () => {
    const f = fixture();
    const first = f.catalog(); f.openFirst(first); await f.finish();
    const next = f.catalog({ query: '새 검색', page: 1 });
    assert.equal(f.area.dataset.transition, 'down');
    const slide = f.animations.findLast(animation => animation.node === f.navigation.currentPane());
    assert.deepEqual(slide.frames, [{ transform: 'translateY(-32px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]);
    assert.equal(f.navigation.currentPane().querySelector('.search-results__back'), null);
    await f.finish(); f.history.back(); await f.finish();
    assert.equal(f.env.state.type, 'target');
    f.history.forward(); await f.finish();
    assert.equal(f.env.state, next);
    assert.equal(f.area.dataset.transition, 'down');
});

test('떠난 pane의 늦은 메타데이터는 현재 카드 상태·주소를 덮지 않는다', () => {
    const f = fixture({ animated: false });
    f.openFirst(f.catalog());
    const oldPane = f.navigation.currentPane();
    const second = { type: 'target', targetCid: '200', targetCardName: '두 번째 카드' };
    f.navigation.showTarget(second, mount => f.env.renderTarget(second, mount));
    const before = f.location.hash;
    f.navigation.updateTarget({ targetCid: 'stale', targetMeta: { wrong: true } }, oldPane);
    assert.equal(f.env.state, second); assert.equal(f.location.hash, before);
    f.navigation.updateTarget({ targetMeta: { correct: true } }, f.navigation.currentPane());
    assert.deepEqual(f.env.state.targetMeta, { correct: true });
});

test('직접 단일 링크 진입은 복귀 링크·자동 제목 초점을 만들지 않고 현재 기록을 대체한다', () => {
    const f = fixture({ initialHash: '#search?cid=100' });
    const state = { type: 'target', targetCid: '100', targetCardName: '카드' };
    f.navigation.showTarget(state, mount => f.env.renderTarget(state, mount), { instant: true });
    assert.equal(f.history.length, 1);
    assert.equal(f.navigation.currentPane().querySelector('.search-results__back'), null);
    assert.equal(f.document.activeElement, null);
    assert.equal(f.animations.length, 0);
});

test('같은 entry의 popstate/hashchange 중복 수신은 목록을 다시 렌더링하지 않는다', () => {
    const f = fixture({ animated: false });
    f.catalog();
    const pane = f.navigation.currentPane();
    f.navigation.onPopState({ state: f.history.state });
    assert.equal(f.navigation.handleHashChange(), true);
    assert.equal(f.calls.renderCatalog.length, 1);
    assert.equal(f.navigation.currentPane(), pane);
    assert.equal(f.calls.invalidations, 0);
});

test('목록 필터·페이지 갱신은 현재 기록만 교체하고 이전 state의 갱신은 무시한다', () => {
    const f = fixture({ animated: false });
    const old = f.catalog(); const state = f.catalog({ query: '새 카드' });
    const count = f.history.length, id = f.history.state.searchNavigation.id;
    state.filter = 'number'; state.page = 2;
    f.navigation.updateCatalog(state);
    assert.equal(f.history.length, count); assert.equal(f.history.state.searchNavigation.id, id);
    assert.match(f.location.hash, /^#search\?m=2&key=/);
    const latest = f.location.hash;
    old.filter = 'name'; f.navigation.updateCatalog(old);
    assert.equal(f.location.hash, latest);
});

test('모바일 검색 열기의 임시 history는 새 검색으로 대체하며 다른 상태는 유지한다', () => {
    const f = fixture({ animated: false, initialHash: '#search', initialState: { mobileSearchOpen: true, preserved: 7 } });
    f.catalog();
    assert.equal(f.history.length, 1);
    assert.equal(f.history.state.mobileSearchOpen, undefined);
    assert.equal(f.history.state.preserved, 7);
    assert.ok(f.history.state.searchNavigation.id);
});

test('감소된 모션에서는 이동·높이 애니메이션 없이 교체하고 이전 pane은 제거한다', () => {
    const f = fixture({ reduced: true });
    const state = f.catalog(), previous = f.navigation.currentPane();
    f.openFirst(state);
    assert.equal(f.animations.length, 0);
    assert.equal(previous.parentNode, null);
    assert.equal(f.area.children.length, 1);
    assert.equal(f.area.classList.contains('is-transitioning'), false);
    assert.equal(f.document.activeElement, f.navigation.currentPane().querySelector('h2'));
});

test('전환 중 연속 검색은 이전 애니메이션·관찰자를 정리하고 최신 pane만 남긴다', async () => {
    const f = fixture();
    const state = f.catalog(); f.openFirst(state);
    const running = [...f.animations], previous = f.navigation.currentPane();
    const latest = f.catalog({ query: '마지막 검색' });
    assert.ok(running.every(animation => animation.cancelled));
    assert.equal(f.observers[0].disconnected, true);
    assert.equal(previous.inert, true);
    assert.equal(previous.getAttribute('aria-hidden'), 'true');
    assert.equal(previous.querySelector('h2').id, '');
    await f.finish();
    assert.equal(f.env.state, latest);
    assert.equal(f.area.children.length, 1);
    assert.equal(f.area.classList.contains('is-transitioning'), false);
    assert.equal(f.document.activeElement, f.navigation.currentPane().querySelector('h2'));
});

test('다른 앱 페이지로 떠날 때 진행 중 전환과 편집기를 정리하고 늦은 완료는 초점을 바꾸지 않는다', async () => {
    const f = fixture();
    const state = f.catalog(); f.openFirst(state);
    const active = f.document.activeElement;
    f.navigation.leave(); f.env.currentMode = 'home';
    await f.finish();
    assert.ok(f.animations.every(animation => animation.cancelled));
    assert.equal(f.area.classList.contains('is-transitioning'), false);
    assert.equal(f.document.activeElement, active);
    assert.equal(f.calls.invalidations, 1);
    assert.ok(f.calls.close >= 3);
});

test('진입 중 정보 높이가 바뀌면 현재 높이 애니메이션만 교체하고 관찰자는 완료 시 정리한다', async () => {
    const f = fixture();
    f.openFirst(f.catalog());
    const originalHeight = f.animations.find(animation => animation.node === f.area);
    const observer = f.observers[0];
    f.navigation.currentPane().height = 670;
    observer.callback();
    assert.equal(originalHeight.cancelled, true);
    const adjusted = f.animations.findLast(animation => animation.node === f.area);
    assert.equal(adjusted.frames[1].height, '670px');
    await f.finish();
    assert.equal(observer.disconnected, true);
    assert.equal(f.area.children.length, 1);
});

test('알 수 없는 history 항목과 주소가 불일치하는 항목은 기존 URL 복원 경로에 넘긴다', () => {
    const f = fixture({ animated: false });
    f.catalog();
    f.location.hash = '#search?cid=999';
    assert.equal(f.navigation.handleHashChange(), false);
    const previous = f.env.state;
    f.navigation.onPopState({ state: { searchNavigation: { id: 'not-in-memory' } } });
    assert.equal(f.env.state, previous);
});

test('현재 단일 카드의 제자리 갱신을 반복해도 복귀 링크는 하나만 유지한다', () => {
    const f = fixture({ animated: false });
    f.openFirst(f.catalog());
    // 실제 단일 렌더러는 동일 카드면 정보 DOM을 유지하고 보유 본문만 갱신한다.
    f.env.renderTarget = () => {};
    f.navigation.handleHashChange(true);
    f.navigation.handleHashChange(true);
    assert.equal(f.navigation.currentPane().querySelectorAll('.search-results__back').length, 1);
});

function routeFixture(hash, handled = false) {
    const calls = { search: [], cid: [], modes: [], closed: [], navigation: 0 };
    const input = { value: '' };
    const context = vm.createContext({ URLSearchParams, isInternalHashChange: false, lastSearchState: null,
        window: { location: { hash } }, UIStore: { mode: 'search' },
        document: { body: { classList: { add() {}, remove() {} } },
            getElementById: id => id === 'card-search' ? input : { id } },
        requestAnimationFrame: callback => callback(),
        M: { Modal: { getInstance: element => ({ close: () => calls.closed.push(element.id) }) } },
        SearchNavigation: { handleHashChange() { calls.navigation++; return handled; } },
        switchToMode: (...args) => calls.modes.push(args),
        checkClearBtn() {}, checkUrlHashForModals() {},
        startSearch: (...args) => calls.search.push(args),
        renderTargetByCid: (...args) => calls.cid.push(args),
    });
    const script = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
    const loadFunction = (start, end) => vm.runInContext(script.slice(script.indexOf(start), script.indexOf(end)), context);
    loadFunction('function handleHashChange(', 'function startOnboarding(');
    loadFunction('function refreshCurrentSearchResult(', 'function updateTooltipsOnly(');
    return { context, calls, input };
}

test('저장된 검색 방문으로 돌아갈 때 기존 약관·개인정보 모달부터 닫는다', () => {
    const f = routeFixture('#search?cid=100', true);
    f.context.handleHashChange();
    assert.deepEqual(f.calls.closed, ['terms-modal', 'privacy-modal']);
    assert.equal(f.calls.navigation, 1);
    assert.equal(f.calls.cid.length, 0);
    assert.equal(f.calls.search.length, 0);
});

test('초기 URL 해석은 화면만 활성화하고 동기화 후 CID 링크를 단일 카드로 실행한다', () => {
    const f = routeFixture('#search?cid=100&code=ABC-001');
    f.context.handleHashChange(true);
    assert.equal(f.calls.cid.length, 0);
    assert.equal(f.calls.modes[0][0], 'search');
    f.context.handleHashChange(false);
    assert.deepEqual(f.calls.cid, [['100', 'ABC-001', true]]);
});

test('캐시 동기화가 즉시 끝나도 초기 화면 활성화의 내부 hash 잠금이 검색 실행을 막지 않는다', () => {
    const f = routeFixture('#search?cid=100');
    // 실제 switchToMode는 internal이면 history를 쓰지 않고 100ms 잠금을 예약하지 않습니다.
    f.context.switchToMode = () => { if (!f.context.isInternalHashChange) f.context.isInternalHashChange = true; };
    f.context.handleHashChange(true);
    assert.equal(f.context.isInternalHashChange, false);
    f.context.handleHashChange(false);
    assert.deepEqual(f.calls.cid, [['100', null, true]]);
    assert.equal(f.context.isInternalHashChange, false);
});

test('CID 없는 직접 링크도 이름/번호 단일 구분과 검색어를 보존하여 실행한다', () => {
    for (const [hash, query, type] of [['#search?target=카드+이름', '카드 이름', 'name'], ['#search?code=ABC-001', 'ABC-001', 'number']]) {
        const f = routeFixture(hash);
        f.context.handleHashChange(true);
        assert.equal(f.calls.search.length, 0);
        assert.equal(f.calls.modes[0][0], 'search');
        f.context.refreshCurrentSearchResult();
        assert.equal(f.input.value, query);
        assert.deepEqual(f.calls.search, [[true, type, true]]);
    }
});

test('로그인 데이터가 먼저 도착해도 일반 링크의 이름/번호 검색 대상을 auto로 바꾸지 않는다', () => {
    for (const [mode, type] of [['1', 'name'], ['2', 'number']]) {
        const f = routeFixture(`#search?m=${mode}&key=찾을+카드`);
        f.context.handleHashChange(true);
        f.context.refreshCurrentSearchResult();
        assert.equal(f.input.value, '찾을 카드');
        assert.deepEqual(f.calls.search, [[true, type]]);
    }
});

function mobileSearchFixture() {
    const events = [], input = { value: '' }, classes = new Set();
    const icon = { innerText: 'search', classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
    let finish, fail;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const context = vm.createContext({
        UIStore: { isMobileSearchInProgress: false },
        document: { getElementById: id => id === 'card-search' ? input : id === 'mobile-search-btn' ? { querySelector: () => icon } : null },
        startSearch: (...args) => { events.push(['start', ...args]); return pending; },
        closeMobileSearch: fromPopState => events.push(['close', fromPopState]),
    });
    const script = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
    vm.runInContext(script.slice(script.indexOf('async function executeMobileSearch('), script.indexOf('function initMobileSearchListeners(')), context);
    return { context, events, input, icon, classes, finish, fail };
}

test('모바일 검색은 실행 직후 오버레이를 닫고 네트워크 응답을 기다린다', async () => {
    const f = mobileSearchFixture();
    const pending = f.context.executeMobileSearch('ABC-001', 'number', true);
    assert.equal(f.input.value, 'ABC-001');
    assert.deepEqual(f.events, [['start', false, 'number', true], ['close', true]]);
    assert.equal(f.context.UIStore.isMobileSearchInProgress, true);
    assert.equal(f.icon.innerText, 'autorenew');
    assert.equal(f.classes.has('loading-spin'), true);
    f.finish();
    await pending;
    assert.equal(f.context.UIStore.isMobileSearchInProgress, false);
    assert.equal(f.icon.innerText, 'search');
    assert.equal(f.classes.has('loading-spin'), false);
    assert.equal(f.events.filter(([action]) => action === 'close').length, 1);
});

test('모바일 검색 실패 시에도 닫힌 오버레이를 다시 닫거나 history를 되돌리지 않고 로딩을 끝낸다', async () => {
    const f = mobileSearchFixture();
    const pending = f.context.executeMobileSearch('카드');
    assert.deepEqual(f.events, [['start', false, 'auto', null], ['close', true]]);
    f.fail(new Error('조회 실패'));
    await assert.rejects(pending, /조회 실패/);
    assert.equal(f.context.UIStore.isMobileSearchInProgress, false);
    assert.equal(f.icon.innerText, 'search');
    assert.equal(f.classes.has('loading-spin'), false);
    assert.equal(f.events.filter(([action]) => action === 'close').length, 1);
});
