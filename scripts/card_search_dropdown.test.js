const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '../public/backend/supabase.js'), 'utf8');
const registrationSearch = backend.slice(backend.indexOf(' async function registrationSuggestions('),
  backend.indexOf(' async function registrationNumber('));
const initials = source.match(/^const HANGUL_CHOSUNG_LIST = \[[\s\S]*?^\];/m)[0];

function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  const header = source.slice(start, source.indexOf('\n', start));
  if (header.endsWith('}')) return header;
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 2);
}

const controllerSource = [
  'debounce', 'updateHighlight', 'normalizeStr', 'usesRegistrationCatalog', 'registrationNameChoices',
  'filterRegistrationCatalogSuggestions', 'holdOpenSuggestionDropdown', 'confirmRegistrationNumber', 'setupCardSearchDropdown',
  'setupCustomDropdown', 'setupCardNoAutocomplete', 'openSheetOverlay', 'openSheetInputOverlay', 'closeSheetOverlay',
  'renderCardOverlaySuggestions', 'showRegistrationCatalogSuggestions', 'showOverlaySuggestions',
  'selectOverlayItem', 'initOverlaySearchListeners',
].map(extract).join('\n');

function fixture(field = 'name', { custom = false, registration = false, mobile = false } = {}) {
  let time = 0, timerId = 0, document;
  const timers = new Map();
  const elements = new Map();
  function element(tag = 'div', id = '') {
    const listeners = new Map();
    const node = {
      tag, id, value: '', dataset: {}, style: {}, children: [], readOnly: false, isConnected: true, className: '',
      classList: {
        contains(name) { return node.className.split(/\s+/).includes(name); },
        add(...names) { node.className = [...new Set([...node.className.split(/\s+/), ...names])].filter(Boolean).join(' '); },
        remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      },
      removeAttribute(name) { if (name === 'readonly') node.readOnly = false; },
      hasAttribute(name) { return name === 'readonly' && node.readOnly; },
      setAttribute() {}, setSelectionRange() {}, scrollIntoView() {},
      closest(selector) {
        for (let parent = node; parent; parent = parent.parentNode) {
          if (selector.startsWith('#') && selector.slice(1) === parent.id) return parent;
          if (selector.startsWith('.') && parent.classList.contains(selector.slice(1))) return parent;
        }
        return null;
      },
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      emit(type, extra = {}) {
        const event = { target: node, preventDefault() { this.defaultPrevented = true; }, ...extra };
        for (const fn of listeners.get(type) || []) fn(event);
        return event;
      },
      focus() {
        if (document.activeElement === node) return;
        const previous = document.activeElement;
        document.activeElement = node;
        previous?.emit('blur');
        node.emit('focus');
      },
      appendChild(child) {
        child.parentNode?.replaceChildren(...child.parentNode.children.filter(other => other !== child));
        child.parentNode = node;
        node.children.push(child);
      },
      replaceChildren(...children) {
        for (const child of node.children) child.parentNode = null;
        node.children = [];
        children.forEach(child => node.appendChild(child));
      },
      set innerHTML(_) { node.replaceChildren(); },
      querySelector(selector) {
        return node.children.find(child => selector === child.tag || selector === `[data-field="${child.dataset.field}"]`
          || selector.startsWith('.') && child.classList.contains(selector.slice(1))) || null;
      },
      querySelectorAll(selector) {
        assert.equal(selector, 'li:not(.item-no-match)');
        return node.children.filter(child => child.tag === 'li' && !child.classList.contains('item-no-match'));
      },
    };
    if (id) elements.set(id, node);
    return node;
  }

  const row = element();
  row.className = 'desktop-info-card';
  const fields = {};
  for (const key of new Set([field, 'name', 'no'])) {
    const wrapper = element();
    wrapper.className = mobile ? 'sheet-input-box' : 'custom-select-wrapper';
    const input = element('input', mobile ? `sheet-card-${key}` : '');
    input.className = 'custom-input';
    input.dataset.field = key;
    wrapper.appendChild(input);
    row.appendChild(wrapper);
    fields[key] = { input, wrapper };
  }
  row.querySelector = selector => {
    if (selector === '.page-card-name' || selector.includes('[data-field="name"]')) return fields.name.input;
    if (selector === '.page-card-no' || selector === '[data-field="no"]') return fields.no.input;
    return null;
  };

  const sheet = element('div', 'mobile-entry-bottom-sheet');
  const overlay = element('div', 'mobile-sheet-input-overlay');
  const overlayInput = element('input', 'overlay-search-input');
  element('button', 'overlay-clear-btn');
  const overlayList = element('ul', 'overlay-suggestions-list');
  overlayList.classList.add('active');
  const { input: rowInput, wrapper } = fields[field];
  const input = mobile ? overlayInput : rowInput;
  document = { activeElement: input, createElement: tag => element(tag), body: element(),
    getElementById: id => elements.get(id) };
  document.body.appendChild(row);
  document.body.appendChild(sheet);

  const calls = [], requests = [];
  const recordLookup = (target, ...args) => calls.push({ value: target.value, field: target.dataset.field, args });
  const stub = () => {};
  const context = vm.createContext({
    AbortController, document, UIStore: { mode: registration ? 'add' : 'move' }, currentEditingRow: row,
    YgoCardNameAutocomplete: require('../public/card-name-autocomplete.js'),
    positionDropdown: stub, updateDropdownArrowState: stub, updateInputAutoWidth: stub, handleAutoLocInput: stub,
    MutationObserver: class { observe() {} },
    getActiveContainer: () => row, getRowFromInput: () => row,
    getComputedStyle: dropdown => ({ height: `${dropdown.children.length * 32}px` }),
    CardDataStore: { allCardNumbers: ['DUNE-KR999'] }, cardCacheInstance: {},
    clearPageNameAndNo() { fields.name.input.value = ''; fields.no.input.value = ''; },
    updateSubCellsFromCache: stub, updateBottomSheetClearButtons: stub, updateSheetDropdownState: stub,
    fetchCardByNumber: recordLookup, fetchCardByName: recordLookup,
    openManagedSheet(target, { initialFocus }) { target.open = true; initialFocus.focus(); },
    closeManagedSheet(target) { target.open = false; },
    isManagedSheetOpen: target => target.open,
    search(query, { field: searchField, signal }) {
      return new Promise(resolve => requests.push({ query, field: searchField, signal, resolve }));
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, due: time + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(`
    ${initials}
    const registrationNumberSelections = new WeakMap();
    let activeOverlayType = '', packOverlaySelect, packOverlayLastSuggestions, packOverlaySuggestionRequest;
    let registrationOverlaySuggestions, registrationOverlayLastSuggestions = [];
    const searchAutocomplete = search;
    ${registrationSearch}
    ${controllerSource}
  `, context);

  if (registration) context.AppBackend = { registrationSuggestions: context.registrationSuggestions };
  const local = () => rowInput.value.toLowerCase().startsWith('missing') ? [] : [rowInput.value + '-first', rowInput.value + '-second'];
  function bind() {
    if (mobile) {
      context.initOverlaySearchListeners();
      context.openSheetOverlay(field);
    } else if (custom) {
      context.setupCustomDropdown(wrapper, recordLookup);
    } else if (registration) {
      context.setupCardSearchDropdown(fields.name.wrapper, () => assert.fail('이름 후보 로컬 조회'), recordLookup, 'name');
      context.setupCardNoAutocomplete(fields.no.wrapper);
    } else {
      context.setupCardSearchDropdown(wrapper, local, recordLookup);
    }
  }
  bind();

  function advance(ms) {
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= end).sort(([, a], [, b]) => a.due - b.due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      time = timer.due;
      timer.fn();
    }
    time = end;
  }
  const options = (key = field) => {
    if (mobile) return overlay.open ? overlayList.querySelectorAll('li:not(.item-no-match)') : [];
    const list = fields[key].wrapper._dropdown;
    return list?.classList.contains('active') ? list.querySelectorAll('li:not(.item-no-match)') : [];
  };
  return {
    input, wrapper, fields, row, calls, requests, document, bind, advance,
    dropdown: mobile ? overlayList : wrapper._dropdown,
    moveToSheet() { sheet.appendChild(wrapper); },
    moveToPage() { document.body.appendChild(wrapper); },
    type(value) { input.value = value; input.emit('input'); },
    open(key) { if (mobile) context.openSheetOverlay(key); else fields[key].input.focus(); },
    options,
    values(key) { return options(key).map(option => option.innerText); },
    selected() { return options().filter(option => option.classList.contains('selected')).map(option => option.innerText); },
    async reply(index, cards) {
      requests[index].resolve({ cards, next: null });
      // 실제 API 어댑터와 컨트롤러의 Promise 후속 처리를 기다린다.
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const values = f => f.calls.map(call => call.value);
for (const field of ['name', 'no']) {
  test(`${field}: typing and outside blur never look up or reopen`, () => {
    const f = fixture(field);
    f.type('ABC');
    assert.deepEqual(f.calls, []);
    f.document.activeElement = null;
    f.input.emit('blur');
    f.advance(100);
    assert.deepEqual(f.calls, []);
    assert.equal(f.input.value, 'ABC');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
  });
  for (const selected of [false, true]) {
    test(`${field}: Enter confirms ${selected ? 'the highlighted option' : 'the typed value without a selection'}`, () => {
      const f = fixture(field);
      f.type('ABC');
      f.advance(100);
      if (selected) f.input.emit('keydown', { key: 'ArrowDown' });
      f.input.emit('keydown', { key: 'Enter' });
      f.advance(100);
      f.input.emit('keydown', { key: 'Tab' });
      f.input.emit('blur');
      assert.deepEqual(values(f), [selected ? 'ABC-first' : 'ABC']);
      assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
    });
  }
  for (const shiftKey of [false, true]) {
    test(`${field}: ${shiftKey ? 'Shift+Tab' : 'Tab'} commits the current local suggestion before debounce`, () => {
      const f = fixture(field);
      f.type('OLD');
      f.advance(100);
      f.input.emit('keydown', { key: 'ArrowDown' });
      f.type('NEW');
      const e = f.input.emit('keydown', { key: 'Tab', shiftKey });
      f.input.emit('blur');
      f.advance(100);
      assert.deepEqual(values(f), ['NEW-first']);
      assert.equal(e.defaultPrevented, undefined);
    });
  }
  test(`${field}: clicking a visible suggestion commits it once`, () => {
    const f = fixture(field);
    f.bind();
    f.type('ABC');
    f.advance(100);
    f.options()[1].onclick();
    f.input.emit('keydown', { key: 'Tab' });
    f.input.emit('blur');
    f.advance(100);
    assert.deepEqual(values(f), ['ABC-second']);
    assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
  });
  test(`${field}: no suggestion and composing keys do not commit`, () => {
    const f = fixture(field);
    f.type('missing');
    f.input.emit('keydown', { key: 'Tab' });
    f.input.emit('keydown', { key: 'Enter', isComposing: true });
    assert.deepEqual(f.calls, []);
    assert.equal(f.input.value.toLowerCase(), 'missing');
  });
  test(`${field}: moving into the management sheet closes desktop suggestions and delegates key handling`, () => {
    const f = fixture(field);
    f.type('ABC');
    f.advance(100);
    assert.equal(f.wrapper._dropdown.classList.contains('active'), true);
    f.type('ABC');
    f.moveToSheet();
    f.input.emit('focus');
    f.input.emit('click');
    f.advance(100);
    for (const [key, shiftKey] of [['Tab', false], ['Tab', true], ['Enter', false], ['ArrowDown', false]]) {
      assert.equal(f.input.emit('keydown', { key, shiftKey }).defaultPrevented, undefined, key);
    }
    f.input.emit('blur');
    f.advance(100);
    assert.deepEqual(f.calls, []);
    assert.equal(f.input.value, 'ABC');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
    assert.equal(f.wrapper.classList.contains('active'), false);
    f.moveToPage();
    f.input.emit('focus');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), true);
  });
}

for (const field of ['rare', 'loc']) test(`${field}: management sheet focus, Tab and blur cannot select a desktop custom option`, () => {
  const f = fixture(field, { custom: true });
  f.wrapper.dataset.options = JSON.stringify([{ val: 'first', text: 'First' }, { val: 'second', text: 'Second' }]);
  f.input.value = 'Unconfirmed';
  f.input.readOnly = true;
  f.moveToSheet();
  f.input.emit('focus');
  f.input.emit('click');
  for (const shiftKey of [false, true]) f.input.emit('keydown', { key: 'Tab', shiftKey });
  f.input.emit('blur');
  f.advance(100);
  assert.deepEqual(f.calls, []);
  assert.equal(f.input.value, 'Unconfirmed');
  assert.equal(f.input.dataset.invalidInput, undefined);
  assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
});

test('number custom dropdown routes to the same controller', () => {
  let bound = 0;
  const context = vm.createContext({ setupCardNoAutocomplete() { bound++; } });
  vm.runInContext(extract('setupCustomDropdown'), context);
  context.setupCustomDropdown({ querySelector: () => ({}) });
  assert.equal(bound, 1);
});

const numberCard = (name, cid, ...matchedNumbers) => ({ name, cid, matchedNumbers });
const nameCards = (...names) => names.map((name, i) => ({ cid: String(i + 1), matchedNames: [name] }));
for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  for (const field of ['name', 'no']) {
    const isName = field === 'name';
    const first = isName ? 'ㅍㄹㄴ' : 'dune-kr';
    const narrow = isName ? 'ㅍ른 눈의 배' : 'dune-kr00';
    const unrelated = isName ? '블랙' : 'pp05-kr';
    const original = isName ? ['푸른 눈의 백룡', '푸른 눈의 빛룡', '파란 눈의 소녀'] : ['DUNE-KRS01', 'DUNE-KR002', 'DUNE-KR001'];
    const kept = isName ? [original[0]] : original.slice(1);
    const fresh = isName ? ['궁극의 푸른 눈의 백룡', original[0]] : ['DUNE-KR001', 'DUNE-KR002', 'DUNE-KR005'];
    const other = isName ? ['블랙 매지션'] : ['PP05-KR001'];
    const cards = items => isName ? nameCards(...items) : [numberCard('시험 카드', '1', ...items)];
    test(`${device} registration ${field}: 100ms debounce retains only matching options and follows response order`, async () => {
      const f = fixture(field, { registration: true, mobile });
      f.type(first);
      f.advance(99);
      assert.equal(f.requests.length, 0);
      f.advance(1);
      assert.equal(f.requests[0].query, isName ? first : first.toUpperCase());
      assert.equal(f.requests[0].field, isName ? 'name' : 'number');
      await f.reply(0, cards(original));
      assert.deepEqual(f.values(), original);
      if (!mobile) {
        f.input.emit('keydown', { key: 'ArrowUp' });
        assert.deepEqual(f.selected(), [original.at(-1)]);
      }

      f.type(narrow);
      assert.deepEqual(f.values(), kept);
      assert.deepEqual(f.selected(), []);
      f.advance(99);
      assert.equal(f.requests.length, 1);
      f.advance(1);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.values(), kept);
      if (!mobile) {
        f.input.emit('keydown', { key: 'ArrowDown' });
        assert.deepEqual(f.selected(), [kept[0]]);
      }
      await f.reply(1, cards(fresh));
      assert.deepEqual(f.values(), fresh);
      assert.deepEqual(f.selected(), []);
      assert.deepEqual(f.calls, []);
    });

    test(`${device} registration ${field}: unrelated edits and clearing ignore responses from aborted requests`, async () => {
      const f = fixture(field, { registration: true, mobile });
      f.type(first);
      f.advance(100);
      await f.reply(0, cards(original));
      f.type(narrow);
      f.advance(100);
      f.type(unrelated);
      const heldHeight = f.dropdown.style.height;
      assert.equal(heldHeight, `${kept.length * 32}px`);
      assert.equal(f.dropdown.classList.contains('active'), true);
      assert.deepEqual(f.values(), []);
      assert.equal(f.requests[1].signal.aborted, true);
      f.advance(100);
      assert.equal(f.dropdown.style.height, heldHeight);
      await f.reply(2, cards(other));
      assert.equal(f.dropdown.style.height, '');
      await f.reply(1, cards(fresh));
      assert.deepEqual(f.values(), other);
      f.type(first);
      f.advance(100);
      assert.ok(f.dropdown.style.height);
      f.type('');
      assert.equal(f.requests[3].signal.aborted, true);
      assert.equal(f.dropdown.style.height, '');
      await f.reply(3, cards(original));
      assert.deepEqual(f.values(), []);
      assert.deepEqual(f.calls, []);
    });

    test(`${device} registration ${field}: empty responses clear previous suggestions after the debounce`, async () => {
      const f = fixture(field, { registration: true, mobile });
      f.type(unrelated);
      f.advance(100);
      await f.reply(0, []);
      assert.deepEqual(f.values(), []);
      f.type(first);
      f.advance(100);
      await f.reply(1, cards(original));
      if (!mobile) f.input.emit('keydown', { key: 'ArrowDown' });
      f.type(unrelated);
      assert.deepEqual(f.values(), []);
      f.advance(100);
      await f.reply(2, []);
      assert.deepEqual(f.values(), []);
      assert.deepEqual(f.selected(), []);
      assert.equal(f.dropdown.style.height, '');
      f.type(narrow);
      assert.deepEqual(f.values(), []);
      f.advance(100);
      await f.reply(3, []);
      assert.deepEqual(f.values(), []);
      if (!mobile) f.input.emit('keydown', { key: 'Tab' });
      assert.deepEqual(f.calls, []);
      f.type('');
      f.type(unrelated);
      f.advance(100);
      await f.reply(4, []);
      assert.deepEqual(f.values(), []);
    });
  }

  test(`${device}: confirmed names keep only their matching printing numbers without a catalog request`, () => {
    const f = fixture('no', { registration: true, mobile });
    f.row.dataset.searchMode = 'name';
    f.fields.name.input.value = '푸른 눈의 백룡';
    const numbers = ['DUNE-KR002', 'DUNE-KRS01'];
    f.wrapper.dataset.options = JSON.stringify(numbers.map(val => ({ val })));
    f.open('no');
    f.type('DUNE-KR');
    f.advance(100);
    assert.deepEqual(f.values(), numbers);
    f.type('DUNE-KR00');
    assert.deepEqual(f.values(), [numbers[0]]);
    f.advance(100);
    assert.deepEqual(f.values(), [numbers[0]]);
    assert.deepEqual(f.requests, []);
  });

  test(`${device}: a shared number has one option and choosing it opens its card names`, async () => {
    const f = fixture('no', { registration: true, mobile });
    const number = 'DL2-001';
    const names = ['첫 번째 카드', '두 번째 카드'];
    f.type(number);
    f.advance(100);
    await f.reply(0, [numberCard(names[0], '1', number), numberCard(names[1], '2', number)]);
    assert.deepEqual(f.values(), [number]);
    f.options()[0].onclick();
    assert.equal(f.fields.no.input.value, number);
    assert.deepEqual(f.values('name'), names);
    assert.equal(f.requests.length, 1);
    f.options('name')[1].onclick();
    assert.deepEqual(f.calls, [{ field: 'name', value: names[1], args: [true, '2', false, number] }]);
  });
}

test('desktop: Enter after an edit uses the typed name and Tab cannot implicitly confirm a retained suggestion', async () => {
  for (const key of ['Enter', 'Tab']) {
    const f = fixture('name', { registration: true });
    f.type('푸른');
    f.advance(100);
    await f.reply(0, nameCards('푸른 눈의 백룡'));
    f.input.emit('keydown', { key: 'ArrowDown' });
    f.type('푸른 눈');
    assert.deepEqual(f.values(), ['푸른 눈의 백룡']);
    assert.deepEqual(f.selected(), []);
    f.input.emit('keydown', { key });
    f.advance(100);
    assert.deepEqual(values(f), key === 'Enter' ? ['푸른 눈'] : []);
    assert.equal(f.requests.length, 1);
  }
});

test('mobile: Enter uses the edited input with a retained option visible', async () => {
  const f = fixture('name', { registration: true, mobile: true });
  f.type('푸른');
  f.advance(100);
  await f.reply(0, nameCards('푸른 눈의 백룡'));
  f.type('푸른 눈');
  assert.deepEqual(f.values(), ['푸른 눈의 백룡']);
  f.input.emit('keydown', { key: 'Enter' });
  f.advance(100);
  assert.deepEqual(values(f), ['푸른 눈']);
  assert.equal(f.requests.length, 1);
});
