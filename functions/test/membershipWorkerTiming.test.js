'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withMembershipWorkerTiming, measure, mark, MAX_SPANS } = require('../services/membershipWorkerTiming');
const shared = require('../services/inventoryRequestTiming');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { encodeKey } = require('../services/user-storage/codec');
const { createProfilePayloadCodec } = require('../services/user-storage/profileCodec');
const codec = createProfilePayloadCodec();
const event = () => ({ params: { userKey: encodeKey('synthetic-private-user') }, instance: 'synthetic', location: 'asia-southeast1',
  data: { before: { val: () => null }, after: { val: () => ({ format: 1, revision: 1, generation: 0, tombstone: false,
    payload: codec.encode({ settings: { membership: { secret: 'event-body-must-not-log' } } }) }) } } });

test('실제 worker 단계와 공유 claims 하위 단계가 한 문맥에 기록되며 원문을 남기지 않는다', async () => {
  const logs = [];
  const runtime = { config: { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' },
    storage: { writerTransition: { route: () => shared.measure('journal.route', async () => ({ phase: 'accepting' })) } } };
  const handler = withMembershipWorkerTiming(createMembershipClaimsFollowup({ select: () => runtime,
    sync: () => shared.measure('claims.account', async () => ({ status: 'synced', raw: 'auth-body-must-not-log' })), emit() {} }),
  { emit: v => logs.push(v) });
  await handler(event());
  assert.equal(logs.length, 1); const log = logs[0];
  assert.equal(log.status, 'synced'); assert.equal(log.attempts, 1);
  for (const name of ['worker.event_decode', 'worker.runtime', 'worker.route', 'journal.route', 'worker.sync', 'claims.account']) {
    assert.ok(log.spans.some(s => s.name === name), name);
  }
  assert.equal(log.spans.find(s => s.name === 'claims.account').parent, log.spans.find(s => s.name === 'worker.sync').id);
  for (const n of ['totalMs', 'processAgeMs', 'processCpuUserMs', 'processCpuSystemMs']) assert.ok(Number.isFinite(log[n]) && log[n] >= 0);
  assert.doesNotMatch(JSON.stringify(log), /synthetic-private-user|event-body|auth-body|payload|userKey/);
});

test('실패·영속 재배달 결과와 원래 반환값은 관측 장애로 바뀌지 않는다', async () => {
  const error = new Error('private-error-body');
  const failed = [];
  await assert.rejects(withMembershipWorkerTiming(() => measure('claims.patch', () => { throw error; }),
    { emit: v => failed.push(v) })({}), e => e === error);
  assert.equal(failed[0].status, 'failed'); assert.equal(failed[0].spans[0].ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /private-error-body/);
  assert.equal(await withMembershipWorkerTiming(() => { mark('synced', 1); return 'original'; },
    { emit() { throw new Error('observer'); } })({}), 'original');
  await assert.rejects(withMembershipWorkerTiming(() => { throw error; }, { emit() { throw new Error('observer'); } })({}), e => e === error);
});

test('동시 요청·종료 후 작업은 서로 섞이지 않고 계측 크기는 제한된다', async () => {
  const logs = []; let release;
  const first = withMembershipWorkerTiming(async () => {
    await measure('worker.sync', () => new Promise(resolve => { release = resolve; })); mark('synced', 1);
  }, { emit: v => logs.push(v) })({});
  await withMembershipWorkerTiming(async () => {
    for (let i = 0; i < MAX_SPANS + 3; i++) await measure('claims.account', async () => {});
    await measure('untrusted-stage-private-data', async () => {}); mark('unchanged');
  }, { emit: v => logs.push(v) })({});
  release(); await first;
  assert.equal(logs[0].spans.length, MAX_SPANS); assert.equal(logs[0].droppedSpans, 3);
  assert.equal(logs[0].status, 'unchanged'); assert.equal(logs[1].spans.length, 1);
  assert.equal(logs[1].status, 'synced'); assert.doesNotMatch(JSON.stringify(logs), /untrusted-stage-private-data/);
  assert.equal(measure('claims.account', () => 7), 7);
});

test('worker 경합 대기는 재시도 횟수와 별도 단계로 나타나며 drain은 거부한다', async () => {
  let count = 0; const logs = [];
  const runtime = { config: { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' },
    storage: { writerTransition: { route: async () => ({ phase: 'accepting' }) } } };
  const build = () => withMembershipWorkerTiming(createMembershipClaimsFollowup({ select: () => runtime,
    sync: async () => ({ status: ++count > 1 ? 'synced' : 'pending' }), wait: async () => {}, emit() {} }),
  { emit: v => logs.push(v) });
  await build()(event());
  assert.equal(logs[0].attempts, 2); assert.equal(logs[0].spans.filter(s => s.name === 'worker.retry_wait').length, 1);
  runtime.storage.writerTransition.route = async () => ({ phase: 'draining' });
  await assert.rejects(build()(event()), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });
  assert.equal(logs[1].status, 'failed'); assert.equal(count, 2);
});
