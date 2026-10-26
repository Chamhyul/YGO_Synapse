'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMembershipWorkerPreparation: create, withMembershipWorkerPreparation: wrap,
  WORKER_URL, TYPE, SOURCE } = require('../services/membershipWorkerPreparation');
const env = { GCLOUD_PROJECT: 'ygo-synapse', USER_STORAGE_MODE: 'production',
  K_SERVICE: 'getuserdata', K_REVISION: 'synthetic', FUNCTION_TARGET: 'getUserData' };
const workerEnv = { ...env, FUNCTION_TARGET: 'syncMembershipClaimsAfterProfile' };
const event = () => ({ specversion: '1.0', type: TYPE, source: SOURCE,
  id: '00000000-0000-4000-8000-000000000001', data: { version: 1 } });
const config = { mode: 'production' };
const storage = { writerTransition: new Proxy({}, { get() { assert.fail('준비에서 전환·DB 조회 금지'); } }) };
const res = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const body = { warmup: 'true', membershipPrepare: true, workerPrepare: true };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('로컬·다른 프로젝트/함수·emulator는 토큰이나 네트워크에 접근하지 않는다', async () => {
  for (const value of [{}, { ...env, GCLOUD_PROJECT: 'other' }, { ...env, FUNCTION_TARGET: 'verifyYoutubeMembership' },
    { ...env, K_SERVICE: '' }, { ...env, USER_STORAGE_MODE: '' },
    ...['FUNCTIONS_EMULATOR', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']
      .map(key => ({ ...env, [key]: 'synthetic' }))]) {
    assert.equal((await create({ env: value, identity: () => assert.fail('토큰 금지'),
      fetchImpl: () => assert.fail('전송 금지') })()).status, 'unavailable');
  }
});

test('고정 worker/audience로 무자료 CloudEvent만 전달하고 겹친 요청·60초 내 요청을 합친다', async () => {
  let time = 0, tokens = 0; const calls = [], pending = gate();
  const prepare = create({ env, now: () => time, identity: async () => { tokens++; return 'Bearer synthetic'; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); await pending.promise; return { status: 204 }; } });
  const first = prepare(), same = prepare(); assert.equal(first, same);
  pending.resolve(); assert.equal((await first).status, 'delivered');
  assert.equal((await prepare()).status, 'throttled'); assert.equal(tokens, 1); assert.equal(calls.length, 1);
  const { url, options } = calls[0]; assert.equal(url, WORKER_URL); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['ce-type'], TYPE); assert.equal(options.headers['ce-source'], SOURCE);
  assert.deepEqual(JSON.parse(options.body), { version: 1 });
  assert.doesNotMatch(options.body, /uid|profile|claims|token|nonce/i);
  time = 60000; assert.equal((await prepare()).status, 'delivered'); assert.equal(tokens, 2);
});

test('IAM 거부·구형 worker·리다이렉트·전송 실패는 인증 성공이나 자동 재시도가 되지 않는다', async () => {
  for (const code of [200, 301, 400, 401, 403, 404, 500]) {
    let calls = 0;
    const prepare = create({ env, identity: async () => 'Bearer synthetic', fetchImpl: async () => { calls++; return { status: code }; } });
    assert.equal((await prepare()).status, 'unavailable'); assert.equal((await prepare()).status, 'throttled'); assert.equal(calls, 1);
  }
  assert.equal((await create({ env, identity: async () => { throw Error('private'); } })()).status, 'unavailable');
  assert.equal((await create({ env, identity: async () => 'Bearer synthetic', fetchImpl: async () => { throw Error('private'); } })()).status, 'unavailable');
});

test('토큰 지연은 제한 시간에 종료하며 이후 토큰이 나와도 전송하지 않는다', async () => {
  const token = gate(); let sent = 0;
  const prepare = create({ env, timeoutMs: 15, identity: () => token.promise,
    fetchImpl: () => { sent++; } });
  assert.equal((await prepare()).status, 'unavailable'); token.resolve('Bearer late');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0);
});

test('전송 지연도 취소하고 같은 제한 구간에서 다시 전송하지 않는다', async () => {
  let signal, sent = 0;
  const prepare = create({ env, timeoutMs: 15, identity: async () => 'Bearer synthetic',
    fetchImpl: async (_url, options) => { signal = options.signal; sent++; await new Promise(() => {}); } });
  assert.equal((await prepare()).status, 'unavailable'); assert.equal(signal.aborted, true);
  assert.equal((await prepare()).status, 'throttled'); assert.equal(sent, 1);
});

