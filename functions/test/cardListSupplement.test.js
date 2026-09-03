const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/script.js'), 'utf8');
const copy = value => structuredClone(value);

function fixture(initial = {}) {
  let disk = copy(initial);
  let fail = false;
  const context = vm.createContext({
    CardDataStore: {}, updateNormalizedNames() {},
    cardCacheInstance: { setAllKnownNames() {} }, console: { warn() {} },
  });
  vm.runInContext(source.slice(source.indexOf('const MasterDB = {'), source.indexOf('class ClientCache {')),
    context);
  const cache = vm.runInContext('CardListCache', context);
  const db = vm.runInContext('MasterDB', context);
  // 외부 DB에 연결하지 않고 트랜잭션 완료·실패와 저장 전 최신 읽기를 재현합니다.
  db.open = async () => ({ transaction() {
    const working = copy(disk);
    const tx = { objectStore() { return {
      get(key) {
        const request = {};
        queueMicrotask(() => { request.result = working[key]; request.onsuccess(); });
        return request;
      },
      put(value, key) { working[key] = copy(value); },
      delete(key) { delete working[key]; },
    }; } };
    setImmediate(() => {
      if (fail) { tx.error = new Error('저장 실패'); tx.onabort(); }
      else { disk = working; tx.oncomplete(); }
    });
    return tx;
  } });
  cache.init(disk);
  return { cache, db, context, get disk() { return disk; },
    failWrites() { fail = true; }, externalSupplement(value) { disk.cardListSupplement = value; } };
}

test('검색 결과는 즉시 사용하고 매니페스트와 분리 저장하여 재시작 시 복원한다', async () => {
  const f = fixture({ cardNames: ['기존'], cardNumbers: ['A-1'] });
  f.cache.rememberResponse('searchCardByName', { success: true, name: '신규', numbers: ['b-2', 'B-2'] });
  assert.deepEqual([...f.context.CardDataStore.allCardNames], ['기존', '신규']);
  assert.deepEqual([...f.context.CardDataStore.allCardNumbers], ['A-1', 'B-2']);
  await f.cache.pendingWrite;
  assert.deepEqual(f.disk.cardNames, ['기존']);
  assert.deepEqual([...f.disk.cardListSupplement.names], ['신규']);
  const reloaded = fixture(f.disk);
  assert.deepEqual([...reloaded.context.CardDataStore.allCardNames], ['기존', '신규']);
});

test('매니페스트에 포함된 이름과 번호만 각각 보충 목록에서 제거한다', async () => {
  const f = fixture({ cardNames: ['기존'], cardNumbers: [],
    cardListSupplement: { names: ['신규', '미반영'], numbers: ['A-1', 'B-2'] } });
  await f.cache.persist({ names: ['기존', '신규'], numbers: ['B-2'] });
  assert.deepEqual([...f.disk.cardListSupplement.names], ['미반영']);
  assert.deepEqual([...f.disk.cardListSupplement.numbers], ['A-1']);
  await f.cache.persist({ names: ['기존', '신규'], numbers: ['B-2'] });
  assert.ok(f.context.CardDataStore.allCardNames.includes('미반영'));
});

test('개별 크롤링·팩 다국어 응답을 기록하고 실패·대기·스탯을 제외한다', async () => {
  const f = fixture();
  f.cache.rememberResponse('searchCard', { success: true, isPendingCrawl: true, names: ['대기'] });
  f.cache.rememberResponse('searchCardByNo', { success: false, name: '실패' });
  f.cache.rememberResponse('crawlCardMetaByName', { success: true,
    mergedInfo: { 0: ['한국어', 1, { 'A-KR1': [] }], 10: ['스탯'] } });
  f.cache.rememberResponse('crawlPackCardsBatch', { success: true, results: [
    { info: { 1: ['日本語', 1, { 'A-JP1': [] }] } }, { isError: true, name: '실패' },
  ] });
  await f.cache.pendingWrite;
  assert.deepEqual([...f.context.CardDataStore.allCardNames], ['한국어', '日本語']);
  assert.deepEqual([...f.context.CardDataStore.allCardNumbers], ['A-KR1', 'A-JP1']);
});

test('다른 탭의 추가와 저장 중 도착한 결과를 보존한다', async () => {
  const f = fixture();
  f.externalSupplement({ names: ['다른 탭'], numbers: ['A-1'] });
  const syncing = f.cache.persist({ names: ['서버'], numbers: [] });
  f.cache.rememberResponse('searchCardByName', { success: true, name: '로컬', numbers: ['B-2'] });
  await syncing;
  await f.cache.pendingWrite;
  assert.deepEqual(new Set(f.disk.cardListSupplement.names), new Set(['다른 탭', '로컬']));
  assert.deepEqual(new Set(f.context.CardDataStore.allCardNames), new Set(['서버', '다른 탭', '로컬']));
});

test('매니페스트 저장 실패 시 기존 영구 데이터와 세션 보충 목록을 보존한다', async () => {
  const f = fixture({ cardNames: ['기존'], cardNumbers: [],
    cardListSupplement: { names: ['신규'], numbers: [] } });
  f.failWrites();
  await assert.rejects(f.cache.persist({ names: ['기존', '신규'], numbers: [] }), /저장 실패/);
  assert.deepEqual(f.disk.cardNames, ['기존']);
  assert.deepEqual([...f.cache.supplement.names], ['신규']);
});
