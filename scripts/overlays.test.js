const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/overlays.js'), 'utf8');

function fixture({ mobile = false, reduced = false } = {}) {
  const events = new Map();
  const element = (names = '') => {
    const classes = new Set(names.split(/\s+/));
    const animations = [];
    const style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    return {
      style, animations, hidden: false, offsetWidth: 400, offsetHeight: 240,
      classList: {
        contains: value => classes.has(value), add: (...values) => values.forEach(value => classes.add(value)),
        toggle(value, active) { if (active) classes.add(value); else classes.delete(value); },
      },
      animate(frames, options) {
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        const animation = { frames, options, finished, finish: resolve, cancel: () => reject(new Error('cancelled')) };
        animations.push(animation);
        return animation;
      },
    };
  };
  const html = element(mobile ? 'is-mobile-device' : '');
  const window = {
    innerHeight: 800, innerWidth: 600,
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (name, callback) => events.set(name, callback),
    visualViewport: { height: 800, width: 600, offsetTop: 0, offsetLeft: 0, addEventListener: (name, callback) => events.set(`visual-${name}`, callback) },
  };
  const context = vm.createContext({ window, document: { documentElement: html }, setTimeout, clearTimeout,
    getComputedStyle: el => ({ opacity: el.style.opacity ?? '1', transform: 'none' }) });
  vm.runInContext(source, context);
  const calls = [];
  const modal = element('ui-overlay ui-overlay__panel');
  const backdrop = element();
  const instance = { el: modal, $overlay: { 0: backdrop, remove: () => calls.push('remove') },
    options: { onOpenEnd: () => calls.push('openEnd'), onCloseEnd: () => calls.push('closeEnd') } };
  window.AppOverlays.installModal(instance);
  const flush = async (...elements) => {
    elements.forEach(el => el.animations.at(-1)?.finish());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  return { api: window.AppOverlays, window, html, events, element, modal, backdrop, instance, calls, flush };
}

test('모달과 배경막의 공통 전환이 끝난 후 종료 콜백을 한 번 호출한다', async () => {
  const f = fixture();
  f.instance._animateIn();
  assert.equal(f.modal.style.display, 'flex');
  assert.equal(f.modal.classList.contains('ui-overlay--modal'), true);
  assert.equal(f.modal.animations[0].options.duration, 200);
  assert.equal(f.modal.animations[0].options.easing, 'ease');
  await f.flush(f.modal, f.backdrop);
  assert.deepEqual(f.calls, ['openEnd']);
  f.instance._animateOut();
  assert.equal(f.modal.style.display, 'flex', '종료 전에는 공통 수명주기가 잠금을 계속 소유한다');
  await f.flush(f.modal, f.backdrop);
  assert.equal(f.modal.style.display, 'none');
  assert.deepEqual(f.calls, ['openEnd', 'remove', 'closeEnd']);
});

test('닫힘 도중 다시 열면 이전 종료가 패널을 숨기거나 closeEnd를 실행하지 않는다', async () => {
  const f = fixture();
  f.instance._animateIn(); await f.flush(f.modal, f.backdrop);
  f.instance._animateOut();
  const stale = [f.modal.animations.at(-1), f.backdrop.animations.at(-1)];
  f.instance._animateIn();
  stale.forEach(animation => animation.finish());
  await f.flush(f.modal, f.backdrop);
  assert.equal(f.modal.style.display, 'flex');
  assert.equal(f.modal.style.opacity, '1');
  assert.deepEqual(f.calls, ['openEnd', 'openEnd']);
});

test('모바일 모달은 시트 외곽·그림자를 선택하고 감소된 모션에서는 즉시 끝난다', () => {
  const f = fixture({ mobile: true, reduced: true });
  f.instance._animateIn();
  assert.equal(f.modal.classList.contains('ui-overlay--sheet'), true);
  assert.equal(f.modal.classList.contains('shadow-mobile-sheet'), true);
  assert.equal(f.modal.classList.contains('shadow-modal'), false);
  assert.equal(f.modal.animations.length, 0);
  f.instance._animateOut();
  assert.equal(f.modal.style.display, 'none');
  assert.deepEqual(f.calls, ['openEnd', 'remove', 'closeEnd']);
});

test('키보드의 visualViewport 변화는 공통 가용 높이와 상단 위치에 반영된다', () => {
  const f = fixture();
  f.window.visualViewport.height = 320;
  f.window.visualViewport.offsetTop = 60;
  f.events.get('visual-resize')();
  assert.equal(f.html.style['--overlay-viewport-height'], '320px');
  assert.equal(f.html.style['--overlay-viewport-top'], '60px');
});

test('화면 경계의 팝업은 앵커 위로 배치하며 다시 열면 늦은 닫힘을 취소한다', async () => {
  const f = fixture();
  const panel = f.element('ui-overlay--popup');
  const trigger = { getBoundingClientRect: () => ({ left: 550, top: 700, bottom: 730 }) };
  f.api.openPopup(panel, trigger);
  assert.equal(panel.style.left, '184px');
  assert.equal(panel.style.top, '452px');
  await f.flush(panel);
  f.api.closePopup(panel);
  f.api.openPopup(panel, trigger);
  await f.flush(panel);
  assert.equal(panel.hidden, false);
  assert.notEqual(panel.style.display, 'none');
  f.api.closePopup(panel); await f.flush(panel);
  assert.equal(panel.hidden, true);
});


test('팝업 재열기는 이전 DOM 제거를 취소하며 최종 종료만 콜백을 실행한다', async () => {
  const f = fixture();
  const panel = f.element('ui-overlay--popup');
  let removed = 0;
  f.api.openPopup(panel); await f.flush(panel);
  f.api.closePopup(panel, () => removed++);
  assert.equal(panel.inert, true);
  f.api.openPopup(panel); await f.flush(panel);
  assert.equal(panel.inert, false);
  assert.equal(removed, 0);
  f.api.closePopup(panel, () => removed++); await f.flush(panel);
  assert.equal(removed, 1);
});


test('스크롤 시 열린 팝업의 앵커를 다시 따라가고 제거된 팝업은 재배치하지 않는다', () => {
  const f = fixture({ reduced: true });
  const panel = f.element('ui-overlay--popup');
  let bottom = 120;
  const trigger = { getBoundingClientRect: () => ({ left: 40, top: bottom - 30, bottom }) };
  f.api.openPopup(panel, trigger);
  assert.equal(panel.style.top, '128px');
  bottom = 70; f.events.get('scroll')();
  assert.equal(panel.style.top, '78px');
  panel.isConnected = false;
  bottom = 40; f.events.get('scroll')();
  assert.equal(panel.style.top, '78px');
});

function sizeFixture({ reduced = false, sheet = false } = {}) {
  let mutationCallback, resizeCallback;
  const observed = new Set();
  const animations = [];
  const panel = {
    nodeType: 1, isConnected: true, height: 400, width: 600, hidden: false, activeAnimation: null,
    matches: selector => selector === '.ui-overlay__panel' || selector.includes(sheet ? '.ui-overlay--sheet' : '.ui-overlay--modal'),
    closest: selector => selector === '.ui-overlay__panel' ? panel : panel.hidden ? panel : null,
    contains: node => node === panel || node === body,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height: panel.activeAnimation?.currentHeight ?? (panel.hidden ? 0 : panel.height), width: panel.width }),
    animate(frames, options) {
      let finish, reject;
      const animation = { frames, options, currentHeight: parseFloat(frames[0].height), cancelled: false,
        finished: new Promise((yes, no) => { finish = yes; reject = no; }),
        finish() { if (panel.activeAnimation === animation) panel.activeAnimation = null; finish(); },
        cancel() { this.cancelled = true; if (panel.activeAnimation === animation) panel.activeAnimation = null; reject(new Error('cancelled')); },
      };
      panel.activeAnimation = animation;
      animations.push(animation);
      return animation;
    },
  };
  const body = { nodeType: 1, closest: () => panel, contains: () => false };
  const window = {
    innerHeight: 800, matchMedia: () => ({ matches: reduced }), addEventListener() {},
    ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe(el) { observed.add(el); } unobserve(el) { observed.delete(el); } },
    MutationObserver: class { constructor(callback) { mutationCallback = callback; } observe() {} },
  };
  const document = { documentElement: { style: { setProperty() {} } }, querySelectorAll: () => [panel], addEventListener() {} };
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout });
  const change = height => { panel.height = height; mutationCallback([{ type: 'childList', target: body, addedNodes: [] }]); };
  const resize = () => resizeCallback([{ target: panel }]);
  const flush = async () => { animations.at(-1)?.finish(); await Promise.resolve(); await Promise.resolve(); };
  return { panel, animations, change, resize, flush, observed, mutationCallback };
}