test('worker 준비는 SDK DB 변환·원본·Auth·route·잠금을 실행하지 않고 실제 이벤트는 원래 함수로 전달한다', async () => {
  let business = 0, selected = 0; const logs = [];
  const original = async input => { business++; return input; };
  original.run = () => 'original-run'; original.__endpoint = { eventTrigger: { eventType: 'google.firebase.database.ref.v1.written' } };
  const worker = wrap(original, { env: workerEnv, select: () => { selected++; return { config, storage }; }, emit: l => logs.push(l) });
  await worker(event()); assert.equal(selected, 1); assert.equal(business, 0);
  assert.deepEqual(logs, [{ event: 'membership_worker_preparation', version: 1, status: 'prepared' }]);
  assert.equal(worker.__endpoint, original.__endpoint); assert.equal(worker.run, original.run);
  const real = { type: 'google.firebase.database.ref.v1.written', data: { value: 'synthetic' } };
  assert.equal(await worker(real), real); assert.equal(business, 1); assert.equal(selected, 1);
});

test('실제 Firebase SDK export의 준비 신호는 DB 변환 전에 분리되고 기존 DB 이벤트·메타정보는 유지된다', async () => {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-worker-preparation' });
  const { onValueWritten } = require('firebase-functions/v2/database');
  let received;
  const original = onValueWritten({ ref: '/users/{userKey}/profile', instance: 'synthetic',
    region: 'asia-southeast1', retry: true, concurrency: 1, maxInstances: 3 }, e => { received = e; });
  const worker = wrap(original, { env: workerEnv, select: () => ({ config, storage }), emit() {} });
  await worker(event()); assert.equal(received, undefined);
  assert.deepEqual(worker.__endpoint, original.__endpoint); assert.equal(worker.run, original.run);
  await worker({ type: 'google.firebase.database.ref.v1.written', specversion: '1.0',
    id: 'synthetic-event', source: 'synthetic', instance: 'synthetic', firebasedatabasehost: 'firebaseio.com',
    location: 'asia-southeast1', ref: 'users/synthetic/profile', data: { data: null, delta: { synthetic: true } } });
  assert.equal(received.params.userKey, 'synthetic'); assert.equal(received.data.before.val(), null);
  assert.deepEqual(received.data.after.val(), { synthetic: true });
});

test('변조된 준비·로컬 실행·실패한 구성은 거부하고 원래 업무로 넘기지 않는다', async () => {
  for (const bad of [{ ...event(), type: TYPE + '.other' }, { ...event(), source: 'untrusted' },
    { ...event(), id: '' }, { ...event(), specversion: '0.3' }, { ...event(), data: { version: 1, uid: 'synthetic' } },
    { ...event(), data: [] }, { ...event(), data: null }]) {
    await assert.rejects(wrap(() => assert.fail('업무 금지'), { env: workerEnv,
      select: () => assert.fail('구성 접근 금지') })(bad), { code: 'MEMBERSHIP_WORKER_PREPARATION_INVALID' });
  }
  await assert.rejects(wrap(() => assert.fail(), { env: {}, select: () => assert.fail() })(event()),
    { code: 'MEMBERSHIP_WORKER_PREPARATION_INVALID' });
  await assert.rejects(wrap(() => assert.fail(), { env: workerEnv, select: () => ({}) })(event()),
    { code: 'MEMBERSHIP_WORKER_PREPARATION_INVALID' });
  await assert.rejects(wrap(() => assert.fail(), { env: workerEnv, select: () => { throw Error('closed'); } })(event()), /closed/);
});

test('준비 요청 필드는 getUserData에서만 허용하며 업무 필드와 섞으면 전송하지 않는다', async () => {
  const { respondMembershipReadiness } = require('../services/membershipReadiness');
  for (const [target, input] of [['verifyYoutubeMembership', body], ['verifyDiscordMembership', body],
    ['getUserData', { ...body, workerPrepare: false }], ['getUserData', { ...body, uid: 'synthetic' }],
    ['getUserData', { ...body, accessToken: 'synthetic' }]]) {
    const response = res(); await respondMembershipReadiness({ method: 'POST', body: input }, response, target,
      { load: () => assert.fail(), prepareWorker: () => assert.fail() });
    assert.equal(response.code, 400);
  }
  for (const prepareWorker of [async () => ({ status: 'delivered', private: 'must-not-return' }),
    async () => { throw Error('private'); }]) {
    const response = res(); await respondMembershipReadiness({ method: 'POST', body }, response, 'getUserData', { load() {}, prepareWorker });
    assert.equal(response.body.success, true); assert.equal(response.body.membershipPreparation.ready, true);
    assert.doesNotMatch(JSON.stringify(response.body), /must-not-return|private|token|uid/);
  }
});
