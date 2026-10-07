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

function fixture({ mobile = true } = {}) {
  const nodes = new Map();
  const document = { activeElement: null };
  function matches(node, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const excluded = [...part.matchAll(/:not\(([^)]+)\)/g)];
      if (excluded.some(([, value]) => matches(node, value))) return false;
      part = part.replace(/:not\([^)]+\)/g, '');
      const id = part.match(/#([\w-]+)/)?.[1];
      const tag = part.match(/^[a-z]+/)?.[0];
      return (!id || node.id === id) && (!tag || node.tagName === tag)
        && [...part.matchAll(/\.([\w-]+)/g)].every(([, name]) => node.classList.contains(name))
        && [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
          node.hasAttribute(name) && (value === undefined || node.getAttribute(name) === value));
    });
  }
  function element(id, classNames = '', parent = document.body, tagName = 'div') {
    const classes = new Set(classNames.split(/\s+/).filter(Boolean));
    const attrs = new Map();
    const node = {
      id, tagName, parentNode: parent, children: [], style: {}, rendered: true, disabled: false,
      classList: {
        contains: name => classes.has(name),
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); },
      },
      setAttribute: (name, value) => attrs.set(name, String(value)),
      getAttribute: name => attrs.get(name) ?? null,
      hasAttribute: name => attrs.has(name),
      removeAttribute: name => attrs.delete(name),
      get inert() { return attrs.has('inert'); },
      set inert(value) { if (value) attrs.set('inert', ''); else attrs.delete('inert'); },
      get isConnected() { return document.documentElement?.contains(this) || false; },
      contains(target) { for (; target; target = target.parentNode) if (target === this) return true; return false; },
      matches(selector) { return matches(this, selector); },
      closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null; },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getClientRects() { return this.rendered && !this.closest('[hidden]') && this.style.display !== 'none' ? [{}] : []; },
      focus() { if (this.isConnected && !this.disabled && !this.closest('[inert], [hidden]') && this.getClientRects().length) document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = document.body; },
      remove() {
        if (this.contains(document.activeElement)) document.activeElement = document.body;
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      },
    };
    nodes.set(id, node);
    parent?.children.push(node);
    return node;
  }
  document.documentElement = element('html', mobile ? 'is-mobile-device' : '', null, 'html');
  document.body = element('body', '', document.documentElement, 'body');
  document.activeElement = document.body;
  const sidebar = element('sidebar', 'app-sidebar');
  const mobileDock = element('mobile-dock', 'app-mobile-dock');
  const mobileNav = element('mobile-nav', 'app-navi--mobile', mobileDock);
  const mobileAd = element('mobile-anchor-ad', 'mobile-ad-anchor', mobileDock);
  const navTrigger = element('nav-trigger', 'app-navi-item', mobileNav, 'button');
  const shell = element('shell', 'app-main-shell');
  const header = element('header', 'app-header', shell);
  const masthead = element('app-search-masthead', '', shell);
  const main = element('main', 'app-page-content', shell, 'main');
  const inactivePanel = element('inactive-panel', '', main);
  inactivePanel.inert = true;
  const footer = element('main-footer', 'app-footer', shell, 'footer');
  const trigger = element('trigger', '', header, 'button');
  document.getElementById = id => nodes.get(id) || null;
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  const frames = [], instances = new Map(), initialized = [], calls = [];
  const Modal = {
    getInstance: el => instances.get(el),
    init(el, options) {
      initialized.push(el);
      const instance = {
        el, options, isOpen: false,
        open(opener) {
          this.options.onOpenStart?.call(this, el, opener);
          this.isOpen = true;
          el.classList.add('open');
          el.focus();
        },
        completeOpen() { this.options.onOpenEnd?.call(this, el); },
        close() {
          this.options.onCloseStart?.call(this, el);
          this.isOpen = false;
          el.classList.remove('open');
        },
        completeClose() { this.options.onCloseEnd?.call(this, el); },
      };
      instances.set(el, instance);
      return instance;
    },
  };
  const context = vm.createContext({
    document, M: { Modal }, console,
    window: {
      location: { hash: '', pathname: '/', search: '', protocol: 'https:', host: 'example.test' },
      history: { pushState() {}, replaceState() {} },
    },
    UIStore: { lastHashBeforeModal: '' },
    sessionStorage: { removeItem: key => calls.push(key) },
    handleContinueRegistration: () => calls.push('registration'),
    handleContinueDiscard: () => calls.push('discard'),
    finishMoveProcess: () => calls.push('move'),
    requestAnimationFrame: fn => frames.push(fn),
  });
  const stateStart = source.indexOf('const modalStates =');
  if (stateStart < 0) throw new Error('모달 수명주기 상태 선언을 찾을 수 없음');
  const stateEnd = source.indexOf('\nfunction ', stateStart);
  vm.runInContext(source.slice(stateStart, stateEnd) + [
    'getModalBackgroundTargets', 'focusModalReturnTarget', 'syncModalLayers',
    'beginModalLifecycle', 'beginModalClose', 'finishModalLifecycle',
    'getCommonModalOptions', 'getAppModal',
  ].map(functionSource).join('\n'), context);
  const flush = () => { while (frames.length) frames.shift()(); };
  const modal = id => {
    const el = element(id, 'modal');
    el.setAttribute('tabindex', '-1');
    el.control = element(`${id}-control`, '', el, 'button');
    return el;
  };
  const open = (el, opener = document.activeElement) => {
    context.beginModalLifecycle(el, opener);
    el.classList.add('open');
    el.control.focus();
    flush();
  };
  const finish = el => {
    el.classList.remove('open');
    const completed = context.finishModalLifecycle(el);
    flush();
    return completed;
  };
  return { c: context, document, element, modal, open, finish, flush, calls, initialized, trigger, mobileDock, mobileAd, navTrigger,
    background: [sidebar, mobileDock, header, masthead, main, footer], inactivePanel };
}

