const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  if (start < 0 || end < 0) throw new Error(`함수 추출 실패: ${name}`);
  return source.slice(start, end);
}

function fixture() {
  const document = { activeElement: null };
  function matches(node, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if ([...part.matchAll(/:not\(([^)]+)\)/g)].some(([, excluded]) => matches(node, excluded))) return false;
      part = part.replace(/:not\([^)]+\)/g, '');
      const id = part.match(/#([\w-]+)/)?.[1], tag = part.match(/^[a-z]+/)?.[0];
      return (!id || node.id === id) && (!tag || node.tagName === tag)
        && [...part.matchAll(/\.([\w-]+)/g)].every(([, name]) => node.classList.contains(name))
        && [...part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)].every(([, name, operator, value]) => {
          const actual = node.getAttribute(name);
          return actual !== null && (!operator || (operator === '^=' ? actual.startsWith(value) : actual === value));
        });
    });
  }
  function element(id = '', className = '', parent = null, tagName = 'div') {
    const attrs = new Map(), classes = new Set(className.split(/\s+/).filter(Boolean));
    const node = {
      tagName, parentNode: null, children: [], style: {}, dataset: {}, value: '', disabled: false,
      offsetHeight: 400, offsetTop: 100, clientHeight: 100, scrollTop: 0,
      classList: {
        contains: name => classes.has(name),
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); },
      },
      get id() { return attrs.get('id') || ''; }, set id(value) { attrs.set('id', value); },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      get innerHTML() { return ''; },
      set innerHTML(value) { for (const child of this.children) child.parentNode = null; this.children = []; },
      get inert() { return attrs.has('inert'); },
      set inert(value) { if (value) attrs.set('inert', ''); else attrs.delete('inert'); },
      get isConnected() { return document.documentElement?.contains(this) || false; },
      get parentElement() { return this.parentNode; },
      get tabIndex() { return attrs.has('tabindex') ? Number(attrs.get('tabindex')) : ['button', 'input', 'select', 'textarea'].includes(tagName) ? 0 : -1; },
      set tabIndex(value) { attrs.set('tabindex', String(value)); },
      setAttribute(name, value) {
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        else attrs.set(name, String(value));
      },
      getAttribute(name) {
        const value = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : attrs.get(name);
        return value == null ? null : String(value);
      },
      hasAttribute(name) { return this.getAttribute(name) !== null; },
      removeAttribute: name => attrs.delete(name),
      contains(target) { for (; target; target = target.parentNode) if (target === this) return true; return false; },
      closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null; },
      matches(selector) { return matches(this, selector); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(node => node !== child);
        child.parentNode = this; this.children.push(child); return child;
      },
      getClientRects() {
        for (let node = this; node; node = node.parentNode) if (node.style.display === 'none' || node.hasAttribute('hidden')) return [];
        return [{}];
      },
      focus() { if (this.isConnected && !this.disabled && !this.closest('[inert], [hidden]') && this.getClientRects().length) document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = document.body; this.onblur?.(); },
      click() { this.onclick?.(); }, select() {}, addEventListener() {},
    };
    if (id) node.id = id;
    parent?.appendChild(node);
    return node;
  }
  document.documentElement = element('html', 'is-mobile-device');
  document.body = element('body', '', document.documentElement, 'body');
  document.activeElement = document.body;
  document.getElementById = id => document.documentElement.querySelector(`#${id}`);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.createElement = tag => element('', '', null, tag);
  document.addEventListener = () => {};
  const main = element('main', 'app-page-content', document.body), footer = element('main-footer', '', document.body);
  const trigger = element('edit-trigger', '', main, 'button');
  const lists = {};
  for (const mode of ['general', 'pack', 'deck', 'move', 'discard']) lists[mode] = element(`mobile-cards-list-${mode}`, '', main);
  const entry = element('mobile-entry-bottom-sheet', 'mobile-bottom-sheet', document.body);
  const fieldsContainer = element('sheet-fields-container', '', entry);
  for (const id of ['sheet-prev-btn', 'sheet-next-btn', 'sheet-card-progress', 'sheet-confirm-btn']) element(id, '', entry, id === 'sheet-card-progress' ? 'span' : 'button');
  const backdrop = element('bottom-sheet-overlay', '', document.body);
  const inputSheet = element('mobile-sheet-input-overlay', '', document.body);
  const overlayInput = element('overlay-search-input', '', inputSheet, 'input');
  element('overlay-clear-btn', '', inputSheet, 'button');
  element('overlay-suggestions-list', '', inputSheet);
  const qty = element('mobile-sheet-qty-overlay', '', document.body);
  const qtyContent = element('qty-content', 'qty-overlay-content', qty);
  const picker = element('qty-picker-scroll-area', '', qtyContent);
  const qtyInline = element('qty-inline-input', '', qtyContent, 'input');
  for (const id of ['qty-reset-btn', 'qty-check-btn']) element(id, '', qtyContent, 'button');
  const dropdown = element('mobile-sheet-dropdown-select', 'mobile-bottom-sheet', document.body);
  element('sheet-dropdown-overlay', '', document.body);
  for (const el of [entry, backdrop, inputSheet, qty, dropdown, qtyInline]) el.style.display = 'none';
  for (const el of [entry, inputSheet, qty, dropdown]) el.tabIndex = -1;

  let frameId = 0, timerId = 0;
  const frames = new Map(), timers = new Map(), cancelledFrames = new Set(), cancelledTimers = new Set();
  const calls = { displays: [], recalcs: [], renders: 0, illustrationClose: 0 };
  const c = vm.createContext({
    document, console, UIStore: { mode: 'add' }, addSubMode: 'general',
    IllustrationPicker: { close() { calls.illustrationClose++; } },
    getDesktopCardData: row => ({ name: '카드', qty: '2' }), restoreDesktopDropdownOptions() {},
    updateBottomSheetClearButtons() {}, updateSheetDropdownState() {}, showOverlaySuggestions() {},
    updateMobileCardDisplay: row => calls.displays.push(row),
    recalcSiblingRowQtys: row => calls.recalcs.push(row), renderMobileCards: () => calls.renders++,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => cancelledFrames.add(id),
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => cancelledTimers.add(id),
  });
  const variables = ['modalStates', 'modalAfterOpen', 'modalBackgroundSnapshot', 'modalReturnFocus', 'sheetAnimationStates',
    'currentEditingRowIndex', 'currentEditingRow', 'activeOverlayType', 'qtyPickerSelectedVal'];
  const declarations = variables.map(name => {
    const declaration = source.match(new RegExp(`^(?:let|const) ${name} = .*$`, 'm'))?.[0];
    if (!declaration) throw new Error(`상태 선언 추출 실패: ${name}`);
    return declaration;
  });
  vm.runInContext(declarations.join('\n') + '\n' + [
    'getModalBackgroundTargets', 'syncModalLayers', 'beginModalLifecycle', 'beginModalClose', 'focusModalReturnTarget', 'finishModalLifecycle',
    'isManagedSheetOpen', 'resetSheetAnimation', 'openManagedSheet', 'closeManagedSheet', 'getActiveMobileListContainer', 'returnEditingFields',
    'closeEntrySheetChildren', 'handleManagedSheetKeydown', 'getQueryTarget',
    'openEditBottomSheet', 'closeEntryBottomSheet', 'openSheetOverlay', 'closeSheetOverlay', 'closeSheetDropdownSelect',
    'getCurrentMaxQty', 'openQtyOverlay', 'closeQtyOverlay', 'selectQtyFromPicker', 'startQtyInlineInput', 'finishQtyInlineInput',
  ].map(functionSource).join('\n'), c);
  const flushFrames = () => { for (const [id, fn] of [...frames]) { frames.delete(id); if (!cancelledFrames.has(id)) fn(); } };
  const flushTimers = () => { for (const [id, timer] of [...timers].sort((a, b) => a[1].delay - b[1].delay)) { timers.delete(id); if (!cancelledTimers.has(id)) timer.fn(); } };
  const makeRow = (mode = 'general', max = '7') => {
    const row = element('', 'mobile-info-card', lists[mode]);
    row.dataset.cardData = '{"name":"카드"}'; row.dataset.searchMode = 'name';
    const fields = element('', 'mobile-card-fields', row);
    const inputs = {};
    for (const field of ['name', 'no', 'illust', 'rare', 'loc', 'to', 'qty']) {
      const wrap = element('', 'sheet-input-box custom-select-wrapper', fields);
      wrap.dataset.fieldWrap = field;
      const prefix = mode === 'move' ? 'move' : mode === 'discard' ? 'discard' : 'page';
      const input = element('', `${prefix}-card-${field}`, wrap, 'input');
      input.dataset.field = field; input.dataset.lockedForName = 'true'; input.dataset.errorRetry = 'true'; input.dataset.prevCardNo = 'old';
      input.value = field === 'qty' ? '2' : field === 'name' ? '카드' : '';
      if (field === 'qty') input.setAttribute('max', max);
      inputs[field] = input;
    }
    fields.style.display = 'none';
    return { row, fields, inputs };
  };
  return { c, document, element, main, footer, trigger, lists, entry, backdrop, inputSheet, overlayInput, qty, picker, qtyInline,
    dropdown, fieldsContainer, makeRow, frames, timers, cancelledFrames, cancelledTimers, flushFrames, flushTimers, calls };
}

