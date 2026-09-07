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
function fixture(field = 'name') {
  const timers = new Map(); let timerId = 0;
  function element() {
    const classes = new Set(); const listeners = {};
    return {
      value: '', dataset: {}, children: [], readOnly: false,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
      removeAttribute() {}, setSelectionRange() {},
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      emit(type, extra = {}) { const e = { key: '', preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const fn of listeners[type] || []) fn(e); return e; },
      appendChild(child) { this.children.push(child); },
      set innerHTML(value) { this.children = []; },
      querySelectorAll() { return this.children.filter(x => x.className === 'custom-option'); },
    };
  }
  const input = element(); input.dataset.field = field;
  const wrapper = element(); wrapper.querySelector = () => input;
  const document = { activeElement: input, createElement: element, body: element() };
  const calls = [];
  const context = vm.createContext({ document, UIStore: {}, positionDropdown() {}, updateHighlight() {}, clearPageNameAndNo() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(extract('debounce') + '\n' + extract('setupCardSearchDropdown'), context);
  const suggestions = () => input.value.toLowerCase().startsWith('missing') ? [] : [input.value + '-first', input.value + '-second'];
  const bind = () => context.setupCardSearchDropdown(wrapper, suggestions, el => calls.push(el.value));
  bind();
  return { input, wrapper, calls, document, bind, flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
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
}
test('number custom dropdown routes to the same controller', () => {
  let bound = 0;
  const context = vm.createContext({ setupCardNoAutocomplete() { bound++; } });
  vm.runInContext(extract('setupCustomDropdown'), context);
  context.setupCustomDropdown({ querySelector: () => ({}) });
  assert.equal(bound, 1);
});
