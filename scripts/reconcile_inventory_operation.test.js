'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main, parseArgs } = require('./reconcile_inventory_operation.cjs');

const operationId = 'a'.repeat(32);
const args = ['--uid', 'synthetic-user', '--operation', operationId];
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000',
  USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-user-storage-default-rtdb' };
const report = { operationId, status: 'committed', cleanup: 'complete', expectedRevision: 3, revision: 4, generation: 0 };

function harness(overrides = {}) {
  const calls = [], stdout = [], stderr = [];
  const inventory = {
    async inspectOperation(...values) { calls.push(['inspect', ...values]); return report; },
    async recoverOperation(...values) { calls.push(['recover', ...values]); return report; },
    ...overrides.inventory,
  };
  const storage = { inventory, async close() { calls.push(['close']); }, ...overrides.storage };
  const options = { env, createStorage: async () => { calls.push(['create']); return storage; },
    stdout: value => stdout.push(value), stderr: value => stderr.push(value), ...overrides.options };
  return { calls, stdout, stderr, options };
}

test('기본 명령은 읽기 대조만 호출하고 연결을 종료한다', async () => {
  const f = harness();
  assert.equal(await main(args, f.options), 0);
  assert.deepEqual(f.calls, [['create'], ['inspect', 'synthetic-user', operationId], ['close']]);
  assert.deepEqual(JSON.parse(f.stdout.join('')), report);
  assert.deepEqual(f.stderr, []);
});

test('복구는 pending을 보존하며 별도 취소 옵션만 취소를 허용한다', async () => {
  for (const cancelPending of [false, true]) {
    const f = harness();
    assert.equal(await main([...args, '--recover', ...(cancelPending ? ['--cancel-pending'] : [])], f.options), 0);
    assert.deepEqual(f.calls, [['create'], ['recover', 'synthetic-user', operationId, { cancelPending }], ['close']]);
  }
});

test('도움말은 설정 검증과 SDK 생성 없이 출력한다', async () => {
  const f = harness({ options: { env: {} } });
  assert.equal(await main(['--help'], f.options), 0);
  assert.deepEqual(f.calls, []);
  assert.match(f.stdout.join(''), /기본 실행은 기록을 읽어 대조만/);
  assert.deepEqual(f.stderr, []);
});

test('잘못된 인자와 취소 단독 요청은 연결 전에 거부하며 입력을 노출하지 않는다', async () => {
  for (const invalid of [[], ['--uid', 'synthetic-user'], ['--operation', operationId],
    [...args, '--cancel-pending'], [...args, '--unknown-secret'], [...args, '--recover', '--recover'],
    ['--uid', 'private\nuid', '--operation', operationId], ['--uid', ' '.repeat(3), '--operation', operationId],
    ['--uid', '\ud800', '--operation', operationId], ['--uid', 'x'.repeat(129), '--operation', operationId],
    ['--uid', 'synthetic-user', '--operation', 'secret-token'], [...args, '--uid', 'second-user']]) {
    const f = harness();
    assert.equal(await main(invalid, f.options), 2);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.stdout, []);
    assert.deepEqual(JSON.parse(f.stderr.join('')), { code: 'USER_STORAGE_INVALID_ARGUMENT' });
  }
  assert.throws(() => parseArgs([null]), { code: 'USER_STORAGE_INVALID_ARGUMENT' });
});

test('일반·운영·외부주소 설정은 SDK factory를 호출하기 전에 거부한다', async () => {
  for (const badEnv of [{}, { ...env, NODE_ENV: 'production' }, { ...env, GCLOUD_PROJECT: 'production-project' },
    { ...env, FIREBASE_DATABASE_EMULATOR_HOST: 'external.example:9000' },
    { ...env, USER_DATABASE_URL: 'https://production.example/?token=synthetic-secret' }]) {
    const f = harness({ options: { env: badEnv } });
    assert.equal(await main(args, f.options), 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.stdout, []);
    assert.deepEqual(JSON.parse(f.stderr.join('')), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
});

test('보고서는 허용한 상태·수치만 출력하고 UID·본문·자격증명을 제거한다', async () => {
  const f = harness({ inventory: { async inspectOperation() { return { ...report, uid: 'private-user',
    cards: { privateCard: true }, token: 'private-token', credentials: 'private-credential', cancelledHere: true }; } } });
  assert.equal(await main(args, f.options), 0);
  assert.deepEqual(JSON.parse(f.stdout.join('')), report);
  assert.doesNotMatch(f.stdout.join(''), /private|cards|credentials|cancelledHere/);
});

test('미확정 pending 보고서는 성공이나 취소로 바꾸지 않는다', async () => {
  const pending = { operationId, status: 'prepared', cleanup: 'pending', expectedRevision: 0 };
  const f = harness({ inventory: { async recoverOperation() { return pending; } } });
  assert.equal(await main([...args, '--recover'], f.options), 0);
  assert.deepEqual(JSON.parse(f.stdout.join('')), pending);
});

test('예상 오류는 코드만 출력하고 예상 밖 오류의 원문·stack·code도 노출하지 않는다', async () => {
  for (const [code, expected] of [['USER_STORAGE_WRITE_AMBIGUOUS', 'USER_STORAGE_WRITE_AMBIGUOUS'],
    ['private-token', 'USER_STORAGE_RECOVERY_FAILED'], [undefined, 'USER_STORAGE_RECOVERY_FAILED']]) {
    const f = harness({ inventory: { async inspectOperation() {
      throw Object.assign(new Error('private-user private-token private-path'), { code });
    } } });
    assert.equal(await main(args, f.options), 1);
    assert.deepEqual(f.stdout, []);
    assert.deepEqual(JSON.parse(f.stderr.join('')), { code: expected });
    assert.deepEqual(f.calls.at(-1), ['close']);
    assert.doesNotMatch(f.stderr.join(''), /private|stack|Error/);
  }
});

test('결과 형식 검증 실패와 연결 종료 실패도 안전한 코드로 처리한다', async () => {
  for (const invalid of [{ ...report, status: 'private-user' }, { ...report, cleanup: 'private-token' },
    { ...report, operationId: 'private-user' }, { ...report, expectedRevision: -1 },
    { ...report, revision: Infinity }, { ...report, generation: 'private-data' }]) {
    const f = harness({ inventory: { async inspectOperation() { return invalid; } } });
    assert.equal(await main(args, f.options), 1);
    assert.deepEqual(f.stdout, []);
    assert.deepEqual(JSON.parse(f.stderr.join('')), { code: 'USER_STORAGE_INVALID_RECOVERY_REPORT' });
    assert.deepEqual(f.calls.at(-1), ['close']);
  }
  const f = harness({ storage: { async close() { throw new Error('private-token'); } } });
  assert.equal(await main(args, f.options), 1);
  assert.deepEqual(JSON.parse(f.stderr.join('')), { code: 'USER_STORAGE_CLOSE_FAILED' });
});

test('factory 생성 실패에는 생성되지 않은 연결의 종료를 시도하지 않는다', async () => {
  const f = harness({ options: { createStorage() { throw Object.assign(new Error('private-config'), { code: 'USER_STORAGE_CONFIG_INVALID' }); } } });
  assert.equal(await main(args, f.options), 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(f.stderr.join('')), { code: 'USER_STORAGE_CONFIG_INVALID' });
});
