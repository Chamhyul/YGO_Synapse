'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepareMembershipWorkerStartup: prepare, measureInitialization: step,
  withMembershipWorkerTiming, mark } = require('../services/membershipWorkerTiming');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { createUserWriterRuntime } = require('../services/userProfileWriterRuntime');
const { encodeKey } = require('../services/user-storage/codec');
const { createProfilePayloadCodec } = require('../services/user-storage/profileCodec');
const env = { K_SERVICE: 'synthetic', K_REVISION: 'synthetic', FUNCTION_TARGET: 'syncMembershipClaimsAfterProfile' };

test('일반 함수·배포 탐색·각 emulator는 기동 연결을 선택하지 않는다', () => {
  for (const value of [{}, { FUNCTION_TARGET: env.FUNCTION_TARGET }, { ...env, FUNCTION_TARGET: 'getUserData' },
    ...['FUNCTIONS_EMULATOR', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'].map(key => ({ ...env, [key]: 'synthetic' }))]) {
    assert.equal(prepare(() => { assert.fail('선택 금지'); }, { env: value, emit() { assert.fail('출력 금지'); } }), undefined);
  }
});

test('구성은 기동 때 한 번 만들고 매 이벤트의 설정·route·claims 검사는 다시 실행한다', async () => {
  let bindings = 0, configs = 0, routes = 0, syncs = 0;
  const config = { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' };
  const storage = { writerTransition: { route: async () => { routes++; return { phase: 'accepting' }; } } };
  const runtime = createUserWriterRuntime({ env, resolveConfig: () => { configs++; return config; },
    createConnection: () => ({ database: {}, close: async () => {} }),
    createProductionServices: () => ({ db: {}, bucket: {}, auth: {} }),
    createBinding: () => { bindings++; return { claimsStorage: storage }; } });
  const select = () => ({ config, storage: runtime.getProfileWriterBinding().claimsStorage });
  const startup = [], events = [];
  prepare(select, { env, emit: value => startup.push(value) });
  assert.equal(bindings, 1); assert.equal(configs, 1); assert.equal(routes, 0); assert.equal(syncs, 0);
  for (const name of ['worker.runtime', 'worker.config', 'worker.connection', 'worker.services',
    'worker.binding_module', 'worker.firestore_types', 'worker.binding']) assert.ok(startup[0].spans.some(s => s.name === name), name);
  const codec = createProfilePayloadCodec();
  const event = { params: { userKey: encodeKey('synthetic') }, instance: 'synthetic', location: config.location,
    data: { before: { val: () => null }, after: { val: () => ({ format: 1, revision: 1, generation: 0,
      tombstone: false, payload: codec.encode({ settings: { membership: { status: 'active' } } }) }) } } };
  const handler = withMembershipWorkerTiming(createMembershipClaimsFollowup({ select,
    sync: async () => { syncs++; return { status: 'synced' }; }, emit() {} }), { emit: value => events.push(value) });
  await handler(event); await handler(event);
  assert.equal(bindings, 1); assert.equal(configs, 3); assert.equal(routes, 2); assert.equal(syncs, 2);
  assert.equal(events[0].firstTimedRequest, true); assert.equal(events[1].firstTimedRequest, false);
  assert.equal(events[0].startupPrepared, true); assert.equal(events[0].status, 'synced');
  assert.ok(events[0].spans.some(s => s.name === 'worker.config'));
  assert.ok(!events[0].spans.some(s => s.name === 'worker.binding'));
  config.location = 'changed';
  await assert.rejects(handler(event), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });
  assert.equal(syncs, 2);
  await runtime.closeProfileWriterRuntime();
  assert.throws(select, { code: 'USER_STORAGE_CONFIG_INVALID' });
});

test('기동 실패는 숨기지 않고 계측에는 입력·원문을 넣지 않는다', () => {
  const logs = [], error = new Error('private-config-value');
  assert.throws(() => prepare(() => step('worker.connection', () => { throw error; }),
    { env, emit: value => logs.push(value) }), value => value === error);
  assert.equal(logs[0].status, 'failed'); assert.equal(logs[0].spans.at(-1).ok, false);
  assert.doesNotMatch(JSON.stringify(logs), /private-config-value|synthetic|K_SERVICE/);
  assert.throws(() => prepare(() => ({ config: { mode: 'emulator' }, storage: {} }), { env, emit() {} }),
    { code: 'MEMBERSHIP_WORKER_STARTUP_INVALID' });
});

test('관측 오류·관측 문맥 밖 실행은 원래 결과를 바꾸지 않는다', async () => {
  assert.equal(step('worker.config', () => 7), 7);
  const runtime = { config: { mode: 'production' }, storage: { writerTransition: {} } };
  assert.equal(prepare(() => runtime, { env, emit() { throw Error('observer'); } }), runtime);
  const logs = [];
  await withMembershipWorkerTiming(() => { mark('synced', 1); }, { emit: value => logs.push(value) })({});
  assert.equal(logs[0].status, 'synced'); assert.equal(logs[0].startupPrepared, true);
  assert.ok(logs[0].startupAgeMs >= 0);
});
