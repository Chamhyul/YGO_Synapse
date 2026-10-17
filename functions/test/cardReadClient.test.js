'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardReadClient, settings } = require('../services/cardReadClient');
const env = { CARD_SERVICE_URL: 'http://card:8080', CARD_SERVICE_AUTH: 'fixture', NODE_ENV: 'test', CARD_READ_BACKEND: 'fixture' };
const card = { cid: '42', data: { names: ['시험'], numbers: ['TEST'], info: {} } };
const response = (body, options = {}) => new Response(JSON.stringify(body), { status: 200,
  headers: { 'Content-Type': 'application/json', 'X-YGO-Card-Read': '1' }, ...options });
test('서버 간 호출은 고정 URL·서비스 인증·제한 시간만 사용하고 사용자 토큰을 전송하지 않는다', async () => {
  let sent;
  const client = createCardReadClient({ env, fetchImpl: async (url, options) => { sent = { url, options }; return response({ success: true, cards: [card] }); } });
  assert.deepEqual(await client.readCards({ cids: ['42'] }), [card]);
  assert.equal(sent.url, 'http://card:8080/v1/cards/read');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.headers.Authorization, 'Bearer synthetic-card-service-token');
  assert.equal(sent.options.headers['X-Firebase-AppCheck'], undefined);
});
test('장애·오염 응답·잘못된 버전·리디렉션·시간 초과는 503으로 닫힌다', async () => {
  for (const fetchImpl of [async () => response({}, { status: 503 }), async () => response({}, { status: 302 }),
    async () => response({ success: true, cards: [card] }, { headers: { 'Content-Type': 'application/json' } }),
    async () => response({ success: true, cards: [{ cid: '../users', data: {} }] }), async () => { throw Error('private'); },
    async () => new Promise(() => {})]) {
    const client = createCardReadClient({ env, fetchImpl, timeoutMs: 20 });
    await assert.rejects(client.readCards({ cids: ['42'] }), error => error.status === 503 && !error.message.includes('private'));
  }
});
test('실행 설정은 HTTPS와 명시된 합성 환경을 검사한다', () => {
  assert.equal(settings({}), null);
  assert.throws(() => settings({ CARD_SERVICE_URL: 'http://card:8080' }));
  assert.throws(() => settings({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => settings({ ...env, CARD_SERVICE_URL: 'http://outside.example' }));
  assert.throws(() => settings({ ...env, CARD_SERVICE_URL: 'http://user:secret@card:8080' }));
  assert.equal(settings({ CARD_SERVICE_URL: 'https://card.example' }).audience, 'https://card.example');
});
test('인증 대기·본문 지연·4MiB 초과·다른 CID·중복 CID 응답은 조회 실패로 닫힌다', async () => {
  const cases = [
    { tokenProvider: async () => new Promise(() => {}), fetchImpl: async () => { throw Error('호출 금지'); } },
    { fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json', 'X-YGO-Card-Read': '1' } }) },
    { fetchImpl: async () => response({ success: true, cards: [{ ...card, data: { ...card.data, padding: 'x'.repeat(4 * 1024 * 1024) } }] }) },
    { fetchImpl: async () => response({ success: true, cards: [{ ...card, cid: '43' }] }) },
    { fetchImpl: async () => response({ success: true, cards: [card, card] }) },
  ];
  for (const options of cases) {
    const client = createCardReadClient({ env, timeoutMs: 30, ...options });
    await assert.rejects(client.readCards({ cids: ['42'] }), { status: 503, code: 'CARD_READ_UNAVAILABLE' });
  }
});
const lookup = readCards => require('../services/cardReadLookup').createRemoteCardLookup(readCards);
test('원격 조회는 CID 순서·중복 제거·100개 분할·이름 충돌·인벤토리 번호 의미를 보존한다', async () => {
  const calls = [];
  const query = lookup(async input => { calls.push(input); return input.cids ? input.cids.map(cid => ({ ...card, cid })) : [card]; });
  const result = await query.getCardsByCids(['42', '42', ...Array.from({ length: 100 }, (_, n) => String(n+100))]);
  assert.equal(result.length, 101); assert.equal(calls[0].cids.length, 100); assert.equal(calls[1].cids.length, 1);
  assert.equal(result[0].cid, '42'); assert.equal(await query.resolveInventoryCid('TEST', '시험'), '42');
  const multiple = lookup(async () => [card, { ...card, cid: '43' }]);
  await assert.rejects(multiple.findCard({ name: '시험' }), error => error.code === 'AMBIGUOUS_CARD');
  const failed = lookup(async () => { throw Object.assign(Error('카드 서버 장애'), { status: 503 }); });
  await assert.rejects(failed.getCardByCid('42'), /장애/);
  const empty = lookup(async () => []);
  assert.equal(await empty.getCardByCid('42'), null);
});
