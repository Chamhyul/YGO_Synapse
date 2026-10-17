#!/usr/bin/env node
'use strict';

const { resolveRtdbConfig } = require('../functions/config/userStorage');
const HELP = `인벤토리 저장 결과 대조 · demo RTDB 에뮬레이터 전용

사용법:
  node scripts/reconcile_inventory_operation.cjs --uid <시험 UID> --operation <32자리 작업 ID>
  node scripts/reconcile_inventory_operation.cjs --uid <시험 UID> --operation <32자리 작업 ID> --recover
  node scripts/reconcile_inventory_operation.cjs --uid <시험 UID> --operation <32자리 작업 ID> --recover --cancel-pending

기본 실행은 기록을 읽어 대조만 합니다. --recover는 확정 결과를 보관하고 남은 정리를 수행합니다.
진행 중인 작업은 기본 보존하며 --cancel-pending을 명시해야 취소 경계를 기록합니다.
Docker의 격리된 test/rtdb · demo 프로젝트 설정에서만 실행할 수 있습니다.
`;
const SAFE_CODES = new Set([
  'USER_STORAGE_INVALID_ARGUMENT', 'USER_STORAGE_CONFIG_INVALID', 'USER_STORAGE_INVALID_CONFIG',
  'USER_STORAGE_INVALID_OPERATION', 'USER_STORAGE_OPERATION_NOT_FOUND', 'USER_STORAGE_OPERATION_CANCELLED',
  'USER_STORAGE_INVALID_PATH', 'USER_STORAGE_INVALID_RECORD', 'USER_STORAGE_INVALID_REVISION',
  'USER_STORAGE_UNSUPPORTED_FORMAT', 'USER_STORAGE_CONFLICT', 'USER_STORAGE_REVISION_EXHAUSTED',
  'USER_STORAGE_READ_TIMEOUT', 'USER_STORAGE_QUEUE_TIMEOUT', 'USER_STORAGE_WRITE_AMBIGUOUS',
  'USER_STORAGE_CLEANUP_TIMEOUT', 'USER_STORAGE_CONNECTION_CLOSED',
  'USER_STORAGE_INVALID_RECOVERY_REPORT', 'USER_STORAGE_CLOSE_FAILED',
]);
const error = code => Object.assign(new Error(code), { code });

function parseArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw error('USER_STORAGE_INVALID_ARGUMENT');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const result = { recover: false, cancelPending: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--uid', '--operation', '--recover', '--cancel-pending'].includes(flag) || seen.has(flag)) {
      throw error('USER_STORAGE_INVALID_ARGUMENT');
    }
    seen.add(flag);
    if (flag === '--recover') result.recover = true;
    else if (flag === '--cancel-pending') result.cancelPending = true;
    else {
      const value = args[++i];
      if (typeof value !== 'string' || value.startsWith('--')) throw error('USER_STORAGE_INVALID_ARGUMENT');
      result[flag === '--uid' ? 'uid' : 'operationId'] = value;
    }
  }
  if (typeof result.uid !== 'string' || !result.uid.trim() || result.uid.length > 128
      || /[\u0000-\u001f\u007f]/.test(result.uid)
      || Buffer.from(result.uid, 'utf8').toString('utf8') !== result.uid
      || typeof result.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(result.operationId)
      || (result.cancelPending && !result.recover)) throw error('USER_STORAGE_INVALID_ARGUMENT');
  return result;
}

// SDK 반환 객체를 그대로 출력하지 않는다. 카드·UID·경로·자격증명은 보고서에 포함하지 않는다.
function safeReport(value, operationId) {
  if (!value || typeof value !== 'object' || value.operationId !== operationId
      || !['prepared', 'ready', 'committed', 'cancelled'].includes(value.status)
      || !['pending', 'complete', 'fenced'].includes(value.cleanup)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
      || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 1))
      || (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0))) {
    throw error('USER_STORAGE_INVALID_RECOVERY_REPORT');
  }
  return { operationId, status: value.status, cleanup: value.cleanup, expectedRevision: value.expectedRevision,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.generation === undefined ? {} : { generation: value.generation }) };
}

async function main(args = process.argv.slice(2), {
  env = process.env,
  createStorage = () => require('../functions/services/user-storage').createEmulatorUserStorage(),
  stdout = value => process.stdout.write(value),
  stderr = value => process.stderr.write(value),
} = {}) {
  let storage, report, caught;
  try {
    const options = parseArgs(args);
    if (options.help) { stdout(HELP); return 0; }
    // 설정 검증 전 SDK를 불러오거나 연결을 만들지 않는다. 실제 factory도 같은 보호를 재확인한다.
    resolveRtdbConfig(env);
    storage = await createStorage();
    const result = options.recover
      ? await storage.inventory.recoverOperation(options.uid, options.operationId, { cancelPending: options.cancelPending })
      : await storage.inventory.inspectOperation(options.uid, options.operationId);
    report = safeReport(result, options.operationId);
  } catch (failure) { caught = failure; }
  finally {
    if (storage) {
      try { await storage.close(); }
      catch { if (!caught) caught = error('USER_STORAGE_CLOSE_FAILED'); }
    }
  }
  if (caught) {
    const code = SAFE_CODES.has(caught?.code) ? caught.code : 'USER_STORAGE_RECOVERY_FAILED';
    stderr(`${JSON.stringify({ code })}\n`);
    return code === 'USER_STORAGE_INVALID_ARGUMENT' ? 2 : 1;
  }
  stdout(`${JSON.stringify(report)}\n`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, () => {
    process.stderr.write('{"code":"USER_STORAGE_RECOVERY_FAILED"}\n');
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, safeReport };