test('멤버십 창은 공통 닫기 완료 때 확인 단계를 한 번만 초기화한다', () => {
  const f = fixture();
  let resets = 0;
  f.c.resetMembershipVerifyModal = () => { resets++; };
  const modal = f.modal('membership-auth-modal');
  const instance = f.c.getAppModal(modal);
  instance.open();
  instance.close();
  instance.completeClose();
  instance.completeClose();
  assert.equal(resets, 1);
});

test('모달은 푸터까지 잠그며 마지막 닫기 애니메이션이 끝난 뒤 기존 inert와 초점을 복원한다', () => {
  const f = fixture();
  f.background[0].inert = true;
  f.trigger.focus();
  const modal = f.modal('auth-modal');
  f.open(modal);
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  assert.equal(modal.inert, false);
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  f.c.beginModalClose(modal);
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  assert.equal(f.document.documentElement.classList.contains('modal-open'), true);
  assert.equal(f.finish(modal), true);
  f.background.forEach((el, index) => assert.equal(el.inert, index === 0, el.id));
  assert.equal(f.inactivePanel.inert, true);
  assert.equal(f.document.documentElement.classList.contains('modal-open'), false);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.finish(modal), false);
  // A later open must snapshot current ownership rather than reuse the first open's snapshot.
  const footer = f.background.at(-1);
  footer.inert = true;
  f.background[0].inert = false;
  f.open(modal, f.trigger);
  f.c.beginModalClose(modal);
  f.finish(modal);
  assert.equal(footer.inert, true);
  assert.equal(f.background[0].inert, false);
});

test('중첩 모달을 닫으면 부모 모달의 트리거로 돌아가고 배경 잠금은 유지된다', () => {
  const f = fixture();
  const parent = f.modal('auth-modal'), child = f.modal('terms-modal');
  f.trigger.focus();
  f.open(parent);
  f.open(child, parent.control);
  assert.equal(parent.inert, true);
  assert.notEqual(parent.getAttribute('aria-modal'), 'true');
  assert.equal(child.inert, false);
  assert.equal(child.getAttribute('aria-modal'), 'true');
  f.c.beginModalClose(child);
  f.finish(child);
  assert.equal(parent.inert, false);
  assert.equal(parent.getAttribute('aria-modal'), 'true');
  assert.equal(f.document.activeElement, parent.control);
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  f.c.beginModalClose(parent);
  f.finish(parent);
  assert.equal(f.document.activeElement, f.trigger);
});

