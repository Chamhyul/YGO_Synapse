'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { main } = require('./user_writer_job.cjs');
test('Job 기본 도움말과 writer/claims 인자는 기존 CLI에 전달하고 종료 상태를 보존한다', async () => {
  for (const [tool, module] of [['writer', './manage_user_writer.cjs'], ['claims', './reconcile_membership_claims.cjs'], ['session-recovery', './recover_admin_session.cjs']]) {
    let called; const code = await main([tool, '--help'], { load: name => { assert.equal(name, module); return { main: async args => { called = args; return 1; } }; } });
    assert.equal(code, 1); assert.deepEqual(called, ['--help']);
  }
});
test('미지 Job 명령은 CLI/SDK를 로드하기 전에 안전하게 거부한다', async () => {
  const errors = []; assert.equal(await main(['other'], { load: () => assert.fail('실행 금지'), stderr: v => errors.push(v) }), 2);
  assert.deepEqual(JSON.parse(errors[0]), { code: 'USER_WRITER_JOB_INVALID_ARGUMENT' });
});
