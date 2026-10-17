const { readSourceFile } = require('./sourceFile');
// 합성 DB·파일·인증만 사용한다. 운영 접속과 공유 에뮬레이터 데이터는 사용하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createInventoryCardLookup } = require('../services/inventoryCardLookup');
const { buildSearchResponse } = require('../services/cardPresentation');
const { serializePublicCard, validatePublicCards } = require('../services/publicCardContract');
const { createPublicCardReadHandler } = require('../services/publicCardReadApi');
const { createUserIdentityHandler } = require('../services/userIdentityApi');
const { createCardResourcesReader } = require('../services/cardResources');
const copy = value => JSON.parse(JSON.stringify(value));
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(readSourceFile(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, console, Buffer, Date,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw new Error(`미허용 의존성: ${name}`);
      return mocks[name];
    },
  });
  return module.exports;
}
const reply = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
  status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, send() { return this; } });
const info = { 0: ['시험 카드', [1, 3], { 'DP15-JP001': ['시험 팩', 'N'] }], 1: ['試験', [2], { 'DP15-JP001': ['試験パック', 'R'] }] };

test('사용자 카드 읽기 인터페이스는 저장·수집 기능을 노출하지 않고 조회 오류를 미발견으로 바꾸지 않는다', async () => {
  const calls = [];
  const read = { findCard: async input => { calls.push(input); throw new Error('합성 조회 장애'); },
    getCardByCid: async () => null, resolveInventoryCid: async () => null,
    normalizeNumber: value => value, mapLimited: async () => [], saveCardToFirestore() { throw new Error('쓰기 금지'); } };
  const lookup = createInventoryCardLookup(read, buildSearchResponse);
  assert.equal(Object.isFrozen(lookup), true);
  assert.equal(lookup.saveCardToFirestore, undefined);
  await assert.rejects(lookup.findCard({ number: 'TEST-001' }), /조회 장애/);
  assert.equal(await lookup.getCardByCid('42'), null);
  assert.deepEqual(calls, [{ number: 'TEST-001' }]);
});

test('번호 보정은 번호에 대응하는 언어 이름·기존 캐시·미발견 규칙을 보존한다', async () => {
  let reads = 0;
  const lookup = createInventoryCardLookup({ findCard: async () => { reads++; return { cid: '42', info }; } }, buildSearchResponse);
  assert.equal(await lookup.resolveCardNumber('DP15-JP001', '시험 카드'), 'DP15-JP001');
  assert.equal(await lookup.resolveCardNumber('DP15-JP001', '다른 이름'), 'DP15-KR001');
  assert.equal(await lookup.resolveCardNumber('20AP-JP001', '시험 카드', { '20AP-JP001': { exists: false } }), '20AP-KR001');
  assert.equal(await lookup.resolveCardNumber('TEST-001', '시험 카드'), 'TEST-001');
  assert.equal(reads, 2);
  const response = buildSearchResponse('42', info, true, { cardNo: 'DP15-JP001' });
  assert.deepEqual(response.illustrations, [1, 2, 3]);
  assert.equal(response.name, '시험 카드');
  assert.deepEqual(response.linkData.locales, ['ko', 'ja']);
});

test('공개 카드 직렬화는 내부 이력을 제외하며 손상된 원격 응답을 거부한다', () => {
  const card = serializePublicCard({ id: '42', data: () => ({ names: ['시험'], numbers: ['TEST'], info: {}, audit: '내부 이력' }) });
  assert.deepEqual(Object.keys(card.data), ['names', 'numbers', 'info']);
  assert.deepEqual(validatePublicCards({ success: true, cards: [card] }), [card]);
  for (const value of [null, { success: false, cards: [] }, { success: true, cards: Array(101).fill(card) },
    { success: true, cards: [{ ...card, cid: '../users' }] }, { success: true, cards: [{ cid: '42', data: {} }] }]) {
    assert.throws(() => validatePublicCards(value), /올바르지/);
  }
});

test('공개 카드 조회는 사용자 인증 없이 작동하며 DB 장애는 503으로 닫힌다', async () => {
  const guard = { isLocal: () => false, verifyAppCheck: async () => true, setCors() {} };
  const handler = createPublicCardReadHandler({ ...guard, db: { collection: name => {
    assert.equal(name, 'cards'); return { doc: id => ({ id }) };
  }, getAll: async () => { throw new Error('내부 오류'); } } });
  const res = reply();
  await handler({ method: 'POST', ip: 'synthetic', body: { cids: ['42'] } }, res);
  assert.equal(res.code, 503);
  assert.deepEqual(res.body, { success: false });
  assert.equal(res.headers['X-YGO-Public-Read'], '1');
});

