const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');

test('모바일 자동완성은 기존 최근 검색 칩 아래를 갱신한다', () => {
  const list = { children: [], classList: { add() {} }, appendChild(child) { this.children.push(child); }, querySelector() { return this.children.find(c => c.className === 'mobile-recent-container'); } };
  function element(className = '') {
    const node = { className, remove() { list.children.splice(list.children.indexOf(this), 1); } };
    node.classList = { contains: name => node.className.split(/\s+/).includes(name) };
    return node;
  }
  const recent = element('mobile-recent-container');
  list.children.push(recent, element('text-suggest'));
  const context = vm.createContext({
    document: { getElementById: () => list, createElement: () => element() },
    UIStore: {}, collectCatalogMatches: () => [],
    appendMobileRecentHistory() { throw new Error('기존 칩을 재생성하면 안 됨'); },
  });
  const start = source.indexOf('function filterAndShowDropdown(');
  vm.runInContext(source.slice(start, source.indexOf('\nfunction deleteRecentItem', start)), context);
  context.filterAndShowDropdown('없는 카드', true);
  assert.equal(list.children[0], recent);
  assert.equal(list.children.length, 2);
  assert.equal(list.children[1].classList.contains('no-result-item'), true);
  context.filterAndShowDropdown('다른 검색', true);
  assert.equal(list.children[0], recent);
  assert.equal(list.children.length, 2);
});

test('데스크톱 지우기는 입력값이 있고 사진 검색으로 비활성화되지 않았을 때만 표시한다', () => {
  const input = { value: '', disabled: false }, button = {};
  const context = vm.createContext({ document: { getElementById: id => id === 'card-search' ? input : button } });
  const start = source.indexOf('function checkClearBtn()');
  vm.runInContext(source.slice(start, source.indexOf('\nfunction toggleSearchWrapper', start)), context);
  for (const [value, disabled, hidden] of [['', false, true], ['카드', false, false], ['카드', true, true]]) {
    Object.assign(input, { value, disabled });
    context.checkClearBtn();
    assert.equal(button.hidden, hidden);
  }
});

test('모바일 지우기 후 예약된 검색은 최근 검색 목록을 덮어쓰지 않는다', () => {
  const listeners = {};
  const input = { value: '카드', addEventListener: (name, fn) => { listeners[name] = fn; }, focus() {} };
  const clear = { hidden: true, addEventListener: (_, fn) => { listeners.clear = fn; } };
  let pending, filtered = 0, recent = 0;
  const context = vm.createContext({
    document: { getElementById: id => id === 'mobile-card-search' ? input : id === 'mobile-search-clear-btn' ? clear : null },
    window: { addEventListener() {} },
    debounce: fn => value => { pending = () => fn(value); },
    mobileFilterAndShowDropdown() { filtered++; },
    showMobileRecentInDropdown() { recent++; },
  });
  const start = source.indexOf('function initMobileSearchListeners()');
  vm.runInContext(source.slice(start, source.indexOf('\n/* ===', start)), context);
  context.initMobileSearchListeners();
  listeners.input({ target: input });
  assert.equal(clear.hidden, false);
  listeners.clear({ preventDefault() {} });
  pending();
  assert.equal(input.value, '');
  assert.equal(clear.hidden, true);
  assert.equal(recent, 1);
  assert.equal(filtered, 0);
});

function mobileSearchMotionFixture({ reduced = false } = {}) {
  const classes = new Set();
  const overlay = { style: { display: 'none' }, offsetHeight: 800,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
  const input = { value: '이전 검색', focus() {} };
  const clear = { hidden: false };
  const dropdown = { classList: { remove() {} } };
  const frames = new Map(), timers = new Map();
  let serial = 0;
  const history = { state: {}, pushState(state) { this.state = state; }, back() { this.state = {}; } };
  const c = vm.createContext({
    document: {
      getElementById: id => ({ 'mobile-search-overlay': overlay, 'mobile-card-search': input,
        'mobile-search-clear-btn': clear, 'mobile-custom-dropdown': dropdown })[id] || null,
      querySelectorAll: () => [], querySelector: () => null,
    },
    history, UIStore: { mode: 'home' }, AppOverlays: { duration: () => reduced ? 0 : 200 },
    showMobileRecentInDropdown() {}, updateActiveNav() {},
    requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, duration) => { const id = ++serial; timers.set(id, { fn, duration }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const start = source.indexOf('let mobileSearchOpenFrame =');
  const end = source.indexOf('\n// 모바일 최근 검색 가로형 UI', start);
  vm.runInContext(source.slice(start, end), c);
  return { c, overlay, input, clear, history, timers,
    flushFrames() { const tasks = [...frames.values()]; frames.clear(); tasks.forEach(fn => fn()); },
    flushTimers() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(({ fn }) => fn()); } };
}

test('모바일 검색을 닫는 중 다시 열면 이전 종료가 새 화면과 검색어를 지우지 않는다', () => {
  const f = mobileSearchMotionFixture();
  f.c.openMobileSearch(); f.flushFrames();
  assert.equal(f.overlay.classList.contains('active'), true);
  assert.equal(f.clear.hidden, true);
  f.c.closeMobileSearch(true);
  assert.equal([...f.timers.values()][0].duration, 200);
  f.c.openMobileSearch(); f.flushFrames();
  f.input.value = '새 검색';
  f.flushTimers();
  assert.equal(f.overlay.style.display, 'flex');
  assert.equal(f.overlay.classList.contains('active'), true);
  assert.equal(f.input.value, '새 검색');
  f.c.closeMobileSearch(); f.flushTimers();
  assert.equal(f.overlay.style.display, 'none');
  assert.equal(f.input.value, '');
});

test('모바일 검색이 열림 프레임 전에 닫혀도 뒤늦게 활성화되지 않는다', () => {
  const f = mobileSearchMotionFixture();
  f.c.openMobileSearch(); f.c.closeMobileSearch(true);
  f.flushFrames(); f.flushTimers();
  assert.equal(f.overlay.classList.contains('active'), false);
  assert.equal(f.overlay.style.display, 'none');
});

test('모바일 검색은 감소된 모션에서 애니메이션 지연 없이 종료한다', () => {
  const f = mobileSearchMotionFixture({ reduced: true });
  f.c.openMobileSearch(); f.flushFrames(); f.c.closeMobileSearch(true);
  assert.equal([...f.timers.values()][0].duration, 0);
  f.flushTimers();
  assert.equal(f.overlay.style.display, 'none');
});
