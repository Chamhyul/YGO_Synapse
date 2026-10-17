'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepareUserStorageStartup } = require('../services/userStorageStartup');
const production = () => ({ NODE_ENV: 'production', USER_STORAGE_MODE: 'production',
  USER_PROFILE_WRITER_MODE: 'production', K_SERVICE: 'synthetic', K_REVISION: 'synthetic-v13', FUNCTION_TARGET: 'addCards' });
test('실제 등록·제거 런타임만 동기 준비하고 배포 탐색·시험·다른 함수는 접근하지 않는다', () => {
  let calls = 0; const select = () => { calls++; return {}; };
  for (const target of ['addCards', 'discardCards']) assert.equal(prepareUserStorageStartup({ env: { ...production(), FUNCTION_TARGET: target }, select }), true);
  assert.equal(calls, 2);
  for (const patch of [{ NODE_ENV: 'test' }, { USER_STORAGE_MODE: 'emulator' }, { USER_PROFILE_WRITER_MODE: '' },
    { K_SERVICE: '' }, { K_REVISION: '' }, { FUNCTION_TARGET: '' }, { FUNCTION_TARGET: 'moveCards' }]) {
    assert.equal(prepareUserStorageStartup({ env: { ...production(), ...patch }, select: () => assert.fail('연결 금지') }), false);
  }
});
test('동기 준비 실패는 시작을 성공으로 위장하거나 다른 저장소를 선택하지 않는다', () => {
  let calls = 0;
  assert.equal(prepareUserStorageStartup({ env: production(), select: () => { calls++; throw Error('synthetic'); } }), false);
  assert.equal(calls, 1);
});
test('실제 공통 binding의 SDK 생성은 RTDB 경로 접근·metadata·업무 쓰기를 시작하지 않는다', async () => {
  const { createUserWriterRuntime } = require('../services/userProfileWriterRuntime');
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
  const target = { id: 'synthetic-startup', projectId: 'synthetic-startup', instanceId: 'synthetic-startup',
    location: 'asia-southeast1', databaseURL: 'https://synthetic-startup.asia-southeast1.firebasedatabase.app/', writerRunId: 'a'.repeat(32) };
  const env = { ...production(), USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: target.projectId, USER_STORAGE_TARGET: target.id,
    USER_PROFILE_WRITER_RUN_ID: target.writerRunId, USER_DATABASE_URL: target.databaseURL };
  const config = resolveProfileWriterConfig(env, [target]);
  const client = new (require('google-auth-library').Compute)();
  client.getAccessToken = client.getRequestHeaders = async () => assert.fail('metadata 접근 금지');
  const app = initializeApp({ projectId: target.projectId, credential: { getAccessToken: client.getAccessToken } }, 'synthetic-startup');
  const runtime = createUserWriterRuntime({ resolveConfig: () => config,
    createConnection: () => ({ database: { ref: () => assert.fail('RTDB 경로 접근 금지') }, app, authClient: client, close: () => deleteApp(app) }) });
  try {
    assert.equal(prepareUserStorageStartup({ env, select: runtime.getProfileWriterBinding }), true);
    const binding = runtime.getProfileWriterBinding(); assert.equal(binding.transition.runId, target.writerRunId);
    assert.equal(binding.claimsStorage.config, config);
  } finally { await runtime.closeProfileWriterRuntime(); }
});