test('신원 확인은 카드 DB 없이 현재 검증된 UID·역할을 반환하고 역할 장애를 구분한다', async () => {
  const handler = createUserIdentityHandler({ isLocal: () => false, verifyAppCheck: async () => true, setCors() {},
    verifyUser: async () => 'verified-synthetic', getVerifiedAccountRole: async () => { throw new Error('내부 오류'); } });
  let res = reply();
  await handler({ method: 'POST', ip: 'synthetic', body: { uid: 'forged' } }, res);
  assert.deepEqual(res.body, { success: true, uid: 'verified-synthetic' });
  res = reply();
  await handler({ method: 'POST', ip: 'synthetic', body: { includeAccountRole: true } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.code, 'ACCOUNT_ROLE_UNAVAILABLE');
});

test('DB 저장 계약은 카드와 대기 기록을 원자적으로 저장한 다음에만 조회 캐시를 무효화한다', async () => {
  const events = [], writes = []; let fail = false;
  const db = { collection: name => ({ doc: cid => ({ path: `${name}/${cid}` }) }), batch: () => ({
    set: (ref, body, options) => writes.push([ref.path, copy(body), options]),
    commit: async () => { events.push('commit'); if (fail) throw new Error('합성 배치 실패'); },
  }) };
  const { createCardWriteService } = load('services/cardWriteService.js', {
    'node:crypto': require('node:crypto'), '../config/firebase': {}, '../utils/cardSchema': require('../utils/cardSchema'),
  });
  const writer = createCardWriteService({ db, FieldValue: { serverTimestamp: () => 'server-time' },
    createVersion: () => 'synthetic-version', invalidateCardQueries: cid => events.push(`invalidate:${cid}`) });
  assert.equal(await writer.saveCardAndQueueIndex('42', { names: ['시험'], info }), 'synthetic-version');
  assert.deepEqual(events, ['commit', 'invalidate:42']);
  assert.deepEqual(writes.map(row => row[0]), ['cards/42', 'pendingCardIndexUpdates/42']);
  assert.equal(writes[0][1].schemaVersion, 2);
  assert.equal(writes[1][1].version, 'synthetic-version');
  events.length = 0; fail = true;
  await assert.rejects(writer.saveCardAndQueueIndex('42', {}), /배치 실패/);
  assert.deepEqual(events, ['commit']);
});

test('파일 게시 계약은 큰 generation을 보존하고 실패한 게시를 성공 캐시에 반영하지 않는다', async () => {
  const { createCardManifestFileStore } = load('utils/indexStorage.js', { '../config/firebase': {} });
  const generation = '9007199254740993'; let fail = false, downloads = 0;
  const store = createCardManifestFileStore({ now: () => 1000, getBucket: () => ({ file: name => {
    assert.equal(name, 'public/cardNames.json');
    return { getMetadata: async () => [{ generation }], save: async (_body, options) => {
      assert.equal(options.preconditionOpts.ifGenerationMatch, generation);
      if (fail) throw Object.assign(new Error('충돌'), { code: 412 });
    }, download: async () => { downloads++; return [Buffer.from('{"names":["이전"],"numbers":[]}')]; } };
  } }) });
  assert.equal(await store.readManifestGeneration(), generation);
  await store.writeCardManifest(['시험'], ['TEST'], generation);
  fail = true;
  await assert.rejects(store.writeCardManifest(['실패'], [], generation), { code: 412 });
  assert.deepEqual(copy(await store.getCardManifest()).names, ['시험']);
  assert.equal(downloads, 0);
});

test('초기 자원은 카드 경로 metadata만 읽고 로컬 URL·부재 형식을 보존한다', async () => {
  const paths = [];
  const read = createCardResourcesReader({ isEmulator: () => true, getStorageEmulatorBaseUrl: () => 'http://storage:5004',
    getBucket: () => ({ name: 'demo-card', file: name => { paths.push(name); return { getMetadata: async () => {
      if (name === 'public/packs.json') throw Object.assign(new Error('없음'), { code: 404 });
      return [{ generation: '9007199254740993', updated: '2026-10-11T00:00:00Z' }];
    } }; } }) });
  const resources = await read();
  assert.deepEqual(paths, ['public/cardNames.json', 'public/packs.json', 'public/rarityMapping.json']);
  assert.equal(resources.cardManifest.generation, '9007199254740993');
  assert.match(resources.cardManifest.url, /^http:\/\/storage:5004\/download\/storage\/v1\/b\/demo-card/);
  assert.deepEqual(resources.packs, { available: false, url: null, updatedAt: 0, generation: null, format: 'packs-v1' });
});

test('관리자 전달은 카드 작업과 회원·공지 작업을 분리하고 임의 작업을 거부한다', async () => {
  const { createAdminOperationResolver, ADMIN_OPERATIONS } = require('../services/adminOperationRegistry');
  const seen = [];
  const resolve = createAdminOperationResolver({
    resolveCardOperation: name => async () => { seen.push(['card', name]); },
    resolveServiceOperation: name => async () => { seen.push(['service', name]); },
  });
  await resolve('rebuildCardNames')();
  await resolve('manageNotice')();
  assert.deepEqual(seen, [['card', 'rebuildCardNames'], ['service', 'manageNotice']]);
  assert.equal(ADMIN_OPERATIONS.length, 8);
  for (const value of ['__proto__', 'getUserData', 'https://invalid.example']) assert.throws(() => resolve(value), /허용되지/);
});

test('모듈 분해 후 기존 58개 함수 등록·별칭·실행 옵션을 유지한다', () => {
  const functions = require('../index');
  assert.deepEqual(Object.keys(functions).sort(), require('./functionExports.fixture.json'));
  assert.equal(functions.searchPackNew, functions.searchPack);
  assert.equal(functions.crawlPackBatchNew, functions.crawlPackCardsBatch);
  assert.equal(functions.getCardFullMetaByCid, functions.getCardMetadata);
  assert.equal(require('../routes/card').addCards, functions.addCards);
  assert.equal(require('../routes/user').getInitialData, functions.getInitialData);
  assert.equal(require('../routes/publicRead').verifyUserIdentity, functions.verifyUserIdentity);
  for (const name of ['addCards', 'moveCards', 'discardCards', 'getInitialData']) {
    assert.equal(functions[name].__endpoint.availableMemoryMb, 256);
  }
  for (const name of ['getPublicCardData', 'verifyUserIdentity']) {
    const endpoint = functions[name].__endpoint;
    assert.equal(endpoint.timeoutSeconds, 30);
    assert.equal(endpoint.maxInstances, 5);
    assert.equal(endpoint.concurrency, 20);
    assert.deepEqual(endpoint.httpsTrigger.invoker, ['public']);
  }
});
