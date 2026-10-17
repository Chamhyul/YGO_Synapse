'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const express = require('express');
const { getApps } = require('firebase-admin/app');
const { createUserStorageConnection } = require('../config/userStorage');
const runtime = require('../services/userStorageRuntime');
const { getCardApiAccess, validateCardApiReadEnvironment, withCardApiRequest } = require('../services/cardApiAccessRepository');
const { createApiAccessStore } = require('../services/user-storage/apiAccessStore');
const { createCardInfoHandler } = require('../services/cardInfoApi');
const { newKey } = require('../services/cardApiAccess');
const { encodeKey, encodeValue, decodeValue } = require('../services/user-storage/codec');
const { readSourceFile } = require('./sourceFile');

// 실제 HTTP 파싱·RTDB SDK·에뮬레이터를 사용한다. 카드 읽기는 합성 함수로 한정하고
// 운영 카드 DB·크롤러·Auth·ADC에는 연결하지 않는다.
const connections = [], servers = [];
const open = () => { const connection = createUserStorageConnection(); connections.push(connection); return connection; };
const inspector = open();
const keyPath = id => `apiAccess/keys/${encodeKey(id)}`;
const raw = async id => (await inspector.database.ref(keyPath(id)).get()).val();
const value = async id => decodeValue((await raw(id)).payload);
let sequence = 0;
after(async () => {
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  })));
  await runtime.closeRtdbUserStorage();
  await Promise.all(connections.map(connection => connection.close()));
});

