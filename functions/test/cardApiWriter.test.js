'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keyOptions } = require('../services/cardApiAccess');
const { checkApiKey, apiValue, consumeValue, checkApiCommand } = require('../services/cardApiWriterContract');
const { parseArgs, validateTarget } = require('../../scripts/manage_card_api_keys');
const policy = () => ({ ...keyOptions({ label: '합성', origins: [], minuteLimit: 2, dayLimit: 'unlimited' }), secretHash: 'a'.repeat(64), createdAt: 1 });
test('공통 API 키의 논리 자료는 원문 키·고아 CORS·알 수 없는 필드를 거부한다', () => {
  assert.equal(checkApiKey('apiKey/' + 'a'.repeat(24)), 'a'.repeat(24));
  for (const key of ['apiKey/raw', 'apiCors/current', 'apiKey/' + 'a'.repeat(25)]) assert.throws(() => checkApiKey(key));
  const value = { policy: policy(), usage: null, corsOrigins: [] }; assert.equal(apiValue(value), value);
  for (const invalid of [{ ...value, token: 'synthetic-only' }, { ...value, corsOrigins: ['https://other.example'] }, { ...value, policy: { ...value.policy, enabled: false } }]) assert.throws(() => apiValue(invalid));
  assert.throws(() => checkApiCommand({ changes: [{ key: 'apiCors/current', exists: true, value }], details: { kind: 'apiAccess', action: 'consume' } }));
});
test('쿼터는 분·UTC 일 창을 구분하고 안전 정수 초과와 오타 unlimited를 허용하지 않는다', () => {
  const value = { policy: policy(), usage: { minute: 0, day: 0, minuteCount: 2, dayCount: 100 }, corsOrigins: [] }, parsed = { secretHash: 'a'.repeat(64) };
  assert.throws(() => consumeValue(value, parsed, null, 59999), { code: 'RATE_LIMIT_EXCEEDED', retryAfter: 1 });
  const next = consumeValue(value, parsed, null, 60000); assert.equal(next.value.usage.minuteCount, 1); assert.equal(next.value.usage.dayCount, 101); assert.equal(next.result.dayRemaining, 'unlimited');
  const day = consumeValue(next.value, parsed, null, 86400000); assert.equal(day.value.usage.dayCount, 1);
  assert.throws(() => consumeValue({ ...value, usage: { ...value.usage, dayCount: Number.MAX_SAFE_INTEGER } }, parsed, null, 60000), { code: 'API_UNAVAILABLE' });
  assert.throws(() => apiValue({ ...value, policy: { ...value.policy, dayLimit: 'Unlimited' } }));
});
test('writer CLI는 독립 명시 대상만 허용하고 dry-run 전에 네 에뮬레이터·run·운영 차단을 검사한다', () => {
  const args = parseArgs(['disable', '--writer-emulator', '--id', 'a'.repeat(24)]);
  const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-migration', USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
    FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-migration-default-rtdb',
    FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' };
  assert.doesNotThrow(() => validateTarget(args, env));
  for (const override of [{ NODE_ENV: 'production' }, { GCLOUD_PROJECT: 'ygo-synapse' }, { USER_PROFILE_WRITER_RUN_ID: 'invalid' }, { FIREBASE_AUTH_EMULATOR_HOST: '' }, { CARD_SERVICE_URL: 'https://synthetic.invalid' }, { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/synthetic' }]) assert.throws(() => validateTarget(args, { ...env, ...override }));
  for (const extra of ['--production', '--rtdb-emulator', '--writer-emulator']) assert.throws(() => parseArgs(['disable', '--writer-emulator', '--id', 'a'.repeat(24), extra]));
  assert.throws(() => validateTarget(parseArgs(['disable', '--rtdb-emulator', '--id', 'a'.repeat(24)]), env));
});
