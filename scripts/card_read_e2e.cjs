'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.MAIN_READ_TEST_URL;
const cardBase = process.env.CARD_READ_TEST_URL;
if (!base || !cardBase) throw new Error('분리 서비스 합성 검사 주소가 필요합니다.');
const env = process.env;
if (env.NODE_ENV !== 'test' || env.GCLOUD_PROJECT !== 'demo-main-read'
  || env.FIRESTORE_EMULATOR_HOST !== 'emulators:8085'
  || env.FIREBASE_STORAGE_EMULATOR_HOST !== 'emulators:9199') throw Error('demo 에뮬레이터에서만 검증합니다.');
const sdk = require('node:module').createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
const { initializeApp, deleteApp } = sdk('firebase-admin/app');
const { getFirestore } = sdk('firebase-admin/firestore');
const { getStorage } = sdk('firebase-admin/storage');
const mainApp = initializeApp({ projectId: 'demo-main-read', storageBucket: 'demo-main-read-assets' }, 'read-test-main');
const cardApp = initializeApp({ projectId: 'demo-card-read', storageBucket: 'demo-card-read-assets' }, 'read-test-card');
const mainDb = getFirestore(mainApp), cardDb = getFirestore(cardApp);
const mainBucket = getStorage(mainApp).bucket(), cardBucket = getStorage(cardApp).bucket();
const inventory = mainBucket.file('users/synthetic-reader/inventory.json');
const { createCardApiAccess, newKey } = require('../functions/services/cardApiAccess');
const apiAccess = createCardApiAccess(mainDb);
let apiKey, limitedKey, cardGeneration;
test.before(async () => {
  await cardDb.collection('cards').doc('42').set({ names: ['시험 카드', 'Test card'], numbers: ['TEST-001', 'DP15-JP001'],
    info: { ko: { name: '시험 카드', ciid: [1], packs: { 'TEST-001': ['시험 팩', 'N'], 'DP15-JP001': ['시험 팩', 'N'] }, text: '', text_pen: '' }, card_type: 'Monster', lv: 4 },
    raritiesByNo: { 'TEST-001': ['N'] }, internalAudit: 'not-public' });
  for (const cid of ['43', '44']) await cardDb.collection('cards').doc(cid).set({ names: ['같은 이름'], numbers: ['DUP-' + cid], info: {} });
  // 잘못 기존 DB를 읽거나 미발견/장애 시 우회하면 결과가 달라지는 대조 데이터.
  await mainDb.collection('cards').doc('42').set({ names: ['wrong-main-db'], numbers: ['WRONG'], info: {} });
  await mainDb.collection('cards').doc('99').set({ names: ['fallback-forbidden'], numbers: [], info: {} });
  const batch = cardDb.batch();
  for (let n = 1000; n < 1101; n++) batch.set(cardDb.collection('cards').doc(String(n)), { names: ['limit-probe'], numbers: [], info: {} });
  await batch.commit();
  for (const name of ['cardNames', 'packs', 'rarityMapping']) await cardBucket.file('public/' + name + '.json').save('{}', { resumable: false, contentType: 'application/json' });
  cardGeneration = (await cardBucket.file('public/cardNames.json').getMetadata())[0].generation;
  await inventory.save(JSON.stringify({ version: 3, cards: {}, amount: 0, locations: {}, rarities: {} }), { resumable: false });
  apiKey = newKey(); limitedKey = newKey();
  await apiAccess.register(apiKey, { label: 'synthetic read integration', origins: ['https://example.org'], minuteLimit: 'unlimited', dayLimit: 'unlimited' });
  await apiAccess.register(limitedKey, { label: 'synthetic quota', minuteLimit: 1 });
});
test.after(async () => { await Promise.all([deleteApp(mainApp), deleteApp(cardApp)]); });
const post = (path, body, authenticate = true) => fetch(base + path, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(authenticate ? { 'X-Firebase-AppCheck': 'synthetic-app-check' } : {}) }, body: JSON.stringify(body) });
test('별도 컨테이너 간 공개 카드 API의 본문·헤더·인증·미발견 계약', async () => {
  const result = await post('/getPublicCardData', { cids: ['42'] });
  assert.equal(result.status, 200); assert.equal(result.headers.get('X-YGO-Public-Read'), '1');
  const body = await result.json();
  assert.equal(body.success, true); assert.equal(body.cards[0].cid, '42');
  assert.equal(body.cards[0].data.names[0], '시험 카드');
  assert.deepEqual(Object.keys(body.cards[0].data), ['names', 'numbers', 'info']);
  assert.equal((await post('/getPublicCardData', { cids: ['42'] }, false)).status, 401);
  assert.equal((await post('/getPublicCardData', { cids: ['../users'] })).status, 400);
  assert.deepEqual(await (await post('/getPublicCardData', { cids: ['99'] })).json(), { success: true, cards: [] });
});
test('기존 초기 데이터 API는 카드 서버의 자원과 기존 schema를 반환한다', async () => {
  const result = await post('/getInitialData', {});
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.success, true); assert.equal(body.schemaVersion, 2); assert.equal(body.syncType, 'storage-links');
  assert.equal(typeof body.serverTime, 'number');
  assert.equal(body.resources.cardManifest.generation, String(cardGeneration));
  assert.match(body.resources.cardManifest.url, /demo-card-read-assets/);
  // 실제 SDK metadata의 generation이 파일 갱신 뒤에도 새 값으로 전달된다.
  await cardBucket.file('public/cardNames.json').save('{"updated":true}', { resumable: false });
  const next = await (await post('/getInitialData', {})).json();
  assert.notEqual(next.resources.cardManifest.generation, String(cardGeneration));
});
test('기존 batch metadata는 원격 조회를 통해 필터 정보만 반환한다', async () => {
  const result = await post('/getCardsMetaBatch', { cids: ['42', '99'] });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true, results: { '42': { 10: 0, 12: 4 } } });
});
test('카드 내부 API는 게이트웨이 사용자 토큰과 쓰기 요청을 수락하지 않는다', async () => {
  const result = await fetch(cardBase + '/v1/cards/read', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'synthetic-app-check' }, body: JSON.stringify({ cids: ['42'] }) });
  assert.equal(result.status, 401);
  const write = await fetch(cardBase + '/v1/cards/write', { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-card-service-token', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(write.status, 404);
});
test('카드 서비스 연결 장애는 공개 API 503이며 빈 성공 응답으로 바뀌지 않는다', async () => {
  const result = await fetch(process.env.MAIN_READ_UNAVAILABLE_URL + '/getPublicCardData', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'synthetic-app-check' }, body: JSON.stringify({ cids: ['42'] }) });
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { success: false });
});
test('이름·번호 해석은 중복 후보·정규화·미발견·40개 입력 제한을 유지한다', async () => {
  const response = await post('/resolveCardNames', { names: ['같은 이름', '없는 이름'], numbers: [' test-001 '] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.results['같은 이름'].sort(), ['43', '44']);
  assert.deepEqual(body.results['없는 이름'], []);
  assert.equal(body.numberResults[' test-001 '][0].cid, '42');
  assert.equal(body.metadata['42'][12], 4);
  assert.equal((await post('/resolveCardNames', { names: Array(41).fill('같은 이름') })).status, 400);
  assert.equal((await post('/resolveCardNames', { names: ['같은 이름'] }, false)).status, 401);
  assert.equal((await post('/getPublicCardData', { field: 'names', value: 'limit-probe' })).status, 400);
});
test('getCardInfo는 원격 카드와 로컬 키/쿼터를 결합하고 언어·CORS·오류 계약을 유지한다', async () => {
  const call = (query, headers = { 'X-API-Key': apiKey.token }) => fetch(base + '/getCardInfo?' + query, { headers });
  const ok = await call('cid=42&locale=ko&langOnly=true', { 'X-API-Key': apiKey.token, Origin: 'https://example.org' });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://example.org');
  assert.equal(ok.headers.get('X-RateLimit-Limit-Minute'), 'unlimited');
  const body = await ok.json(); assert.equal(body.cid, '42'); assert.deepEqual(Object.keys(body.locales), ['ko']);
  assert.equal(body.locales.ko.name, '시험 카드'); assert.equal(body.stats, undefined);
  assert.ok(!JSON.stringify(body).includes('not-public'));
  assert.equal((await call('cid=42', {})).status, 401);
  assert.equal((await call('cid=42', { 'X-API-Key': apiKey.token, Origin: 'https://invalid.example' })).status, 403);
  assert.equal((await call('cid=42&cid=43')).status, 400);
  assert.equal((await call('name=' + encodeURIComponent('같은 이름'))).status, 409);
  assert.equal((await call('cid=99')).status, 404);
  assert.equal((await call('number=test-001')).status, 200);
  assert.equal((await fetch(base + '/getCardInfo', { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-API-Key' } })).status, 204);
  const headers = { 'X-API-Key': limitedKey.token };
  assert.equal((await call('cid=42', headers)).status, 200); assert.equal((await call('cid=42', headers)).status, 429);
  assert.ok((await mainDb.collection('cardApiUsage').doc(apiKey.id).get()).data().dayCount > 0);
  assert.equal((await cardDb.collection('cardApiKeys').get()).empty, true);
  const failed = await fetch(process.env.MAIN_READ_UNAVAILABLE_URL + '/getCardInfo?cid=42', { headers: { 'X-API-Key': apiKey.token } });
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { success: false, code: 'API_UNAVAILABLE' });
});
test('인벤토리 등록은 원격 CID를 연결하고 인증·조회 장애 때 기존 저장물을 보존한다', async () => {
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Firebase-AppCheck': 'synthetic-app-check', Authorization: 'Bearer synthetic-user-token' },
    body: JSON.stringify({ rows: [['시험 카드', 'TEST-001', 'N', 2, '합성 보관함', '1', '42']] }) };
  const before = (await inventory.download())[0];
  assert.equal((await fetch(base + '/addCards', { ...request, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.deepEqual((await inventory.download())[0], before);
  const added = await fetch(base + '/addCards', request); assert.equal(added.status, 200);
  const body = await added.json(); assert.equal(body.success, true); assert.equal(body.amount, 2);
  assert.deepEqual(body.operationResults, [{ requestIndex: 0, status: 'success', qty: 2 }]);
  const saved = (await inventory.download())[0];
  assert.equal(JSON.parse(saved).cards['TEST-001'].cid, '42');
  const failed = await fetch(process.env.MAIN_READ_UNAVAILABLE_URL + '/addCards', request);
  assert.equal(failed.status, 500); assert.equal((await failed.json()).success, false);
  assert.deepEqual((await inventory.download())[0], saved);
  assert.equal((await mainDb.collection('cards').doc('42').get()).data().names[0], 'wrong-main-db');
  assert.equal((await cardDb.collection('cards').doc('42').get()).data().internalAudit, 'not-public');
  assert.equal((await cardBucket.getFiles({ prefix: 'users/' }))[0].length, 0);
});
