'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { measure, withMembershipRequestTiming, withLoginRequestTiming, captureMembershipStorageMetrics } = require('../services/inventoryRequestTiming');
const { beginMembershipStorageMetrics } = require('../services/membershipStorageMetrics');
const handler = (work, logs, operation = 'verifyYoutubeMembership') => withMembershipRequestTiming(operation, work, { emit: line => logs.push(JSON.parse(line)) });

test('최초 입력과 성공 부모의 UTF-8 JSON 크기·영수증 건수·CPU는 숫자로만 기록한다', async () => {
  const logs = [], raw = { profile: { private: 'PRIVATE_USER_한글' }, membershipWriterReceipts: { PRIVATE_NONCE_A: { private: 'PRIVATE_TOKEN' } }, profileWriterReceipts: { PRIVATE_ID: { data: 'PRIVATE_PROFILE' } } };
  const before = Buffer.byteLength(JSON.stringify(raw));
  await handler(async () => {
    let metrics;
    await measure('membership.storage_transaction', async () => {
      metrics = beginMembershipStorageMetrics(); metrics.input(raw);
      metrics.input({ sensitive: '재시도 값은 다시 직렬화하지 않는다' });
      raw.membershipWriterReceipts.PRIVATE_NONCE_B = { data: 'PRIVATE' };
      metrics.finish(); metrics.finish();
    });
    metrics.committed(raw);
  }, logs)({ method: 'POST' }, {});
  const span = logs[0].spans[0], n = span.numbers;
  assert.equal(n.inputParentJsonBytes, before);
  assert.equal(n.committedParentJsonBytes, Buffer.byteLength(JSON.stringify(raw)));
  assert.equal(n.inputMembershipReceiptCount, 1); assert.equal(n.committedMembershipReceiptCount, 2);
  assert.equal(n.inputProfileReceiptCount, 1); assert.equal(n.committedProfileReceiptCount, 1);
  assert.equal(n.callbackCount, 2); assert.equal(n.metricsErrors, 0);
  for (const key of ['processCpuUserMs', 'processCpuSystemMs', 'inputMetricsMs', 'inputMetricsCpuMs', 'committedMetricsMs', 'committedMetricsCpuMs']) assert(Number.isFinite(n[key]) && n[key] >= 0, key);
  assert(Object.values(n).every(v => typeof v === 'number'));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|한글|재시도/);
});

test('수집 필드 허용 목록과 유효 숫자만 받고 getter·원문·임의 필드를 기록하지 않는다', async () => {
  const logs = [];
  await handler(() => measure('membership.storage_transaction', () => {
    const record = captureMembershipStorageMetrics();
    record({ inputParentJsonBytes: 123, callbackCount: 1, processCpuUserMs: Infinity, processCpuSystemMs: -1, metricsErrors: NaN, uid: 123456, PRIVATE: 'TOKEN', inputProfileReceiptCount: 'PRIVATE_ID' });
    record(Object.defineProperty({}, 'committedParentJsonBytes', { get() { assert.fail('진단 getter 실행 금지'); } }));
  }), logs)({ method: 'POST' }, {});
  assert.deepEqual(logs[0].spans[0].numbers, { inputParentJsonBytes: 123, callbackCount: 1 });
});

test('직렬화 실패는 업무 오류와 반환값을 바꾸지 않으며 원문 오류도 기록하지 않는다', async () => {
  const logs = [], circular = {}; circular.self = circular;
  const original = Object.assign(Error('PRIVATE_BUSINESS_FAILURE'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(handler(() => measure('membership.storage_transaction', () => {
    const metrics = beginMembershipStorageMetrics(); metrics.input(circular);
    try { throw original; } finally { metrics.finish(); }
  }), logs)({ method: 'POST' }, {}), e => e === original);
  assert.equal(logs[0].spans[0].ok, false);
  assert.equal(logs[0].spans[0].numbers.metricsErrors, 1);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|self|AMBIGUOUS/);
});

test('검증 외·준비 요청·계측 문맥 밖에서는 직렬화와 CPU 수집을 시작하지 않는다', async () => {
  let serialized = 0; const raw = { toJSON() { serialized++; return {}; } }, logs = [];
  const work = () => measure('membership.storage_transaction', () => { const m = beginMembershipStorageMetrics(); m.input(raw); m.finish(); m.committed(raw); return 7; });
  assert.equal(work(), 7);
  for (const operation of ['startDiscordMembershipVerification', 'startYoutubeMembershipVerification']) assert.equal(await handler(work, logs, operation)({ method: 'POST' }, {}), 7);
  assert.equal(await handler(work, logs)({ method: 'POST', body: { membershipPrepare: true } }, {}), 7);
  await withLoginRequestTiming('getUserData', work, { emit: line => logs.push(JSON.parse(line)) })({ method: 'POST' }, {});
  assert.equal(serialized, 0); assert(logs.every(l => l.spans.every(s => !s.numbers)));
});

test('응답 종료 뒤 늦은 성공/콜백은 숫자나 원문을 추가 수집하지 않는다', async () => {
  const logs = [], res = Object.assign(new EventEmitter(), { statusCode: 200 }); let serialized = 0;
  await handler(() => measure('membership.storage_transaction', () => {
    const m = beginMembershipStorageMetrics(); m.input({}); m.finish(); res.emit('finish');
    m.input({ toJSON() { serialized++; return {}; } });
    m.committed({ toJSON() { serialized++; return {}; } });
  }), logs)({ method: 'POST' }, res);
  assert.equal(serialized, 0); assert.equal(logs.length, 1);
});
