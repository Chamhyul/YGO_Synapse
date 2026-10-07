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

function fixture({ initialPage = 'home' } = {}) {
  const nodes = new Map();
  const document = { activeElement: null };
  function matches(node, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const id = part.match(/#([\w-]+)/)?.[1];
      const tag = part.match(/^[a-z]+/)?.[0];
      const classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      const attributes = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      return (!id || node.id === id) && (!tag || node.tagName === tag)
        && classes.every(name => node.classList.contains(name))
        && attributes.every(([, name, value]) => node.hasAttribute(name)
          && (value === undefined || node.getAttribute(name) === value));
    });
  }
  function element(id, classNames = '', parent = null, tagName = 'div') {
    const classes = new Set(classNames.split(/\s+/).filter(Boolean));
    const attrs = new Map();
    const node = {
      id, tagName, parentNode: parent, children: [], style: {}, rendered: true,
      focusCalls: [],
      classList: {
        contains: name => classes.has(name),
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name); else classes.delete(name);
          return force;
        },
      },
      setAttribute: (name, value) => attrs.set(name, String(value)),
      getAttribute: name => attrs.get(name) ?? null,
      hasAttribute: name => attrs.has(name),
      removeAttribute: name => attrs.delete(name),
      get inert() { return attrs.has('inert'); },
      set inert(value) { if (value) attrs.set('inert', ''); else attrs.delete('inert'); },
      get hidden() { return attrs.has('hidden'); },
      set hidden(value) { if (value) attrs.set('hidden', ''); else attrs.delete('hidden'); },
      contains(target) {
        for (; target; target = target.parentNode) if (target === this) return true;
        return false;
      },
      closest(selector) {
        for (let current = this; current; current = current.parentNode) {
          if (matches(current, selector)) return current;
        }
        return null;
      },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [
          ...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector),
        ]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus(options) {
        this.focusCalls.push(options);
        if (!this.closest('[inert], [hidden]')) document.activeElement = this;
      },
      blur() { if (document.activeElement === this) document.activeElement = document.body; },
      getClientRects() { return this.rendered && !this.closest('[hidden]') ? [{}] : []; },
    };
    nodes.set(id, node);
    parent?.children.push(node);
    return node;
  }
  document.documentElement = element('html', '', null, 'html');
  document.body = element('body', '', document.documentElement, 'body');
  document.activeElement = document.body;
  const shell = element('shell', 'app-page-content', document.body);
  const stack = element('app-page-stack', '', shell);
  const pages = Object.fromEntries(['home', 'search', 'manage', 'inventory', 'settings'].map(name => {
    const page = element(`app-page-${name}`, 'content-section', stack);
    page.heading = element(`${name}-title`, 'content-title', page, 'h1');
    return [name, page];
  }));
  for (const id of ['card-search', 'clear-btn', 'custom-dropdown', 'result-area']) element(id, '', shell);
  const manageSegment = element('manage-top-segment', 'ui-segment', pages.manage);
  for (const mode of ['add', 'move', 'discard']) element(`tab-mode-${mode}`, '', manageSegment, 'input');
  const manageForms = element('manage-mode-forms', '', pages.manage);
  for (const id of ['general-mode-wrapper', 'form-pack-add', 'form-deck-add', 'manage-move-wrapper', 'manage-discard-wrapper']) {
    element(id, 'mode-form anim-hidden', manageForms);
  }
  element('manage-auto-loc-container', '', pages.manage);
  const table = element('manage-table-container', 'mode-form anim-hidden', pages.manage);
  element('pack-table-area', '', table);
  element('deck-table-area', '', table);
  const inventorySegment = element('inventory-segment', 'ui-segment', pages.inventory);
  const inventoryForms = element('inventory-mode-forms', '', pages.inventory);
  for (const mode of ['dashboard', 'list']) {
    const radio = element(`inv-mode-${mode}`, '', inventorySegment, 'input');
    radio.setAttribute('name', 'inventory-mode');
    radio.setAttribute('value', mode);
    element(`form-inventory-${mode}`, 'mode-form anim-hidden', inventoryForms);
  }
  document.getElementById = id => nodes.get(id) || null;
  document.querySelectorAll = selector => selector === '#app-page-stack > .content-section'
    ? stack.children : document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => selector === '#app-page-inventory .ui-segment'
    ? inventorySegment : document.querySelectorAll(selector)[0] || null;

  // Keep cancelled callbacks available so tests can simulate a stale queued delivery.
  let frameId = 0, timerId = 0;
  const frames = new Map();
  const timers = new Map();
  const cancelledFrames = [];
  const location = { hash: '', pathname: '/', search: '' };
  const context = vm.createContext({
    document, URLSearchParams,
    window: { location, isAuthInitialized: true, scrollTo() {} },
    history: { pushState() { location.hash = ''; } },
    UIStore: { mode: initialPage, lastManageMode: 'add', chipState: { add: 'general' }, inventoryMode: 'dashboard' },
    PackDeckStore: { isPackTableGenerated: false, isDeckTableGenerated: false },
    currentToastInstance: null, currentToastMessage: null, addSubMode: 'general',
    updateActiveNav() {}, toggleSearchWrapper() {}, initPageMove() {}, initPageDiscard() {},
    handleAutomationParams() {}, updateManageFooter() {}, renderInventoryGrid() {}, updateDashboardStats() {},
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { cancelledFrames.push(id); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const stateStart = source.indexOf('let transitionTimer =');
  const helpersStart = source.indexOf('function setViewActive(');
  vm.runInContext(source.slice(stateStart, helpersStart) + [
    'setViewActive', 'setModePanelActive', 'setActivePage', 'focusActivePage',
    'switchToMode', 'switchInventoryMode', 'handleManageUI',
  ].map(functionSource).join('\n'), context);
  context.setActivePage(pages[initialPage]);
  const flushFrames = () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      if (!cancelledFrames.includes(id)) fn();
    }
  };
  return { context, document, pages, shell, nodes, element, frames, cancelledFrames, flushFrames };
}

