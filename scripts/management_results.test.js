const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const results = require('../public/management-results');
const { attachResultModal } = require('./test_helpers/result_modal_fixture');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(operation, callApi) {
  const calls = [], cards = [];
  const container = { querySelectorAll: () => cards.filter(card => !card.removed),
    innerHTML: '', querySelector: () => null };
  const main = { classList: { contains: () => false } };
  function card(no = 'A', qty = 2) {
    const node = { dataset: {}, removed: false, data: { cardNo: no, name: '가상 카드', rarity: 'N', illustration: '1', loc: '서랍', to: '선반', qty },
      querySelector(selector) {
        if (selector.includes('name')) return { placeholder: '', value: '가상 카드' };
        if (selector.includes('rare')) return { value: 'N' };
        if (selector.includes('qty')) return { max: 5 };
        return { value: no };
      }, remove() { this.removed = true; } };
    cards.push(node); return node;
  }
  const context = vm.createContext({ AppManagementResults: results,
    document: { documentElement: { classList: { contains: () => false } },
      getElementById: id => id.includes('cards-list') ? container : id.includes('submit') ? main : { dataset: { hasSuccess: 'true' } } },
    UserStore: { user: { uid: 'synthetic-a' } }, UIStore: { chipState: { add: 'general' } }, addSubMode: 'general', syncCounter: 0,
    getDesktopCardData: node => node.data, findCidByNameOrNo: () => '42', buildAuthPayload: () => ({}),
    callApi, showLoading() {}, updateLocalInventory() { calls.push('cache'); }, updateTotals() {},
    cardCacheInstance: { setSummary() {} }, showToast: text => calls.push(['toast', text]),
    desktopAddEntry: () => calls.push('new-row'), reindexDesktopCards() {}, refreshInitialData() {},
    showResultModal: (...args) => calls.push(['add', ...copy(args)]),
    showDiscardResultModal: (...args) => calls.push(['discard', ...copy(args)]),
    showMoveResultModal: (...args) => calls.push(['move', ...copy(args)])
  });
  function section(begin, end) {
    const start = source.indexOf(begin); assert.ok(start >= 0, begin);
    vm.runInContext(source.slice(start, source.indexOf(end, start + begin.length)), context);
  }
  section('let managementRequestPending = false;', 'function showResultModal(');
  section('async function submitPageEntries()', 'async function submitDiscardEntries()');
  section('async function submitDiscardEntries()', 'function decomposeHangul(');
  section('async function submitMoveEntries()', 'async function submitBulkMoveEntries()');
  section('async function submitBulkMoveEntries()', 'function adjustStepQty(');
  section('async function handleContinueRegistration()', '/**');
  section('async function handleContinueDiscard()', 'async function submitPageEntries()');
  section('async function finishMoveProcess()', 'async function submitMoveEntries()');
  return { context, card, calls, run: () => context[operation === 'add' ? 'submitPageEntries' : operation === 'discard' ? 'submitDiscardEntries' : 'submitMoveEntries'](),
    close: () => context[operation === 'add' ? 'handleContinueRegistration' : operation === 'discard' ? 'handleContinueDiscard' : 'finishMoveProcess']() };
}
for (const operation of ['add', 'discard', 'move']) {
  test(`${operation}: 서버 거부·통신 오류의 입력을 결과창 종료 후에도 보존한다`, async () => {
    for (const api of [async () => ({ success: false, message: '합성 저장 실패' }), async () => { throw Error('합성 연결 실패'); }]) {
      const f = fixture(operation, api), row = f.card(); await f.run(); await f.close();
      assert.equal(row.removed, false);
      assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === operation), true);
    }
  });
  test(`${operation}: 혼합 결과는 성공 행만 정리하며 실제 확인 매수로 집계한다`, async () => {
    const f = fixture(operation, async () => ({ success: true, updatedItems: [], operationResults: [
      { requestIndex: 0, status: 'success', qty: 2 }, { requestIndex: 1, status: 'fail', qty: 0, failReason: 'insufficient_qty' }
    ] }));
    const first = f.card(), second = f.card(); await f.run(); await f.close();
    assert.equal(first.removed, true); assert.equal(second.removed, false);
    const rendered = f.calls.find(call => Array.isArray(call) && call[0] === operation);
    const logs = operation === 'move' ? rendered[1] : rendered[3];
    assert.equal(results.summarize(logs).totalQty, 2); assert.equal(results.summarize(logs).failCount, 1);
  });
}
test('응답 지연 중 중복 실행·계정 전환 뒤 이전 응답의 화면 반영을 막는다', async () => {
  let resolve, requests = 0;
  const f = fixture('add', async () => { requests++; return new Promise(done => { resolve = done; }); });
  const row = f.card(), pending = f.run(); await f.run(); assert.equal(requests, 1);
  assert.equal(row.dataset.status, 'pending');
  f.context.UserStore.user = { uid: 'synthetic-b' };
  resolve({ success: true, updatedItems: [], operationResults: [{ requestIndex: 0, status: 'success', qty: 2 }] }); await pending;
  assert.equal(f.calls.length, 0); assert.equal(row.removed, false);
});
test('구형·중복·수량 불일치 응답을 저장 성공으로 추정하지 않는다', () => {
  const request = [{ name: '가상 카드', qty: 2 }];
  for (const response of [{ success: true, updatedItems: [{ qty: 20 }] },
    { success: true, operationResults: [{ requestIndex: 0, status: 'success', qty: 1 }] },
    { success: true, operationResults: [{ requestIndex: 0, status: 'success', qty: 2 }, { requestIndex: 0, status: 'success', qty: 2 }] }]) {
    assert.equal(results.reconcile(request, response)[0].status, 'fail');
  }
});
test('저장 후 캐시 갱신 실패를 저장 실패로 바꾸지 않는다', async () => {
  const f = fixture('add', async () => ({ success: true, operationResults: [{ requestIndex: 0, status: 'success', qty: 2 }] }));
  f.context.updateLocalInventory = () => { throw Error('합성 표시 오류'); };
  const row = f.card(); await f.run(); await f.close(); assert.equal(row.removed, true);
});
test('일괄 이동 실패도 결과창을 표시하고 일부 실패 시 이동 입력 모드를 유지한다', async () => {
  for (const outcome of ['partial', 'server', 'network']) {
    const f = fixture('move', async () => {
      if (outcome === 'network') throw Error('합성 연결 실패');
      if (outcome === 'server') return { success: false, message: '합성 서버 실패' };
      return { success: true, updatedItems: [], operationResults: [
        { requestIndex: 0, status: 'success', qty: 2 }, { requestIndex: 1, status: 'fail', qty: 0, failReason: 'no_inventory' }
      ] };
    });
    const get = f.context.document.getElementById;
    f.context.document.getElementById = id => id === 'rename-from-input' ? { value: '서랍' } : id === 'rename-to-input' ? { value: '선반' } : get(id);
    f.context.cardCacheInstance._inventory = [['가상 카드', 'A', 'N', 2, '서랍', '1'], ['가상 카드2', 'B', 'N', 2, '서랍', '1']];
    f.context.toggleRenameMode = () => f.calls.push('mode-closed');
    await f.context.submitBulkMoveEntries();
    assert.equal(f.calls.includes('mode-closed'), false);
    assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'move'));
  }
});
test('현재 결과 렌더러는 새 오류 식별자를 표시하고 입력 로그를 덮어쓰지 않는다', () => {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, innerHTML: '', innerText: '', style: {}, children: [], appendChild(node) { this.children.push(node); } });
    return nodes.get(id);
  };
  ['add', 'move', 'discard'].forEach(op => attachResultModal(element, `${op}-result-modal`));
  const context = vm.createContext({ UserStore: { settings: { isDetailMode: false } }, IllustrationImages: require('../public/illustration-images'), getAppModal: () => ({ open() {} }), document: { getElementById: element, createElement: () => element('tr-' + nodes.size) },
    AppManagementResults: results, escapeHTML: text => String(text ?? ''), getLocalizedRarity: text => text,
    M: { Modal: { getInstance: () => ({ open() {} }) } }, setTimeout() {},
    cardCacheInstance: { getOwnedNumbers() { assert.fail('저장 후 변경된 캐시로 성공 여부를 재판정하지 않는다'); } }
  });
  const begin = source.indexOf('function showResultModal(');
  vm.runInContext(source.slice(begin, source.indexOf('async function handleContinueDiscard()', begin)), context);
  const move = source.indexOf('function showMoveResultModal(');
  vm.runInContext(source.slice(move, source.indexOf('async function finishMoveProcess()', move)), context);
  for (const [fn, body] of [['showResultModal', 'result-summary-body'], ['showDiscardResultModal', 'discard-summary-body']]) {
    const logs = [{ no: 4, status: 'fail', failReason: 'no_illustration', cardNo: 'A', name: '가상 카드', qty: 2 }], before = copy(logs);
    context[fn](0, 0, logs);
    assert.match(element(body).innerHTML, /일러스트 미선택/); assert.doesNotMatch(element(body).innerHTML, /no_illustration/);
    assert.deepEqual(logs, before);
  }
  const logs = [{ status: 'success', cardNo: 'A', cardName: '가상 카드', moveQty: 2, processedQty: 2, illustration: '1', rarity: 'N', currentLoc: '서랍', targetLoc: '선반' }];
  context.showMoveResultModal(logs); assert.equal(logs[0].cardNo, 'A');
});
test('성공 요약은 최대 5개·나머지 매수, 실패 이유는 모두 집계하고 원본을 변경하지 않는다', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ status: 'success', name: `가상 ${index}`, processedQty: index + 1 }));
  items.push({ status: 'fail', failReason: 'no_illustration' }, { status: 'fail', failReason: 'no_rarity' });
  const before = copy(items), summary = results.summarize(items);
  assert.equal(summary.summary.length, 5); assert.equal(summary.restQty, 21); assert.equal(summary.failures.length, 2);
  assert.equal(summary.totalQty, 36); assert.deepEqual(items, before);
  assert.equal(summary.failures[0].reason, '일러스트 미선택');
});