test('공통 시트와 미이관 입력창은 배경막·패널 순서를 공유하며 부모 위에 열린다', () => {
  const f = fixture();
  const parent = f.modal('mobile-entry-bottom-sheet');
  parent.classList.add('ui-overlay');
  const parentBackdrop = f.element('entry-backdrop');
  const child = f.modal('mobile-sheet-input-overlay');
  const childBackdrop = f.element('child-backdrop');
  f.c.beginModalLifecycle(parent, f.trigger, parentBackdrop);
  f.c.beginModalLifecycle(child, parent.control, childBackdrop);
  assert.equal(parentBackdrop.style.zIndex, '100000');
  assert.equal(parent.style.zIndex, '100001');
  assert.equal(childBackdrop.style.zIndex, '100002');
  assert.equal(child.style.zIndex, '100003');
  assert.equal(parent.inert, true);
  assert.equal(child.inert, false);
  const embedded = f.element('embedded-backdrop', '', child);
  f.c.beginModalLifecycle(child, parent.control, embedded);
  assert.equal(embedded.style.zIndex, undefined, '내부 배경막은 자신의 패널을 덮지 않는다');
  f.c.beginModalClose(child); f.finish(child);
  assert.equal(parent.inert, false);
  assert.equal(parent.style.zIndex, '100001');
});

test('목록을 상세로 교체할 때 이전 창의 종료 콜백은 새 창의 초점과 잠금을 해제하지 않는다', () => {
  const f = fixture();
  const list = f.modal('notice-list-modal'), detail = f.modal('notice-detail-modal');
  f.trigger.focus();
  f.open(list);
  f.open(detail, list.control);
  f.c.beginModalClose(list);
  assert.equal(f.finish(list), true);
  assert.equal(f.document.activeElement, detail.control);
  assert.equal(detail.getAttribute('aria-modal'), 'true');
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  f.c.beginModalClose(detail);
  f.finish(detail);
  assert.equal(f.document.activeElement, f.trigger);
});

test('닫힘 중 다시 연 모달은 이전 closeEnd와 중복 closeEnd를 무시한다', () => {
  const f = fixture();
  const modal = f.modal('auth-modal');
  f.trigger.focus();
  f.open(modal);
  assert.equal(f.c.finishModalLifecycle(modal), false);
  f.c.beginModalClose(modal);
  f.open(modal);
  assert.equal(f.c.finishModalLifecycle(modal), false);
  assert.equal(modal.inert, false);
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  f.c.beginModalClose(modal);
  assert.equal(f.finish(modal), true);
  assert.equal(f.finish(modal), false);
  assert.equal(f.document.activeElement, f.trigger);
});

test('숨겨지거나 잠긴 복귀 대상에는 초점을 보내지 않는다', () => {
  const f = fixture();
  const target = f.element('return-target', '', f.background[4], 'button');
  for (const state of ['inert', 'hidden', 'aria-hidden']) {
    f.trigger.focus();
    target.setAttribute(state, state === 'aria-hidden' ? 'true' : '');
    f.c.focusModalReturnTarget(target);
    f.flush();
    assert.notEqual(f.document.activeElement, target, state);
    target.removeAttribute(state);
  }
  f.c.focusModalReturnTarget(target);
  f.flush();
  assert.equal(f.document.activeElement, target);
});

