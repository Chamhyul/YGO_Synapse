'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { measure, withInventoryRequestTiming, MAX_SPANS } = require('../services/inventoryRequestTiming');
const response = () => Object.assign(new EventEmitter(), { statusCode: 200 });

test('계측은 동시 요청과 부모 단계를 분리하고 요청/결과/오류 원문을 수집하지 않는다', async () => {
  const logs = [], waiters = [];
  const handler = withInventoryRequestTiming('addCards', async (req, res) => {
    await measure('inventory.update', async () => {
      await measure('inventory.snapshot', () => new Promise(resolve => waiters.push(resolve)));
      return req.body;
    });
    await measure('writer.prepare', () => Promise.reject(new Error('PRIVATE_ERROR'))).catch(() => {});
    res.emit('finish'); res.emit('close'); return req.body;
  }, { emit: value => logs.push(JSON.parse(value)) });
  const a = handler({ method: 'POST', body: { private: 'PRIVATE_A' }, headers: { authorization: 'PRIVATE_TOKEN' } }, response());
  const b = handler({ method: 'POST', body: { private: 'PRIVATE_B' } }, response());
  waiters[1](); waiters[0]();
  assert.deepEqual(await a, { private: 'PRIVATE_A' }); assert.deepEqual(await b, { private: 'PRIVATE_B' });
  assert.equal(logs.length, 2); assert.notEqual(logs[0].requestId, logs[1].requestId);
  for (const row of logs) {
    assert.equal(row.completed, true); assert.equal(row.status, 200); assert.equal(row.spans.length, 3);
    assert.deepEqual(row.spans.map(s => [s.name, s.parent, s.ok]), [
      ['inventory.update', 0, true], ['inventory.snapshot', 1, true], ['writer.prepare', 0, false],
    ]);
    for (const span of row.spans) assert(span.durationMs >= 0 && span.startMs >= 0);
  }
  assert(!JSON.stringify(logs).includes('PRIVATE'));
});

test('계측 실패/초과/응답 종료는 업무 반환과 오류 및 저장 재실행을 바꾸지 않는다', async () => {
  let executions = 0; const logs = []; const res = response();
  const handler = withInventoryRequestTiming('discardCards', async () => {
    for (let i = 0; i < MAX_SPANS + 7; i++) assert.equal(measure('record.decode', () => ++executions), i + 1);
    res.emit('finish'); res.emit('close');
    return measure('record.decode', () => ++executions);
  }, { emit: value => logs.push(JSON.parse(value)) });
  assert.equal(await handler({ method: 'POST' }, res), MAX_SPANS + 8);
  assert.equal(logs.length, 1); assert.equal(logs[0].spans.length, MAX_SPANS); assert.equal(logs[0].droppedSpans, 7);
  assert.equal(await withInventoryRequestTiming('addCards', () => 42, { emit() { throw Error('log failure'); } })({ method: 'POST' }, {}), 42);
  await assert.rejects(withInventoryRequestTiming('addCards', () => measure('writer.commit', () => Promise.reject(0)), { emit() {} })({ method: 'POST' }, {}), error => error === 0);
  const marker = {}; assert.equal(measure('not-a-stage', () => marker), marker);
  assert.throws(() => measure('record.decode', () => { throw marker; }), error => error === marker);
});

test('OPTIONS 요청은 로그/계측을 만들지 않고 기존 응답을 유지한다', () => {
  const marker = {}; let logs = 0;
  assert.equal(withInventoryRequestTiming('addCards', () => marker, { emit() { logs++; } })({ method: 'OPTIONS' }, {}), marker);
  assert.equal(logs, 0);
});
