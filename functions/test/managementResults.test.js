// 함수·저장·인증을 모두 격리한다. 실제 Firebase 연결은 사용하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const copy = value => JSON.parse(JSON.stringify(value));
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, console: { error() {} }, Buffer, Date,
    require(name) { if (!Object.hasOwn(mocks, name)) throw Error(`격리되지 않은 의존성: ${name}`); return mocks[name]; }
  });
  return module.exports;
}
const stock = () => ({ version: 3, amount: 5, locations: { 서랍: ['A'] }, rarities: { N: 5 },
  cards: { A: { name: '가상 카드', cid: '42', items: [{ rarity: 'N', loc: '서랍', illustration: '1', qty: 5 }] } } });
const item = qty => ({ cardNo: 'A', rarity: 'N', illustration: '1', loc: '서랍', currentLoc: '서랍', targetLoc: '선반', qty, moveQty: qty });
function fixture() {
  let saved = stock(), generation = '1', concurrent = null;
  const migration = { normalizeIllustrationId: value => String(value || '1'), prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
  const admin = { storage: () => ({ bucket: () => ({ file: (_, options) => ({
    getMetadata: async () => [{ generation }], download: async () => { assert.equal(options.generation, generation); return [Buffer.from(JSON.stringify(saved))]; },
    save: async (body, options) => {
      if (concurrent) { const fn = concurrent; concurrent = null; fn(saved); generation = String(Number(generation) + 1); }
      if (options.preconditionOpts.ifGenerationMatch !== generation) throw Object.assign(Error('충돌'), { code: 412 });
      saved = JSON.parse(body); generation = String(Number(generation) + 1);
    }
  }) }) }) };
  const storage = load('utils/inventoryStorage.js', { '../config/firebase': { admin }, '../services/inventoryMigrationService': migration });
  const routes = load('routes/card.js', {
    '../services/cardService': { resolveCardNumber: async number => number }, 'firebase-functions/v2/https': { onRequest: (_, fn) => fn },
    '../config/firebase': { admin }, '../utils/common': {}, '../utils/auth': { setCors() {}, verifyRegisteredUser: async () => 'synthetic-user' },
    '../scrapers/cardScraper': {}, '../utils/inventoryStorage': storage, '../services/cardQueryService': {},
    '../services/inventoryMigrationService': { ...migration, resolveGroupCids: async groups => { for (const group of Object.values(groups)) group.cid = '42'; } },
    '../utils/indexStorage': {}
  });
  return { storage, get saved() { return saved; }, concurrent(fn) { concurrent = fn; }, async call(name, payload) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = copy(body); return this; } };
    await routes[name]({ method: 'POST', body: payload }, res); return res;
  } };
}
for (const [route, field] of [['moveCards', 'moves'], ['discardCards', 'discards']]) {
  test(`${route}: 중복 행은 최신 잔량으로 처리하고 초과 행은 재고를 변경하지 않는다`, async () => {
    const f = fixture(), res = await f.call(route, { [field]: [item(3), item(3), { ...item(1), cardNo: 'UNKNOWN' }] });
    assert.deepEqual(res.body.operationResults, [
      { requestIndex: 0, status: 'success', qty: 3 },
      { requestIndex: 1, status: 'fail', qty: 0, failReason: 'insufficient_qty' },
      { requestIndex: 2, status: 'fail', qty: 0, failReason: 'no_inventory' }
    ]);
    assert.equal(f.saved.cards.A.items.find(x => x.loc === '서랍').qty, 2);
    if (route === 'moveCards') {
      assert.equal(f.saved.amount, 5); assert.equal(f.saved.rarities.N, 5);
      assert.equal(f.saved.cards.A.items.find(x => x.loc === '선반').qty, 3);
      assert.deepEqual(f.saved.locations.선반, ['A']);
    } else { assert.equal(f.saved.amount, 2); assert.equal(f.saved.rarities.N, 2); }
  });
  test(`${route}: 소수·음수·0·과대 수량은 변경 없이 거부한다`, async () => {
    const f = fixture(), res = await f.call(route, { [field]: [item(1.5), item(-1), item(0), item(6)] });
    assert.deepEqual(f.saved, stock());
    assert.equal(res.body.operationResults.filter(x => x.status === 'success').length, 0);
  });
  test(`${route}: Storage 충돌 재시도는 마지막 저장의 실제 결과만 반환한다`, async () => {
    const f = fixture(); f.concurrent(data => { data.cards.A.items[0].qty = 1; data.amount = 1; data.rarities.N = 1; });
    const res = await f.call(route, { [field]: [item(3)] });
    assert.deepEqual(res.body.operationResults, [{ requestIndex: 0, status: 'fail', qty: 0, failReason: 'insufficient_qty' }]);
    assert.equal(f.saved.cards.A.items[0].qty, 1); assert.equal(f.saved.amount, 1);
  });
}
test('등록: 입력 순번·이번 추가량은 응답에만 있고 최종 재고량 및 저장 형식과 구분한다', async () => {
  const f = fixture(), res = await f.call('addCards', { rows: [['가상 카드', 'A', 'N', 2, '서랍', '1'], ['가상 카드', 'A', 'N', 1.5, '서랍', '1'], ['가상 카드', 'A', 'N', 4, '서랍', '1']] });
  assert.deepEqual(res.body.operationResults.sort((a,b) => a.requestIndex - b.requestIndex), [
    { requestIndex: 0, status: 'success', qty: 2 }, { requestIndex: 1, status: 'fail', qty: 0, failReason: 'invalid_qty' }, { requestIndex: 2, status: 'success', qty: 4 }
  ]);
  assert.equal(f.saved.amount, 11); assert.equal(f.saved.cards.A.items[0].qty, 11);
  const added = await f.call('addCards', { rows: [['새 가상 카드', 'B', 'SE', 3, '책장', '2']] });
  assert.equal(added.body.operationResults[0].qty, 3);
  assert.equal(Object.hasOwn(f.saved.cards.B.items[0], 'requestIndex'), false);
});
test('추가량과 목적지 합계가 안전 정수 범위를 넘으면 수량을 변경하지 않는다', () => {
  const f = fixture(), data = stock(), before = copy(data);
  const outcomes = [];
  f.storage.processAddCards(data, { B: { name: '가상 카드', items: [{ requestIndex: 0, qty: Number.MAX_SAFE_INTEGER, rarity: 'N', loc: '서랍', illustration: '1' }] } }, outcomes);
  assert.deepEqual(data, before); assert.equal(outcomes[0].status, 'fail');
  data.cards.A.items.push({ rarity: 'N', loc: '선반', illustration: '1', qty: Number.MAX_SAFE_INTEGER });
  const moveBefore = copy(data), moves = [];
  f.storage.processMoveCards(data, [item(1)], moves);
  assert.deepEqual(data, moveBefore); assert.equal(moves[0].status, 'fail');
});