async function harness(options = {}, { configured = false, database } = {}) {
  const id = ++sequence, origin = `https://synthetic-card-http-${id}.invalid`;
  let now = Date.UTC(2030, 0, 1, 0, 0, 30), mode = 'ok';
  const access = configured ? getCardApiAccess() : createApiAccessStore({
    database: database || open().database, clock: () => now, maxAttempts: 10,
  });
  const key = newKey();
  await access.register(key, { label: '합성 카드 API HTTP 검사', origins: [origin], ...options });
  const calls = [];
  const card = { id: '42', data: () => ({ names: ['합성 카드'], internal: 'synthetic-private-field', info: {
    ko: { name: '합성 카드', ciid: [1, 3], packs: { 'TEST-KR001': ['합성 팩', 'N'] }, text: '합성 효과', text_pen: '', internal: 'synthetic-private-field' },
    en: { name: 'Synthetic Card', ciid: null, packs: {}, text: '', text_pen: '' },
    card_type: 'Monster', atk: 0, def: '?', lv: 4, internal: 'synthetic-private-field',
  } }) };
  const handler = createCardInfoHandler({ access,
    db: { collection() { assert.fail('카드 Firestore·수집·운영 데이터 접근 금지'); } },
    read: async input => {
      calls.push(input);
      if (mode === 'failed') throw new Error('synthetic-private-card-error');
      if (input.value === '99') return null;
      if (input.value === '중복') throw Object.assign(new Error('AMBIGUOUS_CARD'), { status: 409, code: 'AMBIGUOUS_CARD' });
      return card;
    },
  });
  const app = express(); app.get('/getCardInfo', handler); app.all('/getCardInfo', handler);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/getCardInfo`;
  async function call(query = '?cid=42', options = {}) {
    const headers = { 'X-API-Key': key.token, ...options.headers };
    if (options.noKey) delete headers['X-API-Key'];
    const response = await fetch(base + query, { method: options.method || 'GET', headers, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  const preflight = (headers = {}) => call('', { method: 'OPTIONS', noKey: true, headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-API-Key', ...headers,
  } });
  return { key, access, origin, calls, call, preflight, now: () => now,
    advance(ms) { now += ms; }, failCardRead() { mode = 'failed'; } };
}

test('HTTP 카드 API는 설정 선택기로 공유 RTDB에 연결하고 원문 키 없이 기존 응답을 제공한다', async () => {
  const app = await harness({ minuteLimit: 'unlimited', dayLimit: 'unlimited' }, { configured: true });
  const response = await app.call('?cid=42', { headers: { Origin: app.origin } });
  assert.equal(response.status, 200);
  assert.equal(response.body.cid, '42'); assert.equal(response.body.success, true);
  assert.deepEqual(Object.keys(response.body.locales), ['ko', 'en']);
  assert.equal(response.body.stats.atk, 0); assert.equal(response.body.stats.def, '?');
  assert.doesNotMatch(response.text, /synthetic-private-field|apiAccess|secretHash|usage/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), app.origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal((await value(app.key.id)).usage.dayCount, 1);
  const stored = JSON.stringify(await raw(app.key.id));
  assert.equal(stored.includes(app.key.token), false);
  assert.equal(stored.includes(app.key.token.split('.')[1]), false);
  assert.ok(getApps().every(application => application.name.startsWith('user-storage-test-')));
});

test('공유 RTDB 설정 선택기의 기본 재시도 구성은 여유 한도 안의 HTTP 병렬 요청을 모두 처리한다', async () => {
  const app = await harness({ minuteLimit: 60, dayLimit: 5000 }, { configured: true });
  const results = await Promise.all(Array.from({ length: 8 }, () => app.call()));
  assert.deepEqual(results.map(result => result.status), Array(8).fill(200));
  assert.equal((await value(app.key.id)).usage.dayCount, 8);
  assert.equal(app.calls.length, 8);
});

test('공유 RTDB 설정 선택기의 기본 구성은 초과 병렬 요청을 저장 충돌 대신 정확한 한도 오류로 반환한다', async () => {
  // 두 기간에 같은 한도를 주어 실행 도중 분 경계가 지나도 허용 수가 변하지 않게 한다.
  const app = await harness({ minuteLimit: 2, dayLimit: 2 }, { configured: true });
  const results = await Promise.all(Array.from({ length: 6 }, () => app.call()));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.ok(results.filter(result => result.status === 429)
    .every(result => result.body.code === 'RATE_LIMIT_EXCEEDED'));
  assert.equal((await value(app.key.id)).usage.dayCount, 2);
  assert.equal(app.calls.length, 2);
});

test('HTTP 카드 API의 CID·이름·번호 정규화와 언어·미발견·모호성 계약을 유지한다', async () => {
  const app = await harness();
  for (const [query, field, input] of [
    ['?cid=42', 'cid', '42'], ['?name=%20%20%ED%95%A9%EC%84%B1%20%20%EC%B9%B4%EB%93%9C%20', 'name', '합성 카드'],
    ['?number=%20test-kr001%20', 'number', 'TEST-KR001'],
  ]) {
    const response = await app.call(query); assert.equal(response.status, 200);
    assert.equal(app.calls.at(-1).field, field); assert.equal(app.calls.at(-1).value, input);
  }
  const filtered = await app.call('?cid=42&locale=ko&langOnly=true');
  assert.equal(filtered.status, 200); assert.deepEqual(Object.keys(filtered.body.locales), ['ko']);
  assert.equal(filtered.body.stats, undefined);
  assert.deepEqual((await app.call('?cid=42&locale=ja')).body, { success: false, code: 'CARD_LOCALE_NOT_FOUND' });
  assert.deepEqual((await app.call('?cid=99')).body, { success: false, code: 'CARD_NOT_FOUND' });
  assert.equal((await app.call('?name=' + encodeURIComponent('중복'))).status, 409);
  assert.equal((await value(app.key.id)).usage.dayCount, 7);
});

test('HTTP 카드 API의 중복·알 수 없는 쿼리와 키 오류·메서드는 쿼터와 카드 조회를 소비하지 않는다', async () => {
  const app = await harness();
  for (const query of ['', '?cid=42&cid=43', '?cid=42&name=test', '?cid=042', '?cid=42&apiKey=synthetic', '?cid=42&locale=xx', '?cid=42&langOnly=1']) {
    assert.equal((await app.call(query)).status, 400);
  }
  assert.equal((await app.call('?cid=42', { noKey: true })).status, 401);
  assert.equal((await app.call('?cid=42', { headers: { 'X-API-Key': newKey(app.key.id).token } })).status, 401);
  const method = await app.call('', { method: 'POST' });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET, OPTIONS');
  assert.equal((await value(app.key.id)).usage, null); assert.equal(app.calls.length, 0);
});

test('HTTP CORS는 사전 요청과 실제 키별 Origin을 검사하고 Origin 없는 서버 호출을 유지한다', async () => {
  const app = await harness();
  const allowed = await app.preflight(); assert.equal(allowed.status, 204);
  assert.equal(allowed.text, ''); assert.equal(allowed.headers.get('access-control-max-age'), '300');
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(allowed.headers.get('access-control-allow-headers'), 'X-API-Key');
  assert.match(allowed.headers.get('access-control-expose-headers'), /Retry-After/);
  for (const headers of [{ Origin: 'https://unknown.invalid' }, { Origin: 'null' },
    { 'Access-Control-Request-Method': 'POST' }, { 'Access-Control-Request-Headers': 'Authorization' }]) {
    assert.equal((await app.preflight(headers)).status, 403);
  }
  assert.equal((await value(app.key.id)).usage, null);
  const other = await harness({ origins: [] });
  assert.equal((await other.call('?cid=42', { headers: { Origin: app.origin } })).status, 403);
  assert.equal((await other.call()).status, 200);
  assert.equal((await app.call('?cid=42', { headers: { Origin: 'https://unknown.invalid' } })).status, 403);
  assert.equal((await app.call('?cid=42', { headers: { Origin: app.origin } })).status, 200);
});

test('HTTP RTDB 쿼터는 병렬 요청에서 정확한 한도와 Retry-After·UTC 경계를 유지한다', async () => {
  const app = await harness({ minuteLimit: 2, dayLimit: 3 });
  const results = await Promise.all(Array.from({ length: 6 }, () => app.call()));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.equal(results.find(result => result.status === 429).headers.get('retry-after'), '30');
  assert.equal((await value(app.key.id)).usage.dayCount, 2);
  assert.equal(app.calls.length, 2);
  app.advance(30000);
  assert.equal((await app.call('?cid=99')).status, 404);
  const blocked = await app.call(); assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '86340');
  app.advance(86400000);
  const reset = await app.call(); assert.equal(reset.status, 200);
  assert.equal(reset.headers.get('x-ratelimit-remaining-minute'), '1');
  assert.equal(reset.headers.get('x-ratelimit-remaining-day'), '2');
  assert.equal((await value(app.key.id)).usage.dayCount, 1);
});

test('HTTP unlimited는 지정한 기간만 면제하고 집계·헤더·나머지 한도는 유지한다', async () => {
  for (const limits of [{ minuteLimit: 'unlimited', dayLimit: 'unlimited' },
    { minuteLimit: 'unlimited', dayLimit: 2 }, { minuteLimit: 2, dayLimit: 'unlimited' }]) {
    const app = await harness(limits);
    assert.equal((await app.call()).status, 200);
    const second = await app.call(); assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-ratelimit-limit-minute'), String(limits.minuteLimit));
    assert.equal(second.headers.get('x-ratelimit-limit-day'), String(limits.dayLimit));
    assert.equal(second.headers.get('x-ratelimit-remaining-minute'), limits.minuteLimit === 'unlimited' ? 'unlimited' : '0');
    assert.equal(second.headers.get('x-ratelimit-remaining-day'), limits.dayLimit === 'unlimited' ? 'unlimited' : '0');
    const unlimited = limits.minuteLimit === 'unlimited' && limits.dayLimit === 'unlimited';
    assert.equal((await app.call()).status, unlimited ? 200 : 429);
    assert.equal((await value(app.key.id)).usage.dayCount, unlimited ? 3 : 2);
  }
});

test('HTTP 키 교체는 이전 키를 거부하고 집계를 유지하며 비활성화는 사전·실제 요청을 차단한다', async () => {
  const app = await harness({ minuteLimit: 2, dayLimit: 3 });
  assert.equal((await app.call()).status, 200);
  const replacement = newKey(app.key.id); await app.access.rotate(replacement);
  assert.equal((await app.call()).status, 401);
  const response = await app.call('?cid=42', { headers: { 'X-API-Key': replacement.token } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-ratelimit-remaining-minute'), '0');
  assert.equal((await app.call('?cid=42', { headers: { 'X-API-Key': replacement.token } })).status, 429);
  assert.equal((await value(app.key.id)).usage.dayCount, 2);
  await app.access.disable(app.key.id);
  assert.equal((await app.preflight()).status, 403);
  assert.deepEqual((await app.call('?cid=42', { headers: { 'X-API-Key': replacement.token } })).body,
    { success: false, code: 'API_KEY_DISABLED' });
  assert.equal((await value(app.key.id)).usage.dayCount, 2);
});

test('HTTP 만료 키는 기존 사전 요청 계약을 유지하되 실제 요청·쿼터 소비를 거부한다', async () => {
  const app = await harness({ expiresAt: Date.UTC(2030, 0, 1, 0, 0, 31) });
  assert.equal((await app.call()).status, 200); app.advance(1000);
  assert.equal((await app.preflight()).status, 204);
  assert.equal((await app.call()).status, 403);
  assert.equal((await value(app.key.id)).usage.dayCount, 1);
});

test('HTTP RTDB 설정·집계 손상과 카드 읽기 장애는 원본을 보존하고 비공개 오류 없이 503을 반환한다', async () => {
  for (const corrupt of [item => { item.policy.minuteLimit = 0; },
    item => { item.usage = { minute: Math.floor(Date.UTC(2030, 0, 1, 0, 0, 30) / 60000), day: 0, minuteCount: 'invalid', dayCount: 0 }; }]) {
    const app = await harness(), record = await raw(app.key.id), payload = decodeValue(record.payload);
    corrupt(payload); record.payload = encodeValue(payload);
    await inspector.database.ref(keyPath(app.key.id)).set(record);
    const response = await app.call(); assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false, code: 'API_UNAVAILABLE' });
    assert.deepEqual(await raw(app.key.id), record); assert.equal(app.calls.length, 0);
  }
  const app = await harness(); app.failCardRead();
  const failed = await app.call(); assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { success: false, code: 'API_UNAVAILABLE' });
  assert.equal((await value(app.key.id)).usage.dayCount, 1);
});

test('HTTP RTDB SDK 조회 실패는 카드 조회 없이 503으로 처리하고 내부 오류를 노출하지 않는다', async () => {
  let fail = false;
  const connection = open();
  const database = new Proxy(connection.database, { get(target, name) {
    if (name === 'ref') return path => {
      const ref = target.ref(path);
      return new Proxy(ref, { get(reference, method) {
        const result = Reflect.get(reference, method, reference);
        if (method === 'get' && fail) return async () => { throw new Error('synthetic-private-rtdb-error'); };
        return typeof result === 'function' ? result.bind(reference) : result;
      } });
    };
    const result = Reflect.get(target, name, target); return typeof result === 'function' ? result.bind(target) : result;
  } });
  const app = await harness({}, { database }); fail = true;
  for (const response of [await app.call(), await app.preflight()]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false, code: 'API_UNAVAILABLE' });
  }
  assert.equal(app.calls.length, 0); assert.equal((await value(app.key.id)).usage, null);
});

test('내보낸 카드 HTTP 경로는 RTDB 전용 환경에서 거부하고 카드 경계가 명시된 시험 환경에서 저장소 선택기를 사용한다', async () => {
  const filename = path.join(__dirname, '../routes/cardInfo.js');
  const loaded = new Module(filename, module), seen = [];
  const db = { collection(name) {
    assert.equal(name, 'cards');
    return { doc(id) { seen.push(id); return { async get() {
      return { id, exists: true, data: () => ({ info: { ko: { name: '합성 경로 카드', ciid: null } } }) };
    } }; } };
  } };
  const allowed = {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../config/firebase': { db },
    '../services/cardApiAccessRepository': { getCardApiAccess, validateCardApiReadEnvironment, withCardApiRequest },
    '../services/cardInfoApi': { createCardInfoHandler },
    '../services/illustrationDelivery': { createLimiter: () => () => true },
  };
  loaded.filename = filename;
  loaded.require = name => { assert.ok(Object.hasOwn(allowed, name), `시험 외부 의존성 접근 금지: ${name}`); return allowed[name]; };
  loaded._compile(readSourceFile(filename, 'utf8'), filename);
  const key = newKey(), access = getCardApiAccess();
  await access.register(key, { label: '합성 내보낸 경로', minuteLimit: 'unlimited', dayLimit: 'unlimited' });
  const app = express(); app.all('/getCardInfo', loaded.exports.getCardInfo);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `http://127.0.0.1:${server.address().port}/getCardInfo?cid=42`;
  const environment = Object.fromEntries(['FIRESTORE_EMULATOR_HOST', 'CARD_SERVICE_URL'].map(name => [name, process.env[name]]));
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.CARD_SERVICE_URL;
    const blocked = await fetch(url, { headers: { 'X-API-Key': key.token } });
    assert.equal(blocked.status, 503); await blocked.arrayBuffer();
    assert.deepEqual(seen, []); assert.equal((await value(key.id)).usage, null);
    // Firestore의 SDK는 주입하지 않는다. 이 주소는 진입 경계 검사용이며 접속되지 않는다.
    process.env.FIRESTORE_EMULATOR_HOST = 'emulators:8080';
    const response = await fetch(url, { headers: { 'X-API-Key': key.token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).locales.ko.name, '합성 경로 카드');
    assert.deepEqual(seen, ['42']); assert.equal((await value(key.id)).usage.dayCount, 1);
  } finally {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
