#!/usr/bin/env node
'use strict';
const { resolveRtdbConfig, sameConnectionConfig } = require('../functions/config/userStorage');
const HELP = `멤버십 claims 대조·복구 · demo RTDB/Auth 에뮬레이터 전용

사용법:
  node scripts/reconcile_membership_claims.cjs --uid <시험 UID>
  node scripts/reconcile_membership_claims.cjs --uid <시험 UID> --operation <32자리 작업 ID> --recover --writers-drained

기본은 읽기 전용 대조입니다. --recover는 멤버십 요약만 복구하고 현재 관리자 권한은 보존합니다.
--writers-drained는 이전 앱/복구 writer와 그 Auth 요청이 모두 종료됐음을 실행자가 확인했다는 의미입니다.
단순 시간 경과·잠금 상태·Auth 값 일치만으로 종료를 확인할 수 없습니다.
공통 writer 시험 모드에서는 지정 run을 대조하며 복구에 해당 run의 drain 상태도 필요합니다.
등록된 관리형 서버의 공통 운영 연결은 --writer-production을 명시합니다.
기본 실행은 demo 전용이며 자동 잠금 해제는 지원하지 않습니다.
`;
const failure = code => Object.assign(new Error('멤버십 동기화 상태를 확인하지 못했습니다.'), { code });
const SAFE_CODES = new Set(['USER_STORAGE_CONFIG_INVALID', 'USER_STORAGE_INVALID_ARGUMENT',
  'USER_STORAGE_WRITE_AMBIGUOUS', 'USER_STORAGE_CONFLICT', 'USER_STORAGE_READ_TIMEOUT',
  'USER_STORAGE_CONNECTION_CLOSED', 'USER_STORAGE_INVALID_RECORD', 'USER_STORAGE_UNSUPPORTED_FORMAT',
  'MEMBERSHIP_CLAIMS_RECOVERY_CONFIRMATION_REQUIRED', 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT',
  'MEMBERSHIP_CLAIMS_INVALID_RECORD', 'MEMBERSHIP_CLAIMS_READBACK_MISMATCH', 'MEMBERSHIP_CLAIMS_SOURCE_CHANGED',
  'WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED', 'WRITER_NOT_INITIALIZED', 'WRITER_OUTCOME_UNRESOLVED',
  'MEMBERSHIP_CLAIMS_TOO_LARGE', 'MEMBERSHIP_CLAIMS_TIMEOUT', 'MEMBERSHIP_CLAIMS_BUSY']);
function parseArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = { recover: false, writersDrained: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--uid', '--operation', '--recover', '--writers-drained', '--writer-production'].includes(flag) || seen.has(flag)) throw failure('USER_STORAGE_INVALID_ARGUMENT');
    seen.add(flag);
    if (flag === '--writer-production') options.writerProduction = true;
    else if (flag === '--recover') options.recover = true;
    else if (flag === '--writers-drained') options.writersDrained = true;
    else { options[flag === '--uid' ? 'uid' : 'operationId'] = args[++i]; }
  }
  if (typeof options.uid !== 'string' || !options.uid.trim() || options.uid.startsWith('--') || options.uid.length > 128
      || /[\u0000-\u001f\u007f]/.test(options.uid) || Buffer.from(options.uid).toString() !== options.uid
      || (options.operationId !== undefined && (typeof options.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(options.operationId)))
      || (options.recover && (!options.operationId || !options.writersDrained))
      || (!options.recover && (options.operationId || options.writersDrained))) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  return options;
}
function resolveTestConfig(env, options = {}) {
  if (options.writerProduction) {
    const config = require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env);
    if (config.mode !== 'production') throw failure('USER_STORAGE_CONFIG_INVALID'); return config;
  }
  const config = env.USER_PROFILE_WRITER_MODE ? require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env) : resolveRtdbConfig(env);
  if (config.mode !== 'emulator') throw failure('USER_STORAGE_CONFIG_INVALID');
  const host = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\]|emulators):[1-9][0-9]{0,4}$/.test(host)
      || Number(host.slice(host.lastIndexOf(':') + 1)) > 65535
      || host.slice(0, host.lastIndexOf(':')) !== config.emulatorHost.slice(0, config.emulatorHost.lastIndexOf(':'))
      || ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_CONFIG'].some(key => env[key])) {
    throw failure('USER_STORAGE_CONFIG_INVALID');
  }
  return { ...config, authEmulatorHost: host };
}
function createTestAuth(config) {
  if (config.mode === 'production') {
    const binding = require('../functions/services/userWriterSelection').selectProductionWriter();
    if (!sameConnectionConfig(config, binding.claimsStorage.config)) throw failure('USER_STORAGE_CONFIG_INVALID');
    return { auth: binding.auth, close: async () => {} };
  }
  // 실제 환경을 다시 확인한다. SDK 로딩·앱 생성 전 주소와 demo 프로젝트를 고정한다.
  const current = resolveTestConfig(process.env);
  if (!sameConnectionConfig(config, current) || config.authEmulatorHost !== current.authEmulatorHost) throw failure('USER_STORAGE_CONFIG_INVALID');
  const requireFromFunctions = require('node:module').createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
  const { initializeApp, deleteApp } = requireFromFunctions('firebase-admin/app');
  const { getAuth } = requireFromFunctions('firebase-admin/auth');
  const { randomUUID } = require('node:crypto');
  const app = initializeApp({ projectId: config.projectId,
    credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, `claims-recovery-test-${randomUUID()}`);
  try { return { auth: getAuth(app), close: () => deleteApp(app) }; }
  catch (error) { deleteApp(app).catch(() => {}); throw error; }
}
function safeReport(result, recovered) {
  if (!result || !['absent', 'idle', 'running', 'uncertain'].includes(result.state)
      || typeof result.stable !== 'boolean' || typeof result.matches !== 'boolean'
      || typeof result.version !== 'string' || !/^(0|[a-f0-9]{64})$/.test(result.version)
      || (result.operationId !== undefined && !/^[a-f0-9]{32}$/.test(result.operationId))
      || (result.recoveryOf !== undefined && !/^[a-f0-9]{32}$/.test(result.recoveryOf))) throw failure('MEMBERSHIP_CLAIMS_INVALID_REPORT');
  const writer = result.writer;
  if (writer && (!['legacy', 'rtdb'].includes(writer.backend) || !['accepting', 'draining'].includes(writer.phase)
      || !Number.isSafeInteger(writer.epoch) || writer.epoch < 1 || !Number.isSafeInteger(writer.unresolved) || writer.unresolved < 0)) throw failure('MEMBERSHIP_CLAIMS_INVALID_REPORT');
  return { state: result.state, stable: result.stable, matches: result.matches, version: result.version,
    ...(result.operationId ? { operationId: result.operationId } : {}),
    ...(result.recoveryOf ? { recoveryOf: result.recoveryOf } : {}), recovered,
    ...(writer ? { writer: { backend: writer.backend, epoch: writer.epoch, phase: writer.phase, unresolved: writer.unresolved } } : {}) };
}
async function main(args = process.argv.slice(2), {
  env = process.env, createStorage = async () => {
    if (!env.USER_PROFILE_WRITER_MODE) return require('../functions/services/user-storage').createEmulatorUserStorage();
    const runtime = require('../functions/services/userProfileWriterRuntime'), binding = runtime.getProfileWriterBinding();
    // 기본 대조는 이미 존재하는 run만 읽는다. 새 전환 기록을 만들지 않는다.
    await binding.transition.route();
    return { ...binding.claimsStorage, close: runtime.closeProfileWriterRuntime };
  },
  createAuth = createTestAuth, stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value),
} = {}) {
  let storage, authHandle, caught, report;
  try {
    const options = parseArgs(args);
    if (options.help) { stdout(HELP); return 0; }
    const config = resolveTestConfig(env, options);
    storage = await createStorage();
    if (!sameConnectionConfig(config, storage.config)) throw failure('USER_STORAGE_CONFIG_INVALID');
    authHandle = await createAuth(config);
    const { inspectMembershipClaims, recoverMembershipClaims } = require('../functions/services/membershipClaims');
    const dependencies = { env, storage, auth: authHandle.auth, allowEmulator: config.mode === 'emulator' };
    if (options.recover) await recoverMembershipClaims(options.uid, options.operationId, { ...dependencies, writersDrained: true });
    report = safeReport(await inspectMembershipClaims(options.uid, dependencies), options.recover);
  } catch (error) { caught = error; }
  finally {
    for (const handle of [authHandle, storage]) if (handle) {
      try { await handle.close(); } catch { caught ||= failure('MEMBERSHIP_CLAIMS_CLOSE_FAILED'); }
    }
  }
  if (caught) {
    const code = SAFE_CODES.has(caught.code) ? caught.code : 'MEMBERSHIP_CLAIMS_RECOVERY_FAILED';
    stderr(`${JSON.stringify({ code })}\n`); return code === 'USER_STORAGE_INVALID_ARGUMENT' ? 2 : 1;
  }
  stdout(`${JSON.stringify(report)}\n`); return 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = { parseArgs, resolveTestConfig, safeReport, main };
