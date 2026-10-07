const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end);
}
function fixture(field = 'name', { custom = false } = {}) {
  const timers = new Map(); let timerId = 0;
  function element() {
    const classes = new Set(); const listeners = {};
    return {
      value: '', dataset: {}, children: [], readOnly: false, parentNode: null, id: '',
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
      removeAttribute(name) { if (name === 'readonly') this.readOnly = false; },
      hasAttribute(name) { return name === 'readonly' && this.readOnly; }, setSelectionRange() {},
      closest(selector) { for (let node = this; node; node = node.parentNode) if (selector === `#${node.id}`) return node; return null; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      emit(type, extra = {}) { const e = { key: '', preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const fn of listeners[type] || []) fn(e); return e; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(node => node !== child);
        child.parentNode = this; this.children.push(child);
      },
      set innerHTML(value) { this.children = []; },
      querySelectorAll() { return this.children.filter(x => x.className === 'custom-option'); },
    };
  }
  const input = element(); input.dataset.field = field;
  const wrapper = element();
  wrapper.querySelector = selector => ['input', '.custom-input', `[data-field="${field}"]`].includes(selector) ? input : null;
  wrapper.appendChild(input);
  const document = { activeElement: input, createElement: element, body: element() };
  document.body.appendChild(wrapper);
  const sheet = element(); sheet.id = 'mobile-entry-bottom-sheet'; document.body.appendChild(sheet);
  const calls = [];
  const context = vm.createContext({ document, UIStore: {}, positionDropdown() {}, updateHighlight() {}, clearPageNameAndNo() {},
    MutationObserver: class { observe() {} }, updateDropdownArrowState() {}, updateInputAutoWidth() {}, handleAutoLocInput() {},
    normalizeStr: value => value.trim().toLowerCase(), decomposeHangul: value => value,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(extract('debounce') + '\n' + extract('setupCardSearchDropdown') + '\n' + extract('setupCustomDropdown'), context);
  const suggestions = () => input.value.toLowerCase().startsWith('missing') ? [] : [input.value + '-first', input.value + '-second'];
  const bind = () => custom ? context.setupCustomDropdown(wrapper, el => calls.push(el.value))
    : context.setupCardSearchDropdown(wrapper, suggestions, el => calls.push(el.value));
  bind();
  return { input, wrapper, calls, document, bind, moveToSheet() { sheet.appendChild(wrapper); },
    moveToPage() { document.body.appendChild(wrapper); },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}
for (const field of ['name', 'no']) {
  test(`${field}: typing and outside blur never look up or reopen`, () => {
    const f = fixture(field); f.input.value = 'ABC'; f.input.emit('input');
    assert.deepEqual(f.calls, []);
    f.document.activeElement = null; f.input.emit('blur'); f.flush();
    assert.deepEqual(f.calls, []); assert.equal(f.input.value, 'ABC');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
  });
  test(`${field}: Enter uses literal text even with highlighted suggestion`, () => {
    const f = fixture(field); f.input.value = 'ABC'; f.input.emit('input'); f.flush();
    f.input.emit('keydown', { key: 'ArrowDown' }); f.input.emit('keydown', { key: 'Enter' }); f.flush();
    assert.deepEqual(f.calls, ['ABC']);
    f.input.emit('keydown', { key: 'Tab' }); f.input.emit('blur');
    assert.deepEqual(f.calls, ['ABC']); assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
  });
  for (const shiftKey of [false, true]) test(`${field}: ${shiftKey ? 'Shift+Tab' : 'Tab'} commits current first suggestion before debounce`, () => {
    const f = fixture(field); f.input.value = 'OLD'; f.input.emit('input'); f.flush();
    f.input.emit('keydown', { key: 'ArrowDown' }); f.input.emit('keydown', { key: 'ArrowDown' });
    f.input.value = 'NEW'; f.input.emit('input');
    const e = f.input.emit('keydown', { key: 'Tab', shiftKey }); f.input.emit('blur'); f.flush();
    assert.deepEqual(f.calls, ['NEW-first']); assert.equal(e.defaultPrevented, undefined);
  });
  test(`${field}: click commits selected value once and cancels pending render`, () => {
    const f = fixture(field); f.bind(); f.input.value = 'ABC'; f.input.emit('input'); f.flush();
    f.input.emit('input'); f.wrapper._dropdown.children[1].onclick(); f.flush();
    f.input.emit('keydown', { key: 'Tab' }); f.input.emit('blur');
    assert.deepEqual(f.calls, ['ABC-second']); assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
  });
  test(`${field}: no suggestion and composing keys do not commit`, () => {
    const f = fixture(field); f.input.value = 'missing'; f.input.emit('input');
    f.input.emit('keydown', { key: 'Tab' }); assert.deepEqual(f.calls, []);
    f.input.emit('keydown', { key: 'Enter', isComposing: true }); assert.deepEqual(f.calls, []);
    assert.equal(f.input.value.toLowerCase(), 'missing');
  });
  test(`${field}: moving into the management sheet closes desktop suggestions and leaves keyboard handling to the sheet`, () => {
    const f = fixture(field); f.input.value = 'ABC'; f.input.emit('input'); f.flush();
    assert.equal(f.wrapper._dropdown.classList.contains('active'), true);
    f.input.emit('input'); // A render was already queued before the physical DOM move.
    f.moveToSheet(); f.input.emit('focus'); f.input.emit('click'); f.flush();
    for (const [key, shiftKey] of [['Tab', false], ['Tab', true], ['Enter', false], ['ArrowDown', false]]) {
      const event = f.input.emit('keydown', { key, shiftKey });
      assert.equal(event.defaultPrevented, undefined, key);
    }
    f.input.emit('blur'); f.flush();
    assert.deepEqual(f.calls, []);
    assert.equal(f.input.value, 'ABC');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), false);
    assert.equal(f.wrapper.classList.contains('active'), false);
    f.moveToPage(); f.input.emit('focus');
    assert.equal(f.wrapper._dropdown.classList.contains('active'), true, '원래 영역으로 돌아오면 데스크톱 제어기 재사용');
  });
}
for (const field of ['rare', 'loc']) test(`${field}: management sheet focus, Tab and blur cannot select a desktop custom option`, () => {
  const f = fixture(field, { custom: true });
  f.wrapper.dataset.options = JSON.stringify([{ val: 'first', text: 'First' }, { val: 'second', text: 'Second' }]);
  f.input.value = 'Unconfirmed'; f.input.readOnly = true;
  f.moveToSheet(); f.input.emit('focus'); f.input.emit('click');
  for (const shiftKey of [false, true]) f.input.emit('keydown', { key: 'Tab', shiftKey });
  f.input.emit('blur'); f.flush();
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