test('닫은 직후 다시 연 시트는 취소된 닫기 타이머가 실행되어도 숨겨지거나 잠금이 풀리지 않는다', () => {
  const f = fixture();
  f.trigger.focus();
  f.c.openManagedSheet(f.entry, { backdrop: f.backdrop });
  f.flushFrames();
  f.c.closeManagedSheet(f.entry, { backdrop: f.backdrop, duration: 350 });
  const [timerId, stale] = [...f.timers][0];
  f.c.openManagedSheet(f.entry, { backdrop: f.backdrop });
  f.flushFrames();
  assert.ok(f.cancelledTimers.has(timerId));
  stale.fn();
  assert.equal(f.c.isManagedSheetOpen(f.entry), true);
  assert.equal(f.entry.style.display, 'flex');
  assert.equal(f.entry.classList.contains('active'), true);
  assert.equal(f.main.inert, true);
  assert.equal(f.footer.inert, true);
});

test('열림 프레임 전에 닫은 시트는 늦은 프레임이 다시 활성화하거나 초점을 가져오지 않는다', () => {
  const f = fixture();
  f.trigger.focus();
  f.c.openManagedSheet(f.entry, { backdrop: f.backdrop });
  const [frameId, stale] = [...f.frames][0];
  f.c.closeManagedSheet(f.entry, { backdrop: f.backdrop });
  f.flushTimers();
  assert.ok(f.cancelledFrames.has(frameId));
  stale();
  assert.equal(f.c.isManagedSheetOpen(f.entry), false);
  assert.equal(f.entry.style.display, 'none');
  assert.equal(f.entry.classList.contains('active'), false);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.main.inert, false);
});