for (const sheet of [false, true]) {
  test(`${sheet ? '시트' : '모달'} 내용의 확대·축소는 200ms로 전환하고 자연 높이로 돌아온다`, async () => {
    const f = sizeFixture({ sheet });
    f.change(700);
    assert.equal(f.animations[0].frames[0].height, '400px');
    assert.equal(f.animations[0].frames[1].height, '700px');
    assert.equal(f.animations[0].options.duration, 200);
    assert.equal(f.animations[0].options.easing, 'ease');
    assert.equal(f.animations[0].options.fill, undefined, '완료 후 고정 높이를 남기지 않는다');
    await f.flush();
    f.change(260);
    assert.equal(f.animations[1].frames[0].height, '700px');
    assert.equal(f.animations[1].frames[1].height, '260px');
    await f.flush(); f.resize();
    assert.equal(f.animations.length, 2, '관찰자의 후속 알림은 중복 전환하지 않는다');
  });
}

test('높이 전환 중 새 내용은 현재 보이는 높이에서 이어지고 늦은 완료는 무시한다', async () => {
  const f = sizeFixture();
  f.change(700);
  const previous = f.animations[0];
  previous.currentHeight = 510;
  f.resize();
  assert.equal(f.animations.length, 1, '애니메이션 중간 높이는 자연 높이 변경으로 처리하지 않는다');
  f.change(300);
  assert.equal(previous.cancelled, true);
  assert.equal(f.animations[1].frames[0].height, '510px');
  assert.equal(f.animations[1].frames[1].height, '300px');
  previous.finish(); await Promise.resolve();
  assert.equal(f.panel.activeAnimation, f.animations[1]);
  await f.flush();
  assert.equal(f.panel.activeAnimation, null);
});

