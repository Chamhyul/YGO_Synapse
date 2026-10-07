const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const start = source.indexOf('let faqResources = null;');
assert.notEqual(start, -1);

function fixture({ reduced = false } = {}) {
  const animations = [];
  const document = { activeElement: null };
  let resized;
  function node(extra = {}) {
    const classes = new Set();
    return {
      addEventListener() {}, hidden: false, inert: false, dataset: {}, height: 400, width: 800,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
      getBoundingClientRect() { return { height: this.height, width: this.width }; },
      setAttribute(name, value) { this[name] = value; },
      contains(target) { return this.items?.some(item => item.summary === target) ?? false; },
      focus() { document.activeElement = this; },
      animate(frames, options) {
        let resolve, reject;
        const animation = { target: this, frames, options, cancelled: false,
          finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
          finish() { resolve(); }, cancel() { this.cancelled = true; reject(new Error('cancelled')); },
        };
        animations.push(animation);
        return animation;
      },
      ...extra,
    };
  }
  function content(text) {
    return {
      childNodes: [{ text, cloneNode() { return { ...this }; } }],
      cloneNode() { return content(this.childNodes[0].text); },
      replaceChildren(...children) { this.childNodes = children; },
    };
  }
  const groups = ['ko', 'en', 'ja', 'cn', 'de', 'fr', 'it', 'es', 'pt'].map(lang => {
    const panels = ['faq', 'tips'].map(kind => {
      const items = Array.from({ length: 6 }, (_, i) => {
        const title = content(`${lang}/${kind}/${i}/title`);
        const body = content(`${lang}/${kind}/${i}/body`);
        const summary = node();
        return node({ open: false, title, body, summary,
          getBoundingClientRect() { return { height: this.open ? 200 : 60, width: 800 }; },
          querySelector: selector => selector === 'summary' ? summary : selector === 'summary > span' ? title : body });
      });
      return node({ dataset: { resourcePanel: kind }, hidden: kind === 'tips',
        height: kind === 'faq' ? 600 : 400, items,
        querySelectorAll: () => items });
    });
    return node({ dataset: { lang }, lang: lang === 'cn' ? 'zh-Hans' : lang,
      height: 600, panels, querySelectorAll: () => panels,
      remove() { this.removed = true; } });
  });
  const radios = { 'faq-radio-faq': node({ checked: true }), 'faq-radio-tips': node({ checked: false }) };
  document.getElementById = id => id === 'home-faq-section' ? { querySelectorAll: () => groups } : radios[id];
  const context = { window: { matchMedia: () => ({ matches: reduced }) }, document,
    ResizeObserver: class { constructor(callback) { resized = callback; } observe() {} } };
  vm.runInNewContext(source.slice(start), context);
  context.updateFaqLanguage('ko');
  return { groups, radios, animations, document, resize: () => resized(),
    container: groups[0], panels: groups[0].panels,
    toggle: item => context.toggleFaqDisclosure(context.initFaqResources(), item),
    setLanguage: context.updateFaqLanguage, switchTab: context.window.switchFaqTab };
}
const settle = async animations => {
  animations.forEach(animation => animation.finish());
  await new Promise(resolve => setImmediate(resolve));
};

test('언어를 바꾸어도 같은 details·summary·본문 노드와 열림 상태를 유지한다', () => {
  const f = fixture();
  const original = f.panels.map(panel => panel.items.map(item => ({ item, title: item.title, body: item.body, summary: item.summary })));
  f.panels[0].items[0].open = true;
  f.panels[0].items[2].open = true;
  f.panels[1].items[1].open = true;
  for (const region of ['ja', 'ae', 'cn', 'de', 'fr', 'it', 'es', 'pt', 'en', 'ko']) {
    f.setLanguage(region);
    const lang = region === 'ae' ? 'en' : region;
    assert.equal(f.container.lang, lang === 'cn' ? 'zh-Hans' : lang);
    f.panels.forEach((panel, p) => panel.items.forEach((item, i) => {
      assert.equal(item, original[p][i].item);
      assert.equal(item.summary, original[p][i].summary);
      assert.equal(item.title, original[p][i].title);
      assert.equal(item.body, original[p][i].body);
      assert.equal(item.body.childNodes[0].text, `${lang}/${panel.dataset.resourcePanel}/${i}/body`);
      assert.equal(item.title.childNodes[0].text, `${lang}/${panel.dataset.resourcePanel}/${i}/title`);
    }));
    assert.equal(f.panels[0].items[0].open, true);
    assert.equal(f.panels[0].items[2].open, true);
    assert.equal(f.panels[1].items[1].open, true);
  }
  assert.equal(f.groups.filter(group => !group.removed).length, 1);
  assert.equal(f.radios['faq-radio-faq']['aria-controls'], 'home-resources-faq');
});

