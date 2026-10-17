'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('./rehearse_user_migration.cjs');
test('도움말과 기본 실행은 SDK와 데이터 생성 없이 사용법만 출력한다', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    let text = '';
    assert.equal(await main(args, { stdout: value => { text += value; }, stderr: () => assert.fail() }), 0);
    assert.match(text, /--synthetic --run/);
  }
});
test('실제 UID/파일/운영 대상 인자와 합성 확인 없는 실행은 내용을 노출하지 않고 거부한다', async () => {
  for (const args of [['--run'], ['--synthetic'], ['--synthetic', '--run', '--uid', 'private-user'],
    ['--synthetic', '--synthetic'], ['--production', '--run'], ['--file', 'private-path'], null, [7]]) {
    let text;
    assert.equal(await main(args, { stdout: () => assert.fail(), stderr: value => { text = value; } }), 2);
    assert.deepEqual(JSON.parse(text), { code: 'MIGRATION_INVALID_ARGUMENT' });
  }
});
test('에뮬레이터 없는 일반 환경에서는 합성 실행도 운영 연결 전에 거부한다', async () => {
  let text;
  assert.equal(await main(['--synthetic', '--run'], { stdout: () => assert.fail(), stderr: value => { text = value; } }), 1);
  assert.deepEqual(JSON.parse(text), { code: 'MIGRATION_REHEARSAL_FAILED' });
});
