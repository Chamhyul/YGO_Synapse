'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadApp } = require('../runtime/app');
const { createAuthenticator } = require('../runtime/auth');
const { createBackend } = require('../runtime/backend');
const { createFixtureBackend } = require('./fixture-backend');
const env = { NODE_ENV: 'test', CARD_READ_BACKEND: 'fixture', CARD_SERVICE_AUTH: 'fixture' };
async function server(t, backend = createFixtureBackend()) {
  const app = createReadApp({ ...backend, authenticate: createAuthenticator(env) });
  const http = app.listen(0, '127.0.0.1');
  await new Promise(resolve => http.once('listening', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return (route, body, auth = true, method = 'POST') => fetch(`http://127.0.0.1:${http.address().port}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer synthetic-card-service-token' } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  });
}
test('실제 HTTP 카드 조회는 중복 CID를 제거하고 미발견을 빈 목록으로 반환한다', async t => {
  const request = await server(t);
  const response = await request('/v1/cards/read', { cids: ['42', '42', '99'] });
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-YGO-Card-Read'), '1');
  const { cards } = await response.json();
  assert.deepEqual(cards.map(c => c.cid), ['42']);
  assert.equal(cards[0].data.internalAudit, undefined);
  assert.deepEqual(cards[0].data.raritiesByNo, { 'TEST-001': ['N'] });
  assert.deepEqual((await (await request('/v1/cards/read', { cids: ['99'] })).json()).cards, []);
  assert.equal((await (await request('/v1/cards/read', { field: 'names', value: '같은 이름', limit: 2 })).json()).cards.length, 2);
});
test('인증 없는 조회·임의 컬렉션·잘못된 요청·쓰기 경로를 거부한다', async t => {
  const request = await server(t);
  assert.equal((await request('/v1/cards/read', { cids: ['42'] }, false)).status, 401);
  for (const body of [{ cids: ['../users'] }, { field: 'users', value: '42' }, { cids: [] },
    { cids: Array(101).fill('42') }, { cids: ['42'], collection: 'users' }, { field: 'names', value: 'x', limit: 0 }]) {
    assert.equal((await request('/v1/cards/read', body)).status, 400);
  }
  assert.equal((await request('/v1/cards/write', {})).status, 404);
  assert.equal((await request('/v1/cards/read', {}, true, 'GET')).status, 404);
});
test('DB 장애는 성공·미발견으로 변환하지 않는다', async t => {
  const backend = createFixtureBackend(); backend.db.getAll = async () => { throw Error('synthetic'); };
  const response = await (await server(t, backend))('/v1/cards/read', { cids: ['42'] });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { success: false });
});
test('자원 metadata 계약은 세 카드 파일과 문자열 generation을 보존한다', async t => {
  const response = await (await server(t))('/v1/resources/read', {});
  const { resources } = await response.json();
  assert.deepEqual(Object.keys(resources), ['cardManifest', 'packs', 'rarity']);
  assert.equal(resources.cardManifest.generation, '9007199254740993');
});
test('실행 설정을 생략하면 기존 프로젝트로 연결하지 않으며 합성 인증의 운영 사용을 거부한다', () => {
  assert.throws(() => createBackend({}), /명시/);
  assert.throws(() => createBackend({ CARD_READ_BACKEND: 'fixture' }), /검사/);
  assert.throws(() => createAuthenticator({}), /설정/);
  assert.throws(() => createAuthenticator({ ...env, NODE_ENV: 'production' }), /합성/);
});
test('OIDC는 검증된 audience·issuer·만료·허용 호출 계정을 모두 검사한다', async () => {
  const config = { CARD_SERVICE_AUTH: 'oidc', CARD_SERVICE_AUDIENCE: 'https://card.example', CARD_SERVICE_CALLERS: 'main@example.iam.gserviceaccount.com' };
  let payload = { aud: config.CARD_SERVICE_AUDIENCE, iss: 'https://accounts.google.com', exp: Date.now()/1000+60,
    email: config.CARD_SERVICE_CALLERS, email_verified: true };
  const verify = createAuthenticator(config, async () => payload);
  const request = { headers: { authorization: 'Bearer synthetic-signed-token' } };
  assert.equal(await verify(request), true);
  const valid = { ...payload };
  for (const override of [{ aud: 'other' }, { iss: 'other' }, { exp: 0 }, { email: 'other' }, { email_verified: false }]) {
    payload = { ...valid, ...override }; assert.equal(await verify(request), false);
  }
  assert.equal(await verify({ headers: {} }), false);
});