test('좌우 이동과 높이를 함께 전환하고 종료 후 자연 높이로 복귀한다', async () => {
  const f = fixture();
  f.switchTab('tips');
  assert.equal(f.panels[0].inert, true);
  assert.equal(f.panels[1].hidden, false);
  assert.equal(f.animations[0].frames[1].transform, 'translateX(calc(-100% - 1 * var(--resource-panel-gap)))');
  assert.equal(f.animations[1].frames[0].transform, 'translateX(calc(100% + 1 * var(--resource-panel-gap)))');
  assert.equal(f.animations[2].frames[0].height, '600px');
  assert.equal(f.animations[2].frames[1].height, '400px');
  await settle(f.animations);
  assert.equal(f.panels[0].hidden, true);
  assert.equal(f.panels[1].inert, false);
  assert.equal(f.container.classList.contains('home-resources__language--switching'), false);
  f.switchTab('faq');
  assert.equal(f.animations[3].frames[1].transform, 'translateX(calc(100% - -1 * var(--resource-panel-gap)))');
  assert.equal(f.animations[4].frames[0].transform, 'translateX(calc(-100% + -1 * var(--resource-panel-gap)))');
  await settle(f.animations);
});

test('빠른 왕복에서 이전 완료 처리가 마지막 선택을 덮지 않는다', async () => {
  const f = fixture();
  f.switchTab('tips');
  f.switchTab('faq');
  f.switchTab('tips');
  await settle(f.animations);
  assert.equal(f.radios['faq-radio-tips'].checked, true);
  assert.equal(f.panels[0].hidden, true);
  assert.equal(f.panels[1].hidden, false);
  assert.equal(f.panels[1].inert, false);
});

test('전환 중 언어 변경·리사이즈는 선택을 보존하고 애니메이션을 정리한다', async () => {
  const f = fixture();
  f.switchTab('tips');
  f.setLanguage('ja');
  assert.equal(f.panels[1].items[0].title.childNodes[0].text, 'ja/tips/0/title');
  assert.equal(f.panels[0].hidden, true);
  f.switchTab('faq');
  f.container.width = 440;
  f.resize();
  await settle(f.animations);
  assert.equal(f.panels[0].hidden, false);
  assert.equal(f.panels[1].hidden, true);
  assert.equal(f.container.classList.contains('home-resources__language--switching'), false);
});

test('감소된 모션에서는 즉시 전환하고 숨길 패널의 초점을 라디오로 옮긴다', () => {
  const f = fixture({ reduced: true });
  f.document.activeElement = f.panels[0].items[0].summary;
  f.switchTab('tips');
  assert.equal(f.animations.length, 0);
  assert.equal(f.panels[0].hidden, true);
  assert.equal(f.document.activeElement, f.radios['faq-radio-tips']);
});

test('잘못된 탭은 무시하고 알 수 없는 언어는 한국어로 표시한다', () => {
  const f = fixture();
  f.switchTab('invalid');
  assert.equal(f.animations.length, 0);
  assert.equal(f.radios['faq-radio-faq'].checked, true);
  f.setLanguage('ja');
  f.setLanguage('invalid');
  assert.equal(f.container.lang, 'ko');
  assert.equal(f.panels[0].hidden, false);
});

 test('카드 펼침·접힘과 빠른 반전이 마지막 상태로 정착한다', async () => {
  const f = fixture();
  const item = f.panels[0].items[0];
  item.summary.height = 60;
  f.toggle(item);
  assert.equal(item.open, true);
  assert.equal(f.animations[0].frames[0].height, '60px');
  assert.equal(f.animations[0].frames[1].height, '200px');
  f.toggle(item);
  assert.equal(item.body.inert, true);
  assert.equal(f.animations[1].frames[1].height, '60px');
  f.toggle(item);
  await settle(f.animations);
  assert.equal(item.open, true);
  assert.equal(item.body.inert, false);
  assert.equal(item.classList.contains('ui-disclosure--closing'), false);
  f.toggle(item);
  await settle(f.animations);
  assert.equal(item.open, false);
});

test('카드 전환 중 언어 변경과 탭 이동은 목표 열림 상태를 보존한다', async () => {
  const f = fixture();
  const item = f.panels[0].items[0];
  f.toggle(item);
  f.setLanguage('ja');
  assert.equal(item.open, true);
  f.toggle(item);
  f.switchTab('tips');
  await settle(f.animations);
  assert.equal(item.open, false);
  assert.equal(item.body.inert, false);
});

test('감소된 모션에서는 카드도 즉시 열리고 닫힌다', () => {
  const f = fixture({ reduced: true });
  const item = f.panels[0].items[0];
  f.toggle(item);
  assert.equal(item.open, true);
  f.toggle(item);
  assert.equal(item.open, false);
  assert.equal(f.animations.length, 0);
});
