#!/usr/bin/env node
'use strict';
// 관리형 Job에서 기존 관리 CLI를 그대로 실행한다. 기본 시작은 도움말뿐이다.
async function main(args = process.argv.slice(2), { load = require, stderr = value => process.stderr.write(value) } = {}) {
  const [tool, ...rest] = args;
  const modules = { writer: './manage_user_writer.cjs', claims: './reconcile_membership_claims.cjs', 'session-recovery': './recover_admin_session.cjs' };
  if (!Object.hasOwn(modules, tool)) { stderr('{"code":"USER_WRITER_JOB_INVALID_ARGUMENT"}\n'); return 2; }
  return load(modules[tool]).main(rest);
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.stderr.write('{"code":"USER_WRITER_JOB_FAILED"}\n'); process.exitCode = 1; });
module.exports = { main };
