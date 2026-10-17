#!/usr/bin/env node
'use strict';
const HELP = `전체 사용자 데이터 이전·대조·롤백 · 합성 demo 에뮬레이터 전용

  node scripts/rehearse_user_migration.cjs --help
  node scripts/rehearse_user_migration.cjs --synthetic --run

--synthetic --run은 새 합성 원본을 생성하고 복사·대조·전환 후 변경·역변환을 리허설합니다.
Firestore·Storage·RTDB·Auth의 명시적 demo 에뮬레이터 설정만 허용합니다.
기존 개발 데이터·운영 연결·실제 사용자 파일은 사용하지 않습니다.
`;
async function main(args = process.argv.slice(2), { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) { stderr('{"code":"MIGRATION_INVALID_ARGUMENT"}\n'); return 2; }
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) { stdout(HELP); return 0; }
  if (args.length !== 2 || new Set(args).size !== 2 || !args.includes('--synthetic') || !args.includes('--run')) {
    stderr('{"code":"MIGRATION_INVALID_ARGUMENT"}\n'); return 2;
  }
  try {
    const { validate } = require('../integration/user-migration/connection.cjs'); validate();
    const result = await require('../integration/user-migration/scenario.cjs').run();
    stdout(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    const safe = new Set(['MIGRATION_CONFIG_INVALID', 'MIGRATION_INVALID_ARGUMENT', 'MIGRATION_INVALID_SNAPSHOT',
      'MIGRATION_INVALID_DEPENDENCIES', 'MIGRATION_INVALID_RUN', 'MIGRATION_RUN_NOT_FOUND', 'MIGRATION_PHASE_CONFLICT',
      'MIGRATION_SOURCE_CHANGED', 'MIGRATION_TARGET_CHANGED', 'MIGRATION_TARGET_CONFLICT', 'MIGRATION_COMPARE_FAILED',
      'MIGRATION_WRITERS_NOT_DRAINED', 'MIGRATION_INVALID_CSV', 'MIGRATION_FIXTURE_LIMIT', 'MIGRATION_RETAINED_CHANGED',
      'MIGRATION_AUTH_WRITE_UNRESOLVED', 'MIGRATION_ORPHAN_CSV_CANDIDATE']);
    const code = safe.has(error?.code) ? error.code : 'MIGRATION_REHEARSAL_FAILED';
    stderr(`${JSON.stringify({ code })}\n`); return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = { main };
