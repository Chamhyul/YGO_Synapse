// 모든 인증·카드 조회·Google Sheets·Storage를 격리한다. 실제 계정/파일에 접근하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const copy = value => JSON.parse(JSON.stringify(value));
function load(file, mocks) {
  const filename = path.join(__dirname, '..', file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    console: { error() {} }, require(name) {
      if (!(name in mocks)) throw Error(`격리되지 않은 의존성: ${name}`);
      return mocks[name];
    } }, { filename });
  return module.exports;
}
const headers = ['카드 이름', '카드 번호', '레어도', '수량', '보관 위치', '일러스트'];
const input = qty => ({ name: '테스트 카드', no: 'AB-KR001', rare: 'SE', qty, loc: '서랍', illust: '2' });
function fixture({ values = [headers, ['테스트 카드', 'AB-KR001', 'SE', 4, '서랍', '2']], retry = false } = {}) {
  const service = load('services/migrationService.js', { '../integrations/googleSheets': {
    getSheetValues: async (_id, range) => { assert.equal(range, 'MyCard!A1:Z'); return values; }
  }, 'node:crypto': require('node:crypto') });
  const storage = load('utils/inventoryStorage.js', {
    '../config/firebase': { admin: { storage() { assert.fail('실제 Storage 접근 금지'); } } },
    '../services/inventoryMigrationService': { normalizeIllustrationId: value => String(value || '1').replace(/nd$/, '') }
  });
  let writes = 0, resolves = 0, saved;
  const routes = load('routes/migration.js', {
    'firebase-functions/v2/https': { onRequest: (_o, handler) => handler },
    '../utils/auth': { setCors() {}, verifyRegisteredUser: async () => 'synthetic' },
    '../utils/safeError': { safeErrorSummary: () => ({ type: 'internal_error' }) },
    '../services/migrationService': service,
    '../services/cardService': { resolveCardNumber: async no => { resolves++; return no; } },
    '../services/cardQueryService': { findCard: async () => null },
    '../services/inventoryMigrationService': {
      resolveGroupCids: async groups => Object.values(groups).forEach(group => { group.cid = '42'; }),
      inventoryMigrationStatus: () => ({ status: 'complete' }), normalizeIllustrationId: value => String(value || '1').replace(/nd$/, '')
    },
    '../utils/inventoryStorage': {
      updateInventoryWithRetry: async (_uid, fn) => {
        const base = () => ({ version: 3, amount: 10, cards: { 'AB-KR001': { items: [{ rarity: 'SE', loc: '서랍', illustration: '2', qty: 10 }] } } });
        if (retry) fn(base());
        saved = base(); fn(saved); writes++; return saved;
      },
      processAddCards: storage.processAddCards
    }
  });
  async function call(name, body, method = 'POST') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = copy(body); }, send() {} };
    await routes[name]({ method, body }, res); return res;
  }
  return { service, call, get writes() { return writes; }, get resolves() { return resolves; }, get saved() { return saved; } };
}
test('파일 추가' + ': 기존 10장에 수량 4장을 더하되 결과는 추가량 4장이다', async () => {
  const f = fixture(), res = await f.call('migrateFromData', { data: [input(4)] });
  assert.equal(res.statusCode, 200);
  assert.equal(f.saved.amount, 14);
  assert.equal(res.body.updatedItems[0].qty, 14);
  assert.equal(res.body.importedItems[0].qty, 4);
  assert.equal(res.body.importedCardCount, 1);
  assert.equal(res.body.importedQty, 4);
  assert.equal(res.body.importedItems[0].illustration, '2');
});
test('같은 보유 항목 중복 행 및 내부 Storage 재시도도 추가량을 중복 집계하지 않는다', async () => {
  const f = fixture({ retry: true }), res = await f.call('migrateFromData', { data: [input(4), input(3)] });
  assert.equal(f.saved.amount, 17);
  assert.equal(res.body.importedItems.length, 1);
  assert.equal(res.body.importedItems[0].qty, 7);
  assert.equal(res.body.importedQty, 7);
});
test('수량 없는 요청만 1장, 0장 제외, 잘못된 수량은 조회·저장 전에 전체 거부한다', async () => {
  const f = fixture();
  const legacy = input(1); delete legacy.qty;
  const res = await f.call('migrateFromData', { data: [legacy, input(0)] });
  assert.equal(res.body.importedQty, 1);
  assert.equal(res.body.legacyQuantity, true);
  assert.equal(res.body.skippedZeroCount, 1);
  for (const qty of ['', -1, 1.5, '2장']) {
    const bad = fixture(), rejected = await bad.call('migrateFromData', { data: [input(2), input(qty)] });
    assert.equal(rejected.statusCode, 400);
    assert.equal(bad.writes, 0); assert.equal(bad.resolves, 0);
  }
});
test('MyCard 헤더를 읽고 열 순서 변경·수량 없는 파일·0장 제외 안내를 보존한다', async () => {
  const f = fixture();
  const parsed = f.service.parseMyCardRows([headers, ['카드', 'A', 'SE', 3, '장소', '1'], ['카드', 'A', 'SE', 0, '장소', '1']]);
  assert.equal(parsed.totalQty, 3); assert.equal(parsed.skippedZeroCount, 1);
  const reversed = f.service.parseMyCardRows([headers.slice().reverse(), ['2', '장소', 4, 'SE', 'A', '카드']]);
  assert.equal(reversed.data[0].qty, 4);
  const legacy = f.service.parseMyCardRows([headers.filter((_, i) => i !== 3), ['카드', 'A', 'SE', '장소', '1']]);
  assert.equal(legacy.totalQty, 1); assert.equal(legacy.legacyQuantity, true);
  assert.throws(() => f.service.parseMyCardRows([headers, ['카드', 'A', 'SE', '', '장소', '1']]));
});
test('시트 사전 검증 이후 내용 변경은 저장을 차단하고 재확인을 요구한다', async () => {
  const f = fixture(), spreadsheetId = 'a'.repeat(30);
  const mismatch = await f.call('migrateFromSheet', { spreadsheetId, fingerprint: 'old' });
  assert.equal(mismatch.statusCode, 409); assert.equal(f.writes, 0);
  const preview = await f.service.fetchMyCardData_Node(spreadsheetId);
  const result = await f.call('migrateFromSheet', { spreadsheetId, fingerprint: preview.fingerprint });
  assert.equal(result.body.importedQty, 4); assert.equal(f.writes, 1);
});
test('GET 요청과 잘못된 시트 ID는 저장을 수행하지 않는다', async () => {
  const f = fixture();
  assert.equal((await f.call('migrateFromData', {}, 'GET')).statusCode, 405);
  assert.equal((await f.call('migrateFromSheet', { spreadsheetId: 'bad' })).statusCode, 400);
  assert.equal(f.writes, 0);
});