test('최초 진입과 새로고침은 페이지를 표시하되 제목으로 초점을 옮기지 않는다', () => {
  for (const isInstant of [true, false]) {
    for (const [mode, pageName] of [['home', 'home'], ['add', 'manage'], ['inventory', 'inventory'], ['settings', 'settings'], ['search', 'search']]) {
      const { context: c, pages, document, flushFrames } = fixture({ initialPage: null });
      c.switchToMode(mode, isInstant);
      flushFrames();
      assert.equal(pages[pageName].classList.contains('active'), true, mode);
      assert.equal(pages[pageName].inert, false, mode);
      assert.equal(document.activeElement, document.body, mode);
      assert.equal(pages[pageName].heading.focusCalls.length, 0, mode);
      assert.equal(pages[pageName].heading.hasAttribute('tabindex'), false, mode);
    }
  }
});

test('새로고침의 인증 복원을 기다린 뒤에도 제목에 자동 초점을 주지 않는다', async () => {
  const { context: c, pages, document, flushFrames } = fixture({ initialPage: null });
  let finishAuth;
  c.window.isAuthInitialized = false;
  c.waitForAuthInit = () => new Promise(resolve => { finishAuth = resolve; });
  c.switchToMode('settings', true);
  assert.equal(pages.settings.classList.contains('active'), false);
  c.window.isAuthInitialized = true;
  finishAuth();
  await Promise.resolve();
  flushFrames();
  assert.equal(pages.settings.classList.contains('active'), true);
  assert.equal(document.activeElement, document.body);
  assert.equal(pages.settings.heading.focusCalls.length, 0);
});

test('관리 페이지를 열어도 비활성 페이지와 내부 패널은 조작 불가능한 상태를 유지한다', () => {
  const { context: c, pages, nodes, document, flushFrames } = fixture();
  c.switchToMode('add', true, 'general', null, true);
  flushFrames();
  for (const [name, page] of Object.entries(pages)) {
    assert.equal(page.inert, name !== 'manage', name);
    assert.equal(page.classList.contains('active'), name === 'manage', name);
  }
  assert.equal(nodes.get('general-mode-wrapper').inert, false);
  for (const id of ['form-pack-add', 'form-deck-add', 'manage-move-wrapper', 'manage-discard-wrapper', 'manage-table-container']) {
    assert.equal(nodes.get(id).inert, true, id);
    assert.equal(nodes.get(id).classList.contains('anim-hidden'), true, id);
  }
  assert.equal(document.activeElement, pages.manage.heading);
  assert.equal(pages.manage.heading.getAttribute('tabindex'), '-1');
  assert.equal(pages.manage.heading.focusCalls[0].preventScroll, true);
});

test('관리 패널 변경은 세그먼트 초점을 보존하고 비활성 패널만 잠근다', () => {
  const { context: c, nodes, document, flushFrames } = fixture();
  c.switchToMode('add', true, 'general', null, true);
  flushFrames();
  const segment = nodes.get('tab-mode-move');
  segment.focus();
  c.switchToMode('move');
  flushFrames();
  assert.equal(document.activeElement, segment);
  assert.equal(nodes.get('general-mode-wrapper').inert, true);
  assert.equal(nodes.get('manage-move-wrapper').inert, false);
  assert.equal(nodes.get('manage-discard-wrapper').inert, true);
  assert.equal(nodes.get('manage-auto-loc-container').inert, true);
});

