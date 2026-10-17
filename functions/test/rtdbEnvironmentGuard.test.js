'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { readSourceFile } = require('./sourceFile');

const rtdbOnly = { FIREBASE_DATABASE_EMULATOR_HOST: 'localhost:9000' };
function load(relative, env, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(readSourceFile(path.join(__dirname, '..', relative), 'utf8'), {
    module, exports: module.exports, process: { env }, Buffer, Date,
    require(name) { assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${name}`); return mocks[name]; },
  });
  return module.exports;
}
function response() {
  return { code: 200, headers: {}, status(code) { this.code = code; return this; },
    set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } };
}

test('RTDB-only 요청은 로컬로 판정하고 기존 데이터 에뮬레이터가 없으면 처리 전에 거부한다', () => {
  const transport = load('services/publicReadTransport.js', rtdbOnly, { 'node:async_hooks': require('node:async_hooks') });
  let calls = 0;
  const res = response();
  assert.equal(transport.isLocal(), true);
  transport.withPublicReadRequest(() => { calls++; })({ headers: {} }, res);
  assert.equal(res.code, 503);
  assert.equal(calls, 0);
  const complete = load('services/publicReadTransport.js', { ...rtdbOnly,
    FIRESTORE_EMULATOR_HOST: 'localhost:5003', FIREBASE_STORAGE_EMULATOR_HOST: 'localhost:5004' },
  { 'node:async_hooks': require('node:async_hooks') });
  complete.withPublicReadRequest(() => { calls++; })({ headers: {} }, response());
  assert.equal(calls, 1);
});

test('RTDB-only 환경의 운영 파일 다운로드는 인증 토큰을 얻기 전에 차단한다', async () => {
  const config = load('config/firebase.js', rtdbOnly, {
    'firebase-admin': { apps: [{}], firestore: () => ({}), app() { assert.fail('운영 인증 접근 금지'); } },
    'firebase-admin/firestore': {}, 'firebase-functions/params': { defineSecret: name => ({ name }) },
  });
  await assert.rejects(config.downloadProductionFile('public/fixture.json'), /운영 API/);
});

test('RTDB-only 카드 API는 Firestore 조회·키 집계 전에 차단한다', async () => {
  let calls = 0;
  const api = load('routes/cardInfo.js', rtdbOnly, {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../config/firebase': { db: {} },
    '../services/cardApiAccessRepository': { getCardApiAccess: () => ({}) },
    '../services/cardInfoApi': { createCardInfoHandler: () => () => { calls++; } },
    '../services/illustrationDelivery': { createLimiter: () => () => true },
  });
  const res = response();
  await api.getCardInfo({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.code, 'API_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('RTDB-only 카드 색인 후속 실행은 운영 Tasks 큐에 제출하지 않는다', async () => {
  let queueCalls = 0;
  const dispatch = load('services/cardIndexDispatchService.js', rtdbOnly, {
    'node:crypto': { randomUUID: () => 'fixture-task' },
    'firebase-admin/functions': { getFunctions: () => { queueCalls++; throw Error('운영 Tasks 금지'); } },
    '../config/firebase': { db: { runTransaction: async () => 'fixture-next' } },
  });
  await assert.rejects(dispatch.finishCardIndexTask('fixture-current'), /Tasks 에뮬레이터/);
  assert.equal(queueCalls, 0);
});
