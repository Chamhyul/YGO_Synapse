'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const account = 'card-worker@ygo-synapse.iam.gserviceaccount.com';
function load(file, mocks = {}, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, process: { env }, Buffer,
    console: { log() {} },
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${name}`);
      return mocks[name];
    },
  });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('미등록 프로젝트는 기본 계정 선택을 Firebase에 맡긴다', () => {
  for (const env of [{}, { GCLOUD_PROJECT: 'demo-ygo' }, { GCLOUD_PROJECT: 'toString' }]) {
    assert.deepEqual(plain(load('config/serviceAccounts.js', {}, env).CARD_WORKER_OPTIONS), {});
  }
});

test('CLI의 프로젝트 ID만으로 운영 계정을 선택하고 입력 환경을 바꾸지 않는다', () => {
  const env = { GCLOUD_PROJECT: 'ygo-synapse', STORAGE_BUCKET: 'fixture-service-bucket' };
  const before = { ...env };
  assert.deepEqual(plain(load('config/serviceAccounts.js', {}, env).CARD_WORKER_OPTIONS), { serviceAccount: account });
  assert.deepEqual(env, before);
});

test('운영 프로젝트 ID를 사용해도 로컬 에뮬레이터에는 실행 계정을 지정하지 않는다', () => {
  for (const flags of [{ FUNCTIONS_EMULATOR: 'true' }, { FIREBASE_EMULATOR_HUB: 'localhost:4400' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:5003' }, { FIREBASE_STORAGE_EMULATOR_HOST: 'localhost:5004' }]) {
    assert.deepEqual(plain(load('config/serviceAccounts.js', {}, { GCLOUD_PROJECT: 'ygo-synapse', ...flags }).CARD_WORKER_OPTIONS), {});
  }
});

test('실행 계정 설정은 기본 DB·버킷과 로컬 운영 다운로드 차단을 바꾸지 않는다', async () => {
  const db = {}, bucketCalls = [], initCalls = [];
  const env = { GCLOUD_PROJECT: 'ygo-synapse', STORAGE_BUCKET: 'fixture-service-bucket',
    FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:5003',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:5004' };
  const before = { ...env };
  const config = load('config/firebase.js', {
    'firebase-admin': { apps: [], initializeApp: opts => initCalls.push(plain(opts)),
      firestore: () => db, storage: () => ({ bucket: name => { bucketCalls.push(name); return { name }; } }),
      app: () => assert.fail('로컬에서 운영 자격증명에 접근하면 안 됩니다.') },
    'firebase-admin/firestore': {}, 'firebase-functions/params': { defineSecret: name => ({ name }) },
  }, env);
  assert.equal(config.db, db);
  assert.equal(config.getBucket().name, 'fixture-service-bucket');
  assert.deepEqual(initCalls, [{ storageBucket: 'fixture-service-bucket' }]);
  assert.deepEqual(bucketCalls, ['fixture-service-bucket']);
  await assert.rejects(config.downloadProductionFile('fixture.json'), /운영 API/);
  assert.deepEqual(env, before);
});

const definitions = [
  { file: 'schedules/autoCrawler.js', name: 'autoCrawlFull', service: '../services/autoCrawlerService',
    method: 'runAutoCrawl', schedule: '0 4 * * *', expected: ['all'], timeout: 540 },
  { file: 'schedules/autoCrawler.js', name: 'autoCrawlQuick', service: '../services/autoCrawlerService',
    method: 'runAutoCrawl', schedule: '0 12,22 * * *', expected: ['main'], timeout: 540 },
  { file: 'tasks/autoCrawler.js', name: 'autoCrawlTask', service: '../services/autoCrawlerService',
    method: 'resumeAutoCrawl', attempts: 1, backoff: 60, expected: { runId: 'fixture-run' }, timeout: 540 },
  { file: 'tasks/cardIndexes.js', name: 'processCardIndexTask', service: '../services/cardIndexTaskService',
    method: 'runCardIndexTask', attempts: 5, backoff: 10, expected: 'fixture-run', timeout: 540 },
  { file: 'tasks/cardNumbers.js', name: 'migrateCardNumbersTask', service: '../services/cardNumbersMigrationService',
    method: 'processCardNumbersMigration', attempts: 3, backoff: 30, expected: { runId: 'fixture-run' }, timeout: 120 },
  { file: 'tasks/cardIllustrations.js', name: 'migrateCardIllustrationsTask', service: '../services/cardIllustrationsMigrationService',
    method: 'processCardIllustrationsMigration', attempts: 3, backoff: 60, expected: { runId: 'fixture-run' }, timeout: 540 },
];

for (const definition of definitions) {
  test(`${definition.name}: 실제 SDK의 실행 계정만 바뀌고 예약·재시도·처리 입력은 유지된다`, async () => {
    const calls = [];
    function worker(env) {
      return load(definition.file, {
        '../config/serviceAccounts': load('config/serviceAccounts.js', {}, env),
        'firebase-functions/v2/tasks': { onTaskDispatched },
        'firebase-functions/v2/scheduler': { onSchedule },
        '../config/crawler': { ALL_LOCALES: ['all'], MAIN_LOCALES: ['main'] },
        [definition.service]: { [definition.method]: async input => { calls.push(plain(input)); return { success: true }; } },
      })[definition.name];
    }
    const original = worker({});
    const configured = worker({ GCLOUD_PROJECT: 'ygo-synapse' });
    const before = plain(original.__endpoint), after = plain(configured.__endpoint);
    assert.equal(before.serviceAccountEmail, null);
    assert.equal(after.serviceAccountEmail, account);
    delete before.serviceAccountEmail;
    delete after.serviceAccountEmail;
    assert.deepEqual(after, before);
    assert.equal(after.timeoutSeconds, definition.timeout);
    if (definition.schedule) {
      assert.equal(after.scheduleTrigger.schedule, definition.schedule);
      assert.equal(after.scheduleTrigger.timeZone, 'Asia/Seoul');
    } else {
      assert.equal(after.taskQueueTrigger.rateLimits.maxConcurrentDispatches, 1);
      assert.equal(after.taskQueueTrigger.retryConfig.maxAttempts, definition.attempts);
      assert.equal(after.taskQueueTrigger.retryConfig.minBackoffSeconds, definition.backoff);
    }
    await original.run({ data: { runId: 'fixture-run' } });
    await configured.run({ data: { runId: 'fixture-run' } });
    assert.deepEqual(calls, [definition.expected, definition.expected]);
  });
}
