const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture: targetFixture } = require('../../scripts/test_helpers/target_search_fixture');
const source = fs.readFileSync(path.join(__dirname, '../../public/script.js'), 'utf8');

function cidSearchFixture(navigation) {
  const f = targetFixture();
  const requests = new Map();
  const renders = new Map();
  const updates = [], warnings = [];
  let hash = '', currentPane = f.area;
  f.context.UIStore = { currentRegion: 'ko' };
  f.context.switchToMode = () => {};
  f.context.console = { warn: (...args) => warnings.push(args) };
  f.context.ClientCache.getCardNameByCid = cid => `카드 ${cid}`;
  f.context.fetchCardMetaWithCache = cid => new Promise((resolve, reject) => {
    assert.ok(!requests.has(cid), '같은 카드의 메타데이터를 중복 요청하면 안 됩니다.');
    requests.set(cid, { resolve, reject });
  });
  f.context.updateSearchHash = (_type, state) => {
    hash = `#search?cid=${state.cid}`;
    updates.push(state.cid);
  };
  if (navigation) {
    // 탐색 계층의 화면 장착과 비동기 완료만 대체하며 두 렌더링 함수는 실제 코드를 실행합니다.
    f.context.SearchNavigation = {
      currentPane: () => currentPane,
      showTarget(state, render) {
        f.context.lastSearchState = state;
        hash = `#search?cid=${state.targetCid}`;
        currentPane = f.document.createElement('div');
        f.area.innerHTML = '';
        f.area.appendChild(currentPane);
        renders.set(state.targetCid, render(currentPane));
      },
      updateTarget(state, pane) {
        updates.push(state.targetCid);
        if (pane !== currentPane) return;
        f.context.lastSearchState = state;
        hash = `#search?cid=${state.targetCid}`;
      },
    };
  }
  return {
    ...f, requests, updates, warnings,
    start(cid) {
      const pending = f.context.renderTargetByCid(cid, null, true);
      return navigation ? Promise.all([pending, renders.get(cid)]) : pending;
    },
    get hash() { return hash; },
  };
}

function cardMetadata(cid) {
  return { cid, info: { ko: [`상세 카드 ${cid}`, [], {}, `카드 ${cid} 본문`, ''], 10: 1 } };
}

for (const navigation of [false, true]) {
  for (const outcome of ['success', 'failure', 'rejection']) {
    test(`CID 검색은 즉시 표시하고 이전 응답(${outcome})이 최신 화면·상태·주소를 바꾸지 않는다 (navigation=${navigation})`, async () => {
      const f = cidSearchFixture(navigation);
      const first = f.start('100');
      const firstCard = f.area.querySelector('.search-card');
      assert.equal(firstCard.querySelector('.search-card__title').textContent, '카드 100');
      assert.equal(firstCard.querySelector('.search-card__text-heading').textContent, '[카드 텍스트]');
      const firstText = firstCard.textContent;

      const second = f.start('200');
      assert.equal(f.area.querySelector('.search-card__title').textContent, '카드 200');
      f.requests.get('200').resolve(cardMetadata('200'));
      await second;
      assert.equal(f.area.querySelector('.search-card__title').textContent, '상세 카드 200');
      assert.equal(f.area.querySelector('.search-card__text-body').textContent, '카드 200 본문');
      assert.equal(f.context.lastSearchState.targetCid, '200');
      assert.equal(f.hash, '#search?cid=200');
      const latestState = f.context.lastSearchState;
      const latestText = f.area.textContent;
      const updateCount = f.updates.length;

      if (outcome === 'rejection') f.requests.get('100').reject(new Error('지연된 이전 요청 실패'));
      else f.requests.get('100').resolve(outcome === 'success' ? cardMetadata('100') : { success: false });
      await first;

      assert.equal(f.area.textContent, latestText);
      assert.equal(firstCard.textContent, firstText, '이전 카드도 늦은 응답으로 다시 그리지 않습니다.');
      assert.equal(f.context.lastSearchState, latestState);
      assert.equal(f.hash, '#search?cid=200');
      assert.equal(f.updates.length, updateCount, '이전 요청은 탐색 상태 갱신을 시도하지 않습니다.');
      assert.deepEqual([...f.requests.keys()], ['100', '200']);
      assert.equal(f.warnings.length, outcome === 'rejection' ? 1 : 0);
    });
  }
}

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
