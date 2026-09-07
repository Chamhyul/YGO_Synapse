const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const images = require('../public/illustration-images');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end);
}
function context(extra = {}) {
  const ctx = vm.createContext({ IllustrationImages: images, updateInputAutoWidth() {}, ...extra });
  vm.runInContext(fn('getIllustrationValue') + fn('setIllustrationValue'), ctx);
  return ctx;
}

test('표시 라벨을 선택/복원해도 제출값은 기존 CIID 문자열을 유지하고 초기화 시 제거된다', () => {
  const input = { value: '', dataset: {} };
  const ctx = context({ input });
  for (const [value, label] of [['1', '기본'], ['2', '2nd'], ['15', '15th']]) {
    ctx.setIllustrationValue(input, value);
    assert.equal(input.value, label);
    assert.equal(ctx.getIllustrationValue(input), value);
  }
  ctx.setIllustrationValue(input, '');
  assert.equal(ctx.getIllustrationValue(input), '');
  assert.equal(input.dataset.raw, '');
});

for (const mode of ['move', 'discard']) {
  test(`${mode}: 최신 재고 필터 결과가 1개라면 UI를 열지 않고 그 값을 선택한다`, () => {
    const input = { value: '기본', dataset: { raw: '1' } };
    let callbacks = 0;
    const wrapper = { dataset: { options: JSON.stringify([{ val: '1' }, { val: '9' }]) },
      _changeCallback() { callbacks++; } };
    const ctx = context({
      UIStore: { mode }, updateDropdownArrowState() {},
      updateMoveIllustsDynamic(w) { w.dataset.options = JSON.stringify([{ val: '9' }]); },
      updateDiscardIllustsDynamic(w) { w.dataset.options = JSON.stringify([{ val: '9' }]); },
      IllustrationPicker: { open() { assert.fail('단일 선택지 UI가 열림'); } },
    });
    vm.runInContext(fn('openIllustrationPicker'), ctx);
    ctx.openIllustrationPicker(input, wrapper);
    assert.equal(input.dataset.raw, '9');
    assert.equal(input.value, '9th');
    assert.equal(callbacks, 1);
  });

  test(`${mode}: 이미지 선택값은 기존 재고 필터와 레어도 갱신에 동일하게 전달된다`, () => {
    const input = { value: '15th', dataset: { raw: '15' } };
    const rows = [['카드', 'NO-1', 'N', 2, 'A', '1', '4007'], ['카드', 'NO-1', 'SR', 3, 'A', '15', '4007']];
    let passed;
    const ctx = context({
      getRowFromInput: () => ({}), getQueryTarget: () => ({ querySelector: () => ({ value: 'NO-1' }) }),
      cardCacheInstance: { getInventory: () => rows },
      document: { documentElement: { classList: { contains: () => false } } },
      updateMoveRarities(row, matches) { passed = matches; },
      updateDiscardRarities(row, matches) { passed = matches; },
    });
    const name = mode === 'move' ? 'handleMoveIllustChange' : 'handleDiscardIllustChange';
    vm.runInContext(fn(name), ctx);
    ctx[name](input);
    assert.equal(passed.length, 1);
    assert.equal(passed[0], rows[1]);
    assert.equal(input.value, '15th');
    assert.equal(input.dataset.raw, '15');
  });
}

test('행의 CID 확정은 번호나 팝업 없이 즉시 미리 로딩을 시작한다', () => {
  const calls = [];
  const row = { dataset: {} };
  const container = { dataset: {} };
  const ctx = context({
    IllustrationImages: { ...images, preloadCard(cid, ids) { calls.push({ cid, ids }); } },
    getRowFromInput: () => row,
  });
  vm.runInContext(fn('prepareCardIllustrations'), ctx);
  ctx.prepareCardIllustrations(container, '4007', [1, 15]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cid, '4007');
  assert.equal(row.dataset.illustrationCid, '4007');
  assert.equal(container.dataset.illustrationCid, '4007');
});