test('시트 사전 조회는 수량·0장 제외·구형 수량 안내와 내용 식별자를 반환한다', async () => {
  const service = fixture({values:[headers, ['가상 카드','TEST-KR001','SE',4,'서랍','2'],['가상 카드','TEST-KR001','SE',0,'서랍','2']]}).service;
  const routes = load('routes/integration.js', {
    'firebase-functions/v2/https': {onRequest:(_o, handler)=>handler},
    '../services/adminActionTransport': { forwardAdminRequest: async () => false },
    '../config/firebase': {}, '../utils/auth': {setCors(){}, verifyAppCheck:async()=>true},
    '../utils/safeError': {safeErrorSummary:()=>({type:'internal_error'})},
    '../integrations/googleSheets': {getSpreadsheetMetadata:async()=>({properties:{title:'가상 시트'}})},
    '../services/migrationService':service, '../integrations/discord':{}
  });
  const res = {status(){return this;},json(body){this.body=body;}};
  await routes.checkSheet({method:'GET',query:{targetId:'a'.repeat(30)}},res);
  assert.equal(res.body.status,'OK'); assert.equal(res.body.totalQty,4);
  assert.equal(res.body.skippedZeroCount,1); assert.equal(res.body.rowCount,1);
  assert.match(res.body.fingerprint,/^[0-9a-f]{64}$/);
});