test('공통 옵션은 인스턴스를 재사용하고 afterOpen 작업과 모바일 위치 정리를 함께 실행한다', () => {
  const f = fixture();
  const modal = f.modal('notice-list-modal');
  const instance = f.c.getAppModal(modal);
  assert.equal(f.c.getAppModal(modal), instance);
  assert.equal(f.initialized.length, 1);
  f.c.testModal = modal;
  f.c.afterOpen = () => f.calls.push('afterOpen');
  vm.runInContext('modalAfterOpen.set(testModal, afterOpen)', f.c);
  f.trigger.focus();
  instance.open(f.trigger);
  modal.style.top = '10%';
  instance.completeOpen();
  f.flush();
  assert.equal(modal.style.top, '');
  assert.deepEqual(f.calls, ['afterOpen']);
  for (const el of f.background) assert.equal(el.inert, true, el.id);
  instance.close();
  assert.equal(f.document.documentElement.classList.contains('modal-open'), true);
  instance.completeClose();
  f.flush();
  assert.equal(f.document.activeElement, f.trigger);
  instance.open(f.trigger);
  instance.completeOpen();
  assert.deepEqual(f.calls, ['afterOpen'], 'afterOpen 전환 작업은 한 번만 소비');
});

test('등록·이동·제거 후처리는 닫기 방법과 무관하게 유효한 closeEnd에서 한 번만 실행한다', () => {
  for (const [id, expected] of [['add-result-modal', ['registration']], ['discard-result-modal', ['discard']], ['move-result-modal', ['move']]]) {
    const f = fixture({ mobile: false });
    const modal = f.modal(id), instance = f.c.getAppModal(modal);
    assert.equal(instance.options.dismissible, true, id);
    f.trigger.focus();
    instance.open(f.trigger);
    instance.completeOpen();
    instance.close();
    assert.deepEqual(f.calls, [], id);
    instance.open(f.trigger);
    instance.completeClose();
    assert.deepEqual(f.calls, [], '재열림 전 예약된 closeEnd는 업무 후처리를 실행하지 않음');
    assert.equal(modal.inert, false);
    instance.close();
    instance.completeClose();
    instance.completeClose();
    f.flush();
    assert.deepEqual(f.calls, expected, id);
    assert.equal(f.document.documentElement.classList.contains('modal-open'), false);
  }
});

test('Ctrl+Enter 실행 후 성공 행이 삭제되면 원래 입력란 대신 관리 실행 버튼으로 초점을 복귀한다', () => {
  for (const [id, cleanup] of [['add-result-modal', 'handleContinueRegistration'], ['discard-result-modal', 'handleContinueDiscard']]) {
    const f = fixture({ mobile: false });
    const main = f.background[4];
    const row = f.element('successful-row', '', main);
    const input = f.element('row-input', '', row, 'input');
    const fallback = f.element('manage-primary-btn', '', main, 'button');
    let cleanupCount = 0;
    f.c[cleanup] = () => { cleanupCount++; row.remove(); };
    const modal = f.modal(id), instance = f.c.getAppModal(modal);
    input.focus();
    instance.open(); // Keyboard submission has no explicit click trigger.
    instance.completeOpen();
    instance.close();
    assert.equal(input.isConnected, true, '행 정리는 closeEnd까지 기다림');
    instance.completeClose();
    f.flush();
    assert.equal(input.isConnected, false, id);
    assert.equal(main.inert, false, id);
    assert.equal(f.document.activeElement, fallback, id);
    instance.completeClose();
    assert.equal(cleanupCount, 1, '중복 종료 콜백은 행 정리를 반복하지 않음');
    assert.equal(f.document.activeElement, fallback, id);
  }
});


test('모바일 하단 공통 영역은 광고까지 잠그고 내비게이션 내부 초점을 복원한다', () => {
  const f = fixture();
  const modal = f.modal('dock-modal');
  f.navTrigger.focus();
  f.open(modal);
  assert.equal(f.mobileDock.inert, true);
  assert.equal(f.mobileAd.closest('[inert]'), f.mobileDock);
  assert.equal(f.navTrigger.closest('[inert]'), f.mobileDock);
  f.c.beginModalClose(modal);
  f.finish(modal);
  assert.equal(f.mobileDock.inert, false);
  assert.equal(f.document.activeElement, f.navTrigger);
});