test('공통 결과 표시는 원본·식별자를 보존하고 실패 열과 일러스트·레어도 표시를 전환한다', () => {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, innerHTML: '', textContent: '', hidden: false, checked: false });
    return nodes.get(id);
  };
  const modal = attachResultModal(element, 'move-result-modal');
  const options = { formatIllustration: require('../public/illustration-images').label, formatRarity: value => value === 'SE' ? '시크릿 레어' : value };
  const logs = [
    { no: 3, status: 'success', cid: '42', cardName: '<검증용 카드>', cardNo: 'TEST-JP001', illustration: '2', rarity: 'SE', currentLoc: 'A', targetLoc: 'B', moveQty: 4, processedQty: 4 },
    { no: 7, status: 'fail', failReason: 'no_target_loc', cardName: '실패 입력', cardNo: 'TEST-KR002', illustration: '1', currentLoc: 'A', targetLoc: '', moveQty: 2 }
  ];
  const before = copy(logs);
  results.render(modal, logs, options);
  assert.equal(modal.querySelector('[data-result-detail] table').dataset.hasFailures, 'true');
  assert.equal(modal.querySelector('th[data-column="quantity"]').textContent, '수량 • 실패 사유');
  const html = element('move-result-body').innerHTML;
  assert.match(html, /&lt;검증용 카드&gt;/);
  assert.match(html, /data-column="illustration">2nd/);
  assert.match(html, /시크릿 레어/);
  assert.match(html, /2장<br>이동 위치 미선택/);
  assert.match(html, /data-column="sequence">7/);
  assert.doesNotMatch(html, /style=|no_target_loc/);
  results.setView(modal, 'detail');
  assert.equal(element('move-summary-table-box').hidden, true);
  assert.equal(element('move-result-detail-box').hidden, false);
  results.render(modal, [logs[0]], options);
  assert.equal(modal.querySelector('[data-result-detail] table').dataset.hasFailures, 'false');
  assert.equal(modal.querySelector('th[data-column="quantity"]').textContent, '수량');
  assert.deepEqual(logs, before);
});