test('부모 시트 종료는 수량 인라인 값을 정규화하고 같은 입력 노드를 원래 행으로 반환한다', () => {
  for (const [value, expected] of [['999', '7'], ['0', '1'], ['', '1']]) {
    const f = fixture(), { row, fields, inputs } = f.makeRow();
    f.trigger.focus();
    f.c.openEditBottomSheet(0);
    f.flushFrames();
    assert.equal(fields.parentNode, f.fieldsContainer);
    f.c.openQtyOverlay('2');
    f.flushFrames();
    f.c.startQtyInlineInput(f.picker.querySelector('.selected'));
    f.qtyInline.value = value;
    f.c.closeEntryBottomSheet();
    assert.equal(fields.parentNode, row);
    assert.equal(row.querySelector('[data-field="qty"]'), inputs.qty);
    assert.equal(inputs.qty.value, expected, value);
    for (const input of Object.values(inputs)) {
      assert.equal(input.hasAttribute('readonly'), true);
      assert.equal(input.id, '');
      for (const key of ['lockedForName', 'errorRetry', 'prevCardNo']) assert.equal(input.dataset[key], undefined);
    }
    assert.equal(fields.querySelector('[id^="wrap-sheet-"]'), null);
    assert.equal(row.dataset.searchMode, undefined);
    assert.equal(row.dataset.cardData, '{"name":"카드"}');
    assert.equal(vm.runInContext('currentEditingRowIndex', f.c), -1);
    assert.equal(vm.runInContext('currentEditingRow', f.c), null);
    assert.equal(f.main.inert, true, '닫기 애니메이션 중 잠금 유지');
    f.flushTimers();
    assert.equal(f.main.inert, false);
  }
});

