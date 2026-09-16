const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');

test('모바일 자동완성은 기존 최근 검색 칩 아래를 갱신한다', () => {
  const list = { children: [], classList: { add() {} }, appendChild(child) { this.children.push(child); }, querySelector() { return this.children.find(c => c.className === 'mobile-recent-container'); } };
  function element(className = '') {
    return { className, classList: { contains: name => className === name }, remove() { list.children.splice(list.children.indexOf(this), 1); } };
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
  assert.equal(list.children[1].className, 'no-result-item');
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
  const clear = { style: {}, addEventListener: (_, fn) => { listeners.clear = fn; } };
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
  listeners.clear({ preventDefault() {} });
  pending();
  assert.equal(input.value, '');
  assert.equal(clear.style.display, 'none');
  assert.equal(recent, 1);
  assert.equal(filtered, 0);
});