test('현황 대시보드와 목록의 inert가 전환되고 선택한 라디오 초점은 유지된다', () => {
  const { context: c, nodes, document, flushFrames } = fixture();
  c.switchToMode('inventory', true, 'dashboard');
  flushFrames();
  assert.equal(nodes.get('form-inventory-dashboard').inert, false);
  assert.equal(nodes.get('form-inventory-list').inert, true);
  const segment = nodes.get('inv-mode-list');
  segment.focus();
  c.switchToMode('inventory', false, 'list');
  flushFrames();
  assert.equal(document.activeElement, segment);
  assert.equal(nodes.get('form-inventory-dashboard').inert, true);
  assert.equal(nodes.get('form-inventory-list').inert, false);
});

test('페이지 활성화는 모달이 설정한 상위 inert를 해제하거나 초점을 가져오지 않는다', () => {
  const { context: c, pages, shell, document, flushFrames } = fixture();
  shell.inert = true;
  c.switchToMode('settings', true);
  flushFrames();
  assert.equal(shell.inert, true);
  assert.equal(pages.settings.inert, false);
  assert.equal(document.activeElement, document.body);
  assert.equal(pages.settings.heading.focusCalls.length, 0);
});

test('열림 또는 닫힘 중인 모달은 페이지 전환 뒤에도 초점을 소유한다', () => {
  for (const state of ['open', 'closing']) {
    const { context: c, pages, document, element, flushFrames } = fixture();
    const modal = element('test-modal', `modal ${state}`, document.body);
    const control = element('modal-control', '', modal, 'button');
    control.focus();
    c.switchToMode('settings');
    flushFrames();
    assert.equal(document.activeElement, control, state);
    assert.equal(pages.settings.heading.focusCalls.length, 0, state);
  }
});

test('전환을 기다리는 동안 사용자가 옮긴 초점을 페이지 제목이 가로채지 않는다', () => {
  const { context: c, pages, document, element, flushFrames } = fixture();
  const control = element('header-control', '', document.body, 'button');
  c.switchToMode('settings');
  control.focus();
  flushFrames();
  assert.equal(document.activeElement, control);
  assert.equal(pages.settings.heading.focusCalls.length, 0);
});

test('취소된 이전 프레임이 늦게 실행되어도 최신 페이지와 초점을 덮지 않는다', () => {
  const { context: c, pages, document, frames, cancelledFrames, flushFrames } = fixture();
  c.switchToMode('settings');
  const [oldId, staleFrame] = [...frames][0];
  c.switchToMode('search');
  assert.ok(cancelledFrames.includes(oldId));
  flushFrames();
  assert.equal(document.activeElement, pages.search.heading);
  staleFrame();
  assert.equal(pages.search.inert, false);
  assert.equal(pages.search.classList.contains('active'), true);
  assert.equal(pages.settings.inert, true);
  assert.equal(pages.settings.classList.contains('active'), false);
  assert.equal(document.activeElement, pages.search.heading);
});

test('즉시 전환 직후 같은 관리 페이지의 패널을 바꾸면 no-transition이 남지 않는다', () => {
  const { context: c, pages, nodes, document, frames, cancelledFrames, flushFrames } = fixture();
  c.switchToMode('add', true, 'general', null, true);
  assert.equal(document.body.classList.contains('no-transition'), true);
  const [oldId, staleFrame] = [...frames][0];
  const segment = nodes.get('tab-mode-move');
  segment.focus();
  c.switchToMode('move');
  assert.ok(cancelledFrames.includes(oldId));
  assert.equal(document.body.classList.contains('no-transition'), false);
  flushFrames();
  staleFrame();
  assert.equal(document.body.classList.contains('no-transition'), false);
  assert.equal(pages.manage.inert, false);
  assert.equal(nodes.get('general-mode-wrapper').inert, true);
  assert.equal(nodes.get('manage-move-wrapper').inert, false);
  assert.equal(document.activeElement, segment);
});


test('모바일 로고는 홈 이탈 직후 탐색에서 제외되고 홈 복귀 시 다시 조작할 수 있다', () => {
  for (const mobile of [true, false]) {
    const { context: c, document, shell, element, flushFrames } = fixture();
    document.documentElement.classList.toggle('is-mobile-device', mobile);
    const masthead = element('app-search-masthead', '', shell);
    const logo = element('logo-link', 'app-title-container', masthead, 'a');
    for (const mode of ['settings', 'inventory', 'search']) {
      c.switchToMode(mode);
      assert.equal(masthead.inert, mobile, `${mobile}: ${mode} 퇴장 중`);
      flushFrames();
      logo.focus();
      assert.equal(document.activeElement === logo, !mobile, `${mobile}: ${mode} 로고 초점`);
      c.switchToMode('home');
      flushFrames();
      assert.equal(masthead.inert, false);
      logo.focus();
      assert.equal(document.activeElement, logo);
    }
  }
});