test('수량 시트는 처음 닫을 때만 값을 확정하고 중복 닫기로 값이나 행을 다시 변경하지 않는다', () => {
  const f = fixture(), { inputs } = f.makeRow();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  f.c.openQtyOverlay('2');
  f.flushFrames();
  f.c.selectQtyFromPicker(5);
  f.c.closeQtyOverlay();
  assert.equal(inputs.qty.value, '5');
  const mutations = f.calls.displays.length + f.calls.recalcs.length + f.calls.renders;
  f.c.selectQtyFromPicker(6);
  f.c.closeQtyOverlay();
  f.flushTimers();
  f.c.closeQtyOverlay();
  assert.equal(inputs.qty.value, '5');
  assert.equal(f.calls.displays.length + f.calls.recalcs.length + f.calls.renders, mutations);
});

test('편집 중 모드가 바뀌어도 입력 노드는 새 목록의 같은 인덱스가 아닌 원래 소유 행으로 돌아간다', () => {
  const f = fixture(), original = f.makeRow('general'), other = f.makeRow('move');
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  f.c.openQtyOverlay('2');
  f.flushFrames();
  f.c.selectQtyFromPicker(4);
  f.c.UIStore.mode = 'move';
  f.c.closeEntryBottomSheet();
  assert.equal(original.fields.parentNode, original.row);
  assert.equal(other.fields.parentNode, other.row);
  assert.equal(original.inputs.qty.value, '4');
  assert.equal(other.inputs.qty.value, '2');
  assert.equal(f.calls.recalcs.at(-1), original.row);
  assert.equal(original.row.querySelector('[data-field="name"]'), original.inputs.name);
});

test('부모 종료는 입력 중인 자식의 미확정 값을 취소하고 모든 시트의 잠금을 해제한다', () => {
  const f = fixture(), { inputs } = f.makeRow();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  f.c.openSheetOverlay('name');
  f.flushFrames();
  f.overlayInput.value = '미확정 이름';
  f.c.closeEntryBottomSheet();
  assert.equal(inputs.name.value, '카드');
  assert.equal(f.c.isManagedSheetOpen(f.inputSheet), false);
  f.flushTimers();
  assert.equal(f.inputSheet.style.display, 'none');
  assert.equal(f.entry.style.display, 'none');
  assert.equal(f.main.inert, false);
  assert.equal(f.document.documentElement.classList.contains('modal-open'), false);
});

test('닫히는 입력 시트를 다른 필드로 다시 열면 마지막 필드로 초점을 복귀한다', () => {
  const f = fixture(), { inputs } = f.makeRow();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  f.c.openSheetOverlay('name');
  f.flushFrames();
  f.c.closeSheetOverlay();
  const staleClose = [...f.timers.values()][0].fn;
  f.c.openSheetOverlay('loc');
  f.flushFrames();
  staleClose();
  assert.equal(f.c.isManagedSheetOpen(f.inputSheet), true);
  assert.equal(f.document.activeElement, f.overlayInput);
  f.c.closeSheetOverlay();
  f.flushTimers();
  assert.equal(f.document.activeElement, inputs.loc);
  assert.equal(f.c.isManagedSheetOpen(f.entry), true);
});

test('다른 행의 조회·수정은 편집 중인 시트 필드로 새지 않는다', () => {
  const f = fixture(), owner = f.makeRow(), sibling = f.makeRow();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  assert.equal(f.c.getQueryTarget(owner.row), f.fieldsContainer);
  assert.equal(f.c.getQueryTarget(sibling.row), sibling.row);
  f.c.getQueryTarget(sibling.row).querySelector('[data-field="qty"]').value = '6';
  assert.equal(sibling.inputs.qty.value, '6');
  assert.equal(owner.inputs.qty.value, '2');
  f.c.closeEntryBottomSheet();
  assert.equal(f.c.getQueryTarget(owner.row), owner.row);
});

