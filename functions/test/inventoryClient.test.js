const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/script.js'), 'utf8');

test('늦게 완료된 CID 검색은 다음 검색 화면을 덮어쓰지 않는다', async () => {
  let finish;
  let renders = 0;
  const context = vm.createContext({
    switchToMode() {}, UIStore: {},
    ClientCache: { getCardNameByCid: () => '카드', registerCid() {} },
    fetchCardMetaWithCache: () => new Promise(resolve => { finish = resolve; }),
    getInventoryRowsByCidOrName: () => [],
    renderTargetSearchResult: async () => { renders++; },
    console,
  });
  const start = source.indexOf('async function renderTargetByCid(');
  const end = source.indexOf('async function renderTargetSearchResult(', start);
  vm.runInContext(`let searchSequence = 0;\n${source.slice(start, end)}`, context);
  const pending = vm.runInContext("renderTargetByCid('123', null, true)", context);
  vm.runInContext('searchSequence++', context);
  finish({ success: false });
  await pending;
  assert.equal(renders, 0);
});

function migrationContext(callApi) {
  const timers = [];
  const context = vm.createContext({
    UserStore: { user: { uid: 'A' } }, document: { hidden: false },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {}, callApi, Date,
  });
  const start = source.indexOf('let inventoryMigrationTimer = null;');
  const end = source.indexOf('function applyUserData(', start);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("scheduleInventoryMigration({ inventoryVersion: 1, inventoryMigration: { status: 'pending' } })", context);
  return { context, timers };
}

test('이관 상태 조회의 실패 응답은 재시도를 예약한다', async () => {
  const { context, timers } = migrationContext(async () => ({ success: false }));
  await timers[0].fn();
  assert.equal(timers.length, 2);
  assert.ok(timers[1].delay >= 30000);
  assert.equal(context.UserStore.inventoryMigration.status, 'retryableError');
});

test('이관 조회 도중 계정이 바뀌면 이전 계정의 재시도를 예약하지 않는다', async () => {
  let fail;
  const { context, timers } = migrationContext(() => new Promise((_, reject) => { fail = reject; }));
  const pending = timers[0].fn();
  context.UserStore.user = { uid: 'B' };
  fail(new Error('통신 실패'));
  await pending;
  assert.equal(timers.length, 1);
});
