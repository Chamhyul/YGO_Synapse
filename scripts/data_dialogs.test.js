const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { attachResultModal } = require('./test_helpers/result_modal_fixture');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function fixture(extra = {}) {
  const nodes = new Map(), instances = new Map(), readers = [], timers = new Map(), calls = [];
  let clock = 0;
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { id, disabled: false, hidden: false, checked: false, value: '', files: [],
      textContent: '', innerHTML: '', className: '', attributes: {}, children: [],
      dataset: {},
      style: new Proxy({}, { set() { assert.fail('검증/실행 상태에 인라인 스타일을 추가하지 않는다'); } }),
      setAttribute(key, value) { this.attributes[key] = value; }, appendChild(el) { this.children.push(el); },
      querySelectorAll() { return [element(id + '-close'), element(id + '-cancel'), element(id === 'migration-modal' ? 'migration-exec-btn' : 'data-clear-exec-btn')]; }
    });
    return nodes.get(id);
  };
  attachResultModal(element, 'migration-result-modal');
  const instance = el => {
    if (!instances.has(el.id)) instances.set(el.id, { options: { dismissible: true }, open() { calls.push(['open', el.id]); }, close() { calls.push(['close', el.id]); } });
    return instances.get(el.id);
  };
  const context = vm.createContext({ document: { getElementById: element, createElement: tag => ({ tag }) },
    M: { Modal: { getInstance: instance } }, getAppModal: instance, AppDataTransfer: require('../public/data-transfer'), AppManagementResults: require('../public/management-results'), IllustrationImages: require('../public/illustration-images'), URL, Uint8Array, TextDecoder,
    UserStore: { user: { uid: 'synthetic-a' } },
    setTimeout(fn) { const id = ++clock; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    FileReader: class {
      constructor() { this.readyState = 0; readers.push(this); }
      readAsArrayBuffer(file) { this.readyState = 1; this.file = file; }
      abort() { this.readyState = 2; }
      finish(csv) { this.readyState = 2; this.onload({ target: { result: new TextEncoder().encode(csv).buffer } }); }
    },
    checkAuthBeforeAction: () => !!context.UserStore.user,
    getLocalizedRarity: text => text === 'SE' ? '시크릿 레어' : text,
    escapeHTML: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    cardCacheInstance: { clearAll() { calls.push('clear-cache'); } }, loadUserData: async () => calls.push('load-user'),
    showToast: text => calls.push(['toast', text]), switchToMode() {},
    ...extra
  });
  vm.runInContext('let migrationValidationTimeout = null;', context);
  const begin = source.indexOf('let pendingMigrationData = null;');
  vm.runInContext(source.slice(begin, source.indexOf('function checkAuthBeforeAction()', begin)), context);
  const deletion = source.indexOf('function openDataClearModal()');
  vm.runInContext(source.slice(deletion, source.indexOf('function signOutCurrentUser()', deletion)), context);
  function choose(csv, name = 'test.csv') {
    const node = element('migration-file-input'); node.files = [{ name }];
    context.handleMigrationFileUpload({ target: node }); readers.at(-1).finish(csv);
  }
  return { context, element, instance, readers, calls, choose, runTimer: async () => {
    const [id, fn] = [...timers].at(-1); timers.delete(id); await fn();
  } };
}
const csv = require('../public/data-transfer').toCsv([['가상 카드', 'TEST-KR001', 'SE', 4, '검증용 장소', '2']]);
const done = { success: true, importedItems: [{ cardNo: 'TEST-KR001', name: '가상 카드', cid: '42', rarity: 'SE', loc: '검증용 장소', illustration: '2', qty: 4 }] };
test('파일 변경·탭 변경·닫기 후 재열기의 늦은 파일 응답은 실행을 활성화하지 않는다', () => {
  const f = fixture(), input = f.element('migration-file-input');
  f.context.openMigrationModal('file');
  input.files = [{ name: 'first.csv' }]; f.context.handleMigrationFileUpload({ target: input });
  const old = f.readers.at(-1);
  input.files = [{ name: 'second.csv' }]; f.context.handleMigrationFileUpload({ target: input });
  old.finish(csv); assert.equal(f.element('migration-exec-btn').disabled, true);
  f.readers.at(-1).finish(csv); assert.equal(f.element('migration-exec-btn').disabled, false);
  f.context.toggleMigrationTab('sheet'); old.finish(csv);
  assert.equal(f.element('migration-exec-btn').disabled, true);
  f.context.openMigrationModal('file');
  old.finish(csv); assert.equal(f.element('migration-exec-btn').disabled, true);
});
test('잘못된 파일/UTF-8/빈 수량을 거부하고 0장 제외는 실행 전에 안내한다', () => {
  const f = fixture(); f.context.openMigrationModal('file');
  f.choose(csv + '\r\n"가상","TEST-2","N","0","서랍","1"');
  assert.match(f.element('migration-status-msg').textContent, /0인 1개 행/);
  assert.equal(f.element('migration-exec-btn').disabled, false);
  f.choose(csv.replace('"4"', '""'));
  assert.equal(f.element('migration-exec-btn').disabled, true);
  assert.equal(f.element('migration-status-msg').className, 'color-text-red');
  f.choose(csv, 'unsupported.txt'); assert.equal(f.element('migration-exec-btn').disabled, true);
  const node = f.element('migration-file-input'); node.files = [{ name: 'broken.csv' }];
  f.context.handleMigrationFileUpload({target:node});
  f.readers.at(-1).onload({ target: { result: Uint8Array.from([0xff, 0xff]).buffer } });
  assert.equal(f.element('migration-status-msg').textContent, '양식에 맞는 파일을 골라주세요.');
  assert.equal(f.element('migration-file-guide').hidden, true);
  f.choose(csv);
  assert.equal(f.element('migration-file-guide').hidden, false);
  assert.equal(f.element('migration-exec-btn').disabled, false);
  f.choose(csv.replace('"4"', '"0"'));
  assert.match(f.element('migration-status-msg').textContent, /수량 0인 1개 행을 제외/);
  assert.equal(f.element('migration-exec-btn').disabled, true);
});
test('이전 링크·탭·계정 응답으로 가져오기 버튼이 활성화되지 않는다', async () => {
  let resolve; const f = fixture({ callApi: () => new Promise(done => { resolve = done; }) });
  f.context.openMigrationModal('sheet');
  const input = f.element('migration-sheet-url'); input.value = 'https://docs.google.com/spreadsheets/d/' + 'a'.repeat(30);
  f.context.validateMigrationLink(); const pending = f.runTimer();
  input.value = 'https://docs.google.com/spreadsheets/d/' + 'b'.repeat(30);
  f.context.validateMigrationLink();
  resolve({ status: 'OK', totalQty: 4, rowCount: 1, fingerprint: 'old' }); await pending;
  assert.equal(f.element('migration-exec-btn').disabled, true);
  const next = f.runTimer(); f.context.UserStore.user = { uid: 'synthetic-b' };
  resolve({ status: 'OK', totalQty: 4, rowCount: 1, fingerprint: 'next' }); await next;
  assert.equal(f.element('migration-exec-btn').disabled, true);
  assert.equal(f.context.getMigrationSheetId('https://evil.invalid/?url=https://docs.google.com/spreadsheets/d/' + 'a'.repeat(30)), null);
});
test('가져오기 중 중복 실행·닫기·편집을 차단하고 완료 후 잠금을 해제한다', async () => {
  let resolve, requests = 0;
  const f = fixture({ callApi: async () => { requests++; return new Promise(done => { resolve = done; }); } });
  f.context.openMigrationModal('file'); f.choose(csv);
  const pending = f.context.executeMigration(); await f.context.executeMigration();
  const modal = f.element('migration-modal');
  assert.equal(requests, 1); assert.equal(f.instance(modal).options.dismissible, false);
  assert.equal(f.element('migration-modal-close').disabled, true);
  assert.equal(f.element('migration-modal-cancel').disabled, true);
  assert.equal(f.element('migration-spinner').hidden, false);
  resolve(done); await pending;
  assert.equal(f.instance(modal).options.dismissible, true);
  assert.equal(f.element('migration-modal-close').disabled, false);
  assert.equal(f.element('migration-spinner').hidden, true);
  assert.match(f.element('migration-success-text').textContent, /1종 · 4장/);
  assert.equal(f.calls.includes('clear-cache'), true);
});
test('가져오기 실패는 재시도를 허용하고 계정 변경 후 늦은 완료는 새 계정에 적용하지 않는다', async () => {
  let resolve; const f = fixture({ callApi: () => new Promise(done => { resolve = done; }) });
  f.context.openMigrationModal('file'); f.choose(csv);
  const failed = f.context.executeMigration(); resolve({ success: false, message: '가상 오류' }); await failed;
  assert.equal(f.element('migration-exec-btn').disabled, false);
  assert.match(f.element('migration-status-msg').textContent, /가상 오류/);
  const pending = f.context.executeMigration(); f.context.UserStore.user = { uid: 'synthetic-b' };
  resolve(done); await pending;
  assert.equal(f.element('migration-exec-btn').disabled, true);
  assert.equal(f.calls.includes('clear-cache'), false);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'open' && call[1] === 'migration-result-modal'), false);
});
test('전체 삭제도 진행 중 닫기를 차단하고 오류 이후 취소와 재시도를 복구한다', async () => {
  let reject, requests = 0;
  const f = fixture({ callApi: () => { requests++; return new Promise((_, no) => { reject = no; }); } });
  f.context.openDataClearModal(); const pending = f.context.executeDataClear(); await f.context.executeDataClear();
  assert.equal(requests, 1);
  assert.equal(f.instance(f.element('data-clear-confirm-modal')).options.dismissible, false);
  assert.equal(f.element('data-clear-confirm-modal-close').disabled, true);
  reject(Error('가상 서버 오류')); await pending;
  assert.equal(f.instance(f.element('data-clear-confirm-modal')).options.dismissible, true);
  assert.equal(f.element('data-clear-exec-btn').disabled, false);
  assert.equal(f.element('data-clear-status-msg').className, 'color-text-red');
});
test('결과는 5종·나머지 추가 매수, 전체 상세, 이스케이프와 구형 응답의 집계 한계를 표시한다', () => {
  const f = fixture();
  f.context.showMigrationResultModal({ importedItems: Array.from({ length: 7 }, (_, i) => ({ ...done.importedItems[0], cid: String(i), name: '<가상 카드>', qty: i + 1 })) });
  assert.equal((f.element('migration-summary-body').innerHTML.match(/<li /g) || []).length, 5);
  assert.equal((f.element('migration-detail-body').innerHTML.match(/<tr>/g) || []).length, 7);
  assert.equal(f.element('migration-summary-rest').textContent, '그 외 13장');
  assert.match(f.element('migration-detail-body').innerHTML, /&lt;가상 카드&gt;/);
  f.context.toggleMigrationResultView('detail'); assert.equal(f.element('migration-summary-table-box').hidden, true);
  f.context.showMigrationResultModal({ updatedItems: [{ qty: 999 }] });
  assert.match(f.element('migration-success-text').textContent, /집계를 확인할 수 없습니다/);
  assert.equal(f.element('migration-summary-body').textContent, '');
  assert.equal(f.element('migration-summary-table-box').hidden, false);
  assert.equal(f.element('migration-detail-table-box').hidden, true);
  assert.equal(f.element('migration-summary-body').innerHTML, '');
});

test('검증 후 계정을 바꾸면 이전 파일로 새 계정 가져오기를 실행하지 않는다', async () => {
  const f = fixture({ callApi() { assert.fail('계정 변경 전에 검증한 파일의 저장 요청 금지'); } });
  f.context.openMigrationModal('file'); f.choose(csv);
  f.context.UserStore.user = {uid:'synthetic-b'};
  await f.context.executeMigration();
  assert.equal(f.element('migration-exec-btn').disabled, true);
  assert.match(f.element('migration-status-msg').textContent, /계정이 변경/);
});
