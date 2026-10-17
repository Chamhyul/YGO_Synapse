'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main, parseArgs, resolveTestConfig, safeReport } = require('./reconcile_membership_claims.cjs');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099',
  USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
const id = 'a'.repeat(32);
test('도움말은 설정·연결 생성 없이 출력한다', async () => {
  let output = '';
  assert.equal(await main(['--help'], { env: {}, createStorage: () => assert.fail(), createAuth: () => assert.fail(), stdout: value => { output += value; } }), 0);
  assert.match(output, /이전 앱\/복구 writer/);
});
test('복구에는 정확한 작업 ID와 명시적인 이전 writer 종료 확인이 필요하다', () => {
  assert.deepEqual(parseArgs(['--uid', 'synthetic']), { uid: 'synthetic', recover: false, writersDrained: false });
  assert.equal(parseArgs(['--uid', 'synthetic', '--operation', id, '--recover', '--writers-drained']).recover, true);
  for (const args of [[], ['--uid', 'x', '--recover'], ['--uid', 'x', '--operation', id, '--recover'],
    ['--uid', 'x', '--writers-drained'], ['--uid', 'x', '--operation', id], ['--uid', '\ud800'],
    ['--uid', 'x', '--uid', 'y'], ['--uid', 'x', '--recover', '--writers-drained', '--operation', 'secret']]) {
    assert.throws(() => parseArgs(args), { code: 'USER_STORAGE_INVALID_ARGUMENT' });
  }
});
test('운영·누락/외부 Auth·다른 호스트·실제 자격증명 설정은 factory 전에 차단한다', async () => {
  for (const patch of [{ NODE_ENV: 'production' }, { GCLOUD_PROJECT: 'production-project' }, { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { FIREBASE_AUTH_EMULATOR_HOST: 'external.example:9099' }, { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' },
    { FIREBASE_AUTH_EMULATOR_HOST: 'emulators:99999' }, { GOOGLE_APPLICATION_CREDENTIALS: 'private-path' }]) {
    let message;
    assert.equal(await main(['--uid', 'synthetic'], { env: { ...env, ...patch }, createStorage: () => assert.fail(), createAuth: () => assert.fail(), stderr: value => { message = value; } }), 1);
    assert.deepEqual(JSON.parse(message), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  assert.equal(resolveTestConfig(env).authEmulatorHost, 'emulators:9099');
});
test('요약 보고서는 UID·claims·오류 원문을 제거하고 형식 오류를 거부한다', () => {
  const input = { state: 'uncertain', stable: true, matches: false, version: '0', operationId: id, uid: 'private', claims: { token: 'private' } };
  assert.deepEqual(safeReport(input, false), { state: 'uncertain', stable: true, matches: false, version: '0', operationId: id, recovered: false });
  for (const patch of [{ version: 'private' }, { operationId: 'private' }, { state: 'private' }, { stable: 'true' }]) assert.throws(() => safeReport({ ...input, ...patch }, false));
});
test('Auth 생성 실패·저장소 대상 불일치에도 생성한 연결을 정리하고 원문을 출력하지 않는다', async () => {
  for (const mismatch of [false, true]) {
    let closes = 0, output;
    assert.equal(await main(['--uid', 'synthetic'], { env,
      createStorage: () => ({ config: mismatch ? {} : resolveTestConfig(env), close: async () => { closes++; } }),
      createAuth: () => { throw new Error('private-user token'); }, stderr: value => { output = value; } }), 1);
    assert.equal(closes, 1); assert.doesNotMatch(output, /private|token|stack/);
  }
});
