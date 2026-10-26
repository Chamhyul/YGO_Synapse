'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { measure, withLoginRequestTiming, withInventoryRequestTiming } = require('../services/inventoryRequestTiming');
function response() {
  const headers = new Map([['Access-Control-Expose-Headers', 'Existing']]);
  return Object.assign(new EventEmitter(), { statusCode: 200,
    setHeader: (k, v) => headers.set(k, v), getHeader: k => headers.get(k) });
}
test('GET 로그인 계측은 병렬 단계와 원래 반환을 보존하고 입력·반환·오류의 비밀값을 수집하지 않는다', async () => {
  const logs = [], releases = [], a = response(), b = response();
  const run = withLoginRequestTiming('getUserData', async (req, res) => {
    await measure('login.claims', () => Promise.all([
      measure('claims.account', () => new Promise(resolve => releases.push(resolve))),
      measure('claims.source', () => Promise.resolve(req.body)),
    ]));
    res.emit('finish'); res.emit('close'); return req.body;
  }, { emit: line => logs.push(JSON.parse(line)) });
  const x = run({ method: 'GET', body: { secret: 'PRIVATE_TOKEN_A' }, headers: { authorization: 'PRIVATE_AUTH' } }, a);
  const y = run({ method: 'GET', body: { secret: 'PRIVATE_TOKEN_B' } }, b);
  releases[1](); releases[0]();
  assert.deepEqual(await x, { secret: 'PRIVATE_TOKEN_A' }); assert.deepEqual(await y, { secret: 'PRIVATE_TOKEN_B' });
  assert.equal(logs.length, 2); assert(!JSON.stringify(logs).includes('PRIVATE'));
  assert.notEqual(logs[0].requestId, logs[1].requestId);
  for (const r of logs) {
    assert.equal(r.event, 'login_request_timing'); assert.equal(r.spans[1].parent, r.spans[0].id);
    assert(r.spans.every(s => Number.isFinite(s.durationMs) && s.durationMs >= 0));
  }
  assert.match(a.getHeader('X-YGO-Login-Timing'), /^[a-f0-9]{24}$/);
  assert.equal(a.getHeader('Access-Control-Expose-Headers'), 'Existing, X-YGO-Login-Timing');
});
test('선제 warmup·OPTIONS는 계측/헤더/first 표본에 포함하지 않고 예외·출력 실패도 업무를 바꾸지 않는다', async () => {
  const logs = [], run = withLoginRequestTiming('getRegistrationStatus', () => 42, { emit: x => logs.push(JSON.parse(x)) });
  for (const req of [{ method: 'OPTIONS' }, { method: 'GET', query: { warmup: 'true' } }, { method: 'POST', body: { warmup: 'true' } }]) {
    const res = response(); assert.equal(run(req, res), 42); assert.equal(res.getHeader('X-YGO-Login-Timing'), undefined);
  }
  assert.equal(logs.length, 0);
  assert.equal(await run({ method: 'GET' }, {}), 42); assert.equal(logs[0].firstTimedRequest, true);
  await run({ method: 'GET' }, {}); assert.equal(logs[1].firstTimedRequest, false);
  const error = { private: 'PRIVATE_ERROR' };
  await assert.rejects(withLoginRequestTiming('getUserData', () => measure('login.profile', () => Promise.reject(error)), { emit() { throw 1; } })({ method: 'GET' }, {}), e => e === error);
  const inventory = []; await withInventoryRequestTiming('addCards', () => 1, { emit: x => inventory.push(JSON.parse(x)) })({ method: 'POST' }, {});
  assert.equal(inventory[0].event, 'inventory_request_timing');
});