function keyEvent(key, target, extra = {}) {
  return { key, target, ...extra, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
}

test('readonly가 해제된 필드도 Enter로 자식을 열고 Tab 순환·Escape는 최상위 시트에만 적용된다', () => {
  const f = fixture(), { inputs } = f.makeRow();
  f.trigger.focus();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  assert.equal(inputs.name.hasAttribute('readonly'), false);
  inputs.name.parentNode.onclick = () => f.c.openSheetOverlay('name');
  const enter = keyEvent('Enter', inputs.name);
  f.c.handleManagedSheetKeydown(enter);
  f.flushFrames();
  assert.equal(enter.prevented && enter.stopped, true);
  assert.equal(f.document.activeElement, f.overlayInput);
  assert.equal(f.entry.inert, true);
  const last = f.document.getElementById('overlay-clear-btn');
  last.focus();
  const tab = keyEvent('Tab', last);
  f.c.handleManagedSheetKeydown(tab);
  assert.equal(tab.prevented, true);
  assert.equal(f.document.activeElement, f.overlayInput);
  f.c.handleManagedSheetKeydown(keyEvent('Tab', f.overlayInput, { shiftKey: true }));
  assert.equal(f.document.activeElement, last);
  const submit = keyEvent('Enter', last, { ctrlKey: true });
  f.c.handleManagedSheetKeydown(submit);
  assert.equal(submit.prevented && submit.stopped, true);
  assert.equal(f.c.isManagedSheetOpen(f.inputSheet), true);
  f.c.handleManagedSheetKeydown(keyEvent('Escape', last));
  f.flushTimers();
  assert.equal(f.c.isManagedSheetOpen(f.inputSheet), false);
  assert.equal(f.c.isManagedSheetOpen(f.entry), true);
  assert.equal(f.document.activeElement, inputs.name);
  assert.equal(f.main.inert, true);
});

test('수량 휠의 방향키·Home·End와 Enter 인라인 편집 후 Escape 확정이 같은 입력란으로 돌아온다', () => {
  const f = fixture(), { inputs } = f.makeRow();
  f.c.openEditBottomSheet(0);
  f.flushFrames();
  f.c.openQtyOverlay('2');
  f.flushFrames();
  for (const [key, expected] of [['End', 7], ['ArrowUp', 6], ['Home', 1]]) {
    const selected = f.picker.querySelector('.selected');
    selected.onkeydown(keyEvent(key, selected));
    const current = f.picker.querySelector('.selected');
    assert.equal(Number(current.dataset.val), expected);
    assert.equal(f.document.activeElement, current);
    assert.equal(f.picker.children.filter(item => item.tabIndex === 0).length, 1);
  }
  f.c.handleManagedSheetKeydown(keyEvent('Enter', f.document.activeElement));
  assert.equal(f.document.activeElement, f.qtyInline);
  f.qtyInline.value = '999';
  f.c.handleManagedSheetKeydown(keyEvent('Escape', f.qtyInline));
  f.flushTimers();
  assert.equal(inputs.qty.value, '7');
  assert.equal(f.document.activeElement, inputs.qty);
  assert.equal(f.c.isManagedSheetOpen(f.qty), false);
  assert.equal(f.c.isManagedSheetOpen(f.entry), true);
});


test('사용자 정의 하위 시트의 Escape는 취소 경로를 호출하고 부모 잠금·복귀를 보존한다', () => {
  const f = fixture();
  const parent = f.element('photo-registration-sheet', 'ui-overlay', f.document.body);
  const child = f.element('photo-manual-sheet', 'ui-overlay', f.document.body);
  const trigger = f.element('', '', parent, 'button');
  let cancelled = 0;
  f.trigger.focus();
  f.c.openManagedSheet(parent, { trigger: f.trigger }); f.flushFrames();
  trigger.focus();
  f.c.openManagedSheet(child, { trigger, onDismiss() {
    cancelled++;
    f.c.closeManagedSheet(child);
  } }); f.flushFrames();
  assert.equal(parent.inert, true);
  f.c.handleManagedSheetKeydown(keyEvent('Escape', child));
  f.flushTimers();
  assert.equal(cancelled, 1);
  assert.equal(f.c.isManagedSheetOpen(parent), true);
  assert.equal(parent.inert, false);
  assert.equal(f.main.inert, true);
  assert.equal(f.document.activeElement, trigger);
});

test('빠르게 다시 연 동적 시트는 이전 종료 콜백으로 제거되지 않는다', () => {
  const f = fixture();
  const sheet = f.element('photo-search-sheet', 'ui-overlay', f.document.body);
  let removed = 0;
  f.c.openManagedSheet(sheet); f.flushFrames();
  f.c.closeManagedSheet(sheet, { onClose() { removed++; } });
  f.c.openManagedSheet(sheet); f.flushFrames(); f.flushTimers();
  assert.equal(removed, 0);
  assert.equal(f.c.isManagedSheetOpen(sheet), true);
  f.c.closeManagedSheet(sheet, { onClose() { removed++; } }); f.flushTimers();
  assert.equal(removed, 1);
});
