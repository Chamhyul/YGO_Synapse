'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardApiAccess, newKey, keyOptions } = require('../services/cardApiAccess');
const { createCardInfoHandler, parseQuery, formatCard } = require('../services/cardInfoApi');
// 외부 SDK/네트워크 없이 트랜잭션을 직렬화하고 쓰기 대상을 기록한다.
function database() {
  const rows = new Map(), writes = []; let queue = Promise.resolve();
  const snap = ref => ({ id: ref.id, exists: rows.has(ref.path), data: () => rows.get(ref.path) });
  function ref(collection, id) { return { id, path: `${collection}/${id}`, get: async () => snap(ref(collection, id)) }; }
  const db = { collection: collection => ({ doc: id => ref(collection, id), where: (field, op, value) => {
    assert.equal(op, 'array-contains'); return { limit: n => ({ get: async () => ({ docs: [...rows.entries()]
      .filter(([p, data]) => p.startsWith(collection + '/') && data[field]?.includes(value)).slice(0, n).map(([p]) => snap(ref(collection, p.split('/')[1]))) }) }) };
  } }), runTransaction: fn => {
    const run = queue.then(async () => {
      const pending = []; const tx = { get: async r => snap(r), create: (r, value) => { assert.equal(rows.has(r.path), false); pending.push([r, value]); },
        set: (r, value) => pending.push([r, value]), update: (r, value) => pending.push([r, { ...rows.get(r.path), ...value }]) };
      const result = await fn(tx);
      for (const [r, value] of pending) { rows.set(r.path, value); writes.push(r.path); }
      return result;
    }); queue = run.catch(() => {}); return run;
  } };
  return { db, rows, writes };
}
function response() { return { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } }; }
async function fixture(options = {}) {
  const f = database(); let now = Date.UTC(2026, 9, 10, 0, 0, 30);
  const access = createCardApiAccess(f.db, () => now), key = newKey();
  await access.register(key, { label: '합성 테스트', origins: ['https://example.org'], ...options });
  f.rows.set('cards/42', { names: ['테스트', 'Test'], numbers: ['TEST-KR001'], secret: '내부', info: {
    ko: { name: '테스트', ciid: [1, 3], packs: { 'TEST-KR001': ['팩', 'N'] }, text: '효과', text_pen: '', internal: '숨김' },
    en: { name: 'Test', ciid: null, packs: {}, text: 'effect', text_pen: '' }, card_type: 'Monster', atk: 0, def: '?', lv: 4, internal: '숨김' } });
  const handler = createCardInfoHandler({ db: f.db, access });
  return { ...f, access, key, handler, advance: n => { now += n; }, async call(query = { cid: '42' }, extra = {}) {
    const res = response(); await handler({ method: 'GET', ip: 'test', query, headers: { 'x-api-key': key.token }, ...extra }, res); return res;
  } };
}
test('CID/이름/번호 조회와 언어 필터: 카드 쓰기·내부 필드·자동 대체 없음', async () => {
  const f = await fixture();
  for (const query of [{ cid: '42' }, { name: '  테스트  ' }, { number: ' test-kr001 ' }]) {
    const res = await f.call(query); assert.equal(res.statusCode, 200); assert.equal(res.body.cid, '42');
    assert.deepEqual(Object.keys(res.body.locales), ['ko', 'en']); assert.equal(res.body.stats.atk, 0); assert.equal(res.body.stats.def, '?');
    assert.equal(JSON.stringify(res.body).includes('숨김'), false); assert.equal(JSON.stringify(res.body).includes('내부'), false);
  }
  const ko = await f.call({ cid: '42', locale: 'ko', langOnly: 'true' });
  assert.deepEqual(Object.keys(ko.body.locales), ['ko']); assert.equal(ko.body.stats, undefined);
  assert.equal((await f.call({ name: 'Test', locale: 'ko' })).statusCode, 200);
  assert.equal((await f.call({ cid: '42', locale: 'ja' })).body.code, 'CARD_LOCALE_NOT_FOUND');
  assert.equal((await f.call({ cid: '99' })).body.code, 'CARD_NOT_FOUND');
  assert.ok(f.writes.every(p => !p.startsWith('cards/')));
});
test('잘못된 조건·중복 파라미터·부분 검색·모호한 일치', async () => {
  const f = await fixture();
  for (const query of [{}, { cid: '42', name: '테스트' }, { cid: ['42', '43'] }, { cid: '042' }, { name: ' ' }, { cid: '42', locale: 'xx' }, { cid: '42', langOnly: '1' }, { cardNo: 'A' }, { cid: '42', apiKey: 'dummy' }]) assert.equal((await f.call(query)).statusCode, 400);
  assert.equal(f.rows.has(`cardApiUsage/${f.key.id}`), false);
  assert.equal((await f.call({ name: '테스' })).statusCode, 404);
  f.rows.set('cards/43', { names: ['테스트'], numbers: ['TEST-KR001'], info: {} });
  assert.equal((await f.call({ name: '테스트' })).statusCode, 409);
  assert.equal((await f.call({ number: 'TEST-KR001' })).statusCode, 409);
});
test('키 없음·위조·만료·중지·교체, 원문 키 저장 없음', async () => {
  const f = await fixture();
  assert.equal((await f.call({ cid: '42' }, { headers: {} })).statusCode, 401);
  assert.equal((await f.call({ cid: '42' }, { headers: { 'x-api-key': newKey(f.key.id).token } })).statusCode, 401);
  const rotated = newKey(f.key.id); await f.access.rotate(rotated);
  assert.equal((await f.call()).statusCode, 401);
  assert.ok(await f.access.authenticate(rotated.token));
  assert.equal(JSON.stringify([...f.rows.values()]).includes(rotated.token), false);
  await f.access.disable(f.key.id);
  await assert.rejects(f.access.authenticate(rotated.token), { status: 403 });
  assert.equal(await f.access.allowsPreflight('https://example.org'), false);
  const other = await fixture(); const record = other.rows.get(`cardApiKeys/${other.key.id}`); record.expiresAt = 1;
  assert.equal((await other.call()).statusCode, 403);
});
test('키별 공유 한도: 동시 요청, 경계 초기화, 일 한도, 중지 재검사', async () => {
  const f = await fixture({ minuteLimit: 2, dayLimit: 3 });
  const results = await Promise.all(Array.from({ length: 10 }, () => f.call()));
  assert.equal(results.filter(r => r.statusCode === 200).length, 2);
  assert.equal(results.filter(r => r.statusCode === 429).length, 8);
  assert.equal(f.rows.get(`cardApiUsage/${f.key.id}`).dayCount, 2);
  assert.equal(results.find(r => r.statusCode === 429).headers['Retry-After'], '30');
  f.advance(30000); assert.equal((await f.call({ cid: '99' })).statusCode, 404);
  const blocked = await f.call(); assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers['Retry-After'], '86340');
  f.advance(86400000); assert.equal((await f.call()).statusCode, 200);
  await f.access.disable(f.key.id); await assert.rejects(f.access.consume(f.key.token), { status: 403 });
});
test('CORS 사전 요청·실제 키별 Origin 검사·Origin 없는 서버 호출', async () => {
  const f = await fixture();
  const preflight = headers => f.call({}, { method: 'OPTIONS', headers });
  const good = { origin: 'https://example.org', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' };
  const res = await preflight(good); assert.equal(res.statusCode, 204); assert.equal(res.headers['Access-Control-Allow-Origin'], good.origin);
  assert.equal(f.rows.has(`cardApiUsage/${f.key.id}`), false);
  for (const headers of [{ ...good, origin: 'https://evil.org' }, { ...good, origin: 'null' }, { ...good, 'access-control-request-method': 'POST' }, { ...good, 'access-control-request-headers': 'Authorization' }]) assert.equal((await preflight(headers)).statusCode, 403);
  const actual = await f.call({ cid: '42' }, { headers: { 'x-api-key': f.key.token, origin: good.origin } });
  assert.equal(actual.statusCode, 200); assert.equal(actual.headers['Access-Control-Allow-Credentials'], undefined);
  assert.equal((await f.call({ cid: '42' }, { headers: { 'x-api-key': f.key.token, origin: 'https://evil.org' } })).statusCode, 403);
  const second = newKey(); await f.access.register(second, { label: '서버', origins: [] });
  assert.equal((await f.call({ cid: '42' }, { headers: { 'x-api-key': second.token, origin: good.origin } })).statusCode, 403);
  assert.equal((await f.call()).statusCode, 200);
});
test('DB/키/집계/설정 장애는 503, 원본 오류 노출 없음', async () => {
  const f = await fixture(); f.db.runTransaction = async () => { throw new Error('sensitive token'); };
  const res = await f.call(); assert.deepEqual(res.body, { success: false, code: 'API_UNAVAILABLE' }); assert.equal(res.statusCode, 503);
  const corrupt = await fixture(); corrupt.rows.get(`cardApiKeys/${corrupt.key.id}`).minuteLimit = 0; assert.equal((await corrupt.call()).statusCode, 503);
  const count = await fixture(); count.rows.set(`cardApiUsage/${count.key.id}`, { minute: Math.floor(Date.UTC(2026, 9, 10, 0, 0, 30) / 60000), minuteCount: 'bad' }); assert.equal((await count.call()).statusCode, 503);
});
test('구형 슬롯도 명명 필드로 변환하고 미확정 CIID·0/? 보존', () => {
  const result = formatCard({ id: '42', data: () => ({ info: { 0: ['이름', 3, {}, '효과', ''], 10: 0, 11: [1], 15: 0, 16: -1 } }) }, {});
  assert.equal(result.locales.ko.ciid, null); assert.equal(result.stats.atk, 0); assert.equal(result.stats.def, '?');
  assert.throws(() => formatCard({ id: '42', data: () => ({ info: { ko: { name: { secret: 'x' } } } }) }, {}), { status: 503 });
  assert.throws(() => parseQuery({ cid: '42', locale: ['ko'] }), { status: 400 });
  assert.throws(() => keyOptions({ label: 'test', origins: ['https://example.org/'] }), { status: 400 });
});
test('메서드 제한과 보조 IP 제한은 DB 조회 전에 적용', async () => {
  const f = await fixture(); assert.equal((await f.call({}, { method: 'POST' })).statusCode, 405);
  const handler = createCardInfoHandler({ db: {}, access: {}, allow: () => false }), res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res); assert.equal(res.statusCode, 429);
});
test('여러 접근 인스턴스가 같은 한도를 공유하고 교체 후에도 집계 유지', async () => {
  const f = await fixture({ minuteLimit: 3 });
  const second = createCardApiAccess(f.db, () => Date.UTC(2026, 9, 10, 0, 0, 30));
  const results = await Promise.all([f.access, second, f.access, second].map(a => a.consume(f.key.token).then(() => true, e => { assert.equal(e.status, 429); return false; })));
  assert.equal(results.filter(Boolean).length, 3);
  const replacement = newKey(f.key.id); await f.access.rotate(replacement);
  await assert.rejects(second.consume(replacement.token), { status: 429 });
});
test('실제 HTTP 파싱에서 중복 쿼리 거부·CORS·키 헤더·JSON 상태 확인', async () => {
  const http = require('node:http'); const f = await fixture();
  const server = http.createServer((req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams, query = {};
    for (const key of new Set(params.keys())) { const values = params.getAll(key); query[key] = values.length === 1 ? values[0] : values; }
    const adapter = { set(k, v) { res.setHeader(k, v); return this; }, status(n) { res.statusCode = n; return this; }, json(value) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }, send(value) { res.end(value); } };
    f.handler({ method: req.method, headers: req.headers, ip: req.socket.remoteAddress, query }, adapter).catch(e => { res.statusCode = 500; res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/getCardInfo`;
    const valid = await fetch(url + '?cid=42&locale=ko', { headers: { 'X-API-Key': f.key.token, Origin: 'https://example.org' } });
    assert.equal(valid.status, 200); assert.equal(valid.headers.get('Access-Control-Allow-Origin'), 'https://example.org');
    assert.deepEqual(Object.keys((await valid.json()).locales), ['ko']);
    assert.equal((await fetch(url + '?cid=42&cid=43', { headers: { 'X-API-Key': f.key.token } })).status, 400);
    assert.equal((await fetch(url + '?cid=42')).status, 401);
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-API-Key' } })).status, 204);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('unlimited는 분/일별 한도만 면제하고 집계·헤더·교체·인증 조건 유지', async () => {
  const f = await fixture({ minuteLimit: 'unlimited', dayLimit: 'unlimited' });
  // 이전 기본 일 한도보다 많이 쓴 상태에서도 같은 UTC 창에서 조회 가능.
  f.rows.set(`cardApiUsage/${f.key.id}`, { minute: Math.floor(Date.UTC(2026, 9, 10, 0, 0, 30) / 60000),
    day: Math.floor(Date.UTC(2026, 9, 10) / 86400000), minuteCount: 6000, dayCount: 6000 });
  const calls = await Promise.all(Array.from({ length: 8 }, () => f.call()));
  assert.ok(calls.every(r => r.statusCode === 200));
  const res = calls[0];
  for (const header of ['X-RateLimit-Limit-Minute', 'X-RateLimit-Remaining-Minute', 'X-RateLimit-Limit-Day', 'X-RateLimit-Remaining-Day']) assert.equal(res.headers[header], 'unlimited');
  assert.equal(f.rows.get(`cardApiUsage/${f.key.id}`).dayCount, 6008);
  const replacement = newKey(f.key.id); await f.access.rotate(replacement);
  assert.equal((await f.access.authenticate(replacement.token)).dayLimit, 'unlimited');
  assert.equal((await f.call()).statusCode, 401);
  await assert.rejects(f.access.consume(replacement.token, 'https://evil.org'), { status: 403 });
  await f.access.disable(f.key.id);
  await assert.rejects(f.access.consume(replacement.token), { status: 403 });
});
test('분/일 한도 각각 면제해도 다른 유한 한도는 집행하며 UTC 경계 후 집계', async () => {
  for (const options of [{ minuteLimit: 'unlimited', dayLimit: 2 }, { minuteLimit: 2, dayLimit: 'unlimited' }]) {
    const f = await fixture(options);
    assert.equal((await f.call()).statusCode, 200); assert.equal((await f.call()).statusCode, 200);
    const rejected = await f.call(); assert.equal(rejected.statusCode, 429);
    assert.equal(rejected.headers['Retry-After'], options.dayLimit === 2 ? '86370' : '30');
    assert.equal(f.rows.get(`cardApiUsage/${f.key.id}`).dayCount, 2);
    f.advance(86400000); assert.equal((await f.call()).statusCode, 200);
    assert.equal(f.rows.get(`cardApiUsage/${f.key.id}`).dayCount, 1);
  }
});
test('무제한은 정확한 식별자만 허용하고 손상 설정·집계는 거부', async () => {
  for (const value of [null, 0, -1, true, false, 'Unlimited', 'none', '60', Infinity]) {
    assert.throws(() => keyOptions({ label: '합성', minuteLimit: value }), { status: 400 });
    assert.throws(() => keyOptions({ label: '합성', dayLimit: value }), { status: 400 });
    const f = await fixture(); f.rows.get(`cardApiKeys/${f.key.id}`).minuteLimit = value;
    assert.equal((await f.call()).statusCode, 503);
  }
  const f = await fixture({ minuteLimit: 'unlimited', dayLimit: 'unlimited' });
  f.rows.set(`cardApiUsage/${f.key.id}`, { minute: Math.floor(Date.UTC(2026, 9, 10, 0, 0, 30) / 60000), minuteCount: Number.MAX_SAFE_INTEGER });
  assert.equal((await f.call()).statusCode, 503);
  f.rows.get(`cardApiKeys/${f.key.id}`).expiresAt = 1;
  assert.equal((await f.call()).statusCode, 403);
});