test('감소된 모션·최초 표시·너비 변경은 높이 전환 없이 배치한다', () => {
  const reduced = sizeFixture({ reduced: true });
  reduced.change(600); assert.equal(reduced.animations.length, 0);
  const f = sizeFixture();
  f.panel.hidden = true; f.resize();
  f.panel.hidden = false; f.change(300);
  assert.equal(f.animations.length, 0);
  f.panel.width = 390; f.change(500);
  assert.equal(f.animations.length, 0, '반응형 너비 변경은 이전 너비의 높이와 섞지 않는다');
});

test('패널 종료·DOM 제거는 높이 전환을 취소하고 관찰도 해제한다', async () => {
  const f = sizeFixture();
  f.change(600);
  f.panel.hidden = true; f.change(240);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations.length, 1);
  f.panel.isConnected = false;
  f.mutationCallback([{ type: 'childList', target: { nodeType: 1, closest: () => null }, addedNodes: [] }]);
  assert.equal(f.observed.has(f.panel), false);
  await Promise.resolve();
});

test('나중에 추가한 시트도 관찰하되 팝업은 높이 전환 대상에서 제외한다', () => {
  const f = sizeFixture();
  let height = 260, sheet = true;
  const animations = [];
  const dynamic = {
    nodeType: 1, isConnected: true,
    contains: node => node === dynamic,
    matches: selector => selector === '.ui-overlay__panel' || sheet,
    closest: selector => selector === '.ui-overlay__panel' ? dynamic : null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height, width: 375 }),
    animate(frames) {
      animations.push(frames);
      return { cancel() {}, finished: Promise.resolve() };
    },
  };
  f.mutationCallback([{ type: 'childList', target: { nodeType: 1, closest: () => null }, addedNodes: [dynamic] }]);
  assert.equal(f.observed.has(dynamic), true);
  height = 440;
  f.mutationCallback([{ type: 'childList', target: dynamic, addedNodes: [] }]);
  assert.equal(animations[0][0].height, '260px');
  assert.equal(animations[0][1].height, '440px');
  sheet = false; height = 300;
  f.mutationCallback([{ type: 'attributes', target: dynamic }]);
  assert.equal(animations.length, 1, '모바일 시트에서 데스크톱 팝업으로 바뀌면 전환을 멈춘다');
});
