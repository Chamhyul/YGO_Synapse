#!/usr/bin/env node
'use strict';
const { validateTarget } = require('./manage_user_writer.cjs');
const fail = () => Object.assign(new Error('관리자 세션 복구 설정을 확인해 주세요.'), { code: 'USER_STORAGE_INVALID_ARGUMENT' });
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const value = { apply: false, writersDrained: false }, seen = new Set();
  const names = { '--operation': 'operation', '--parent-request': 'parentRequest', '--recovery-request': 'recoveryRequest',
    '--backend': 'backend', '--epoch': 'epoch', '--expected-preview': 'expectedPreview' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; if (seen.has(flag)) throw fail(); seen.add(flag);
    if (flag === '--apply') value.apply = true;
    else if (flag === '--writers-drained') value.writersDrained = true;
    else if (flag === '--writer-production') value.production = true;
    else if (flag === '--writer-emulator') value.emulator = true;
    else if (Object.hasOwn(names, flag)) { const next = args[++i]; if (!next || next.startsWith('--')) throw fail(); value[names[flag]] = next; }
    else throw fail();
  }
  if (!!value.production === !!value.emulator || !['legacy', 'rtdb'].includes(value.backend)
      || !/^[1-9]\d*$/.test(value.epoch || '') || !Number.isSafeInteger(Number(value.epoch))
      || !['operation', 'parentRequest', 'recoveryRequest'].every(k => /^[a-f0-9]{32}$/.test(value[k] || ''))
      || new Set([value.operation, value.parentRequest, value.recoveryRequest]).size !== 3
      || value.expectedPreview !== undefined && !/^[a-f0-9]{64}$/.test(value.expectedPreview)
      || value.apply && (!value.writersDrained || !value.expectedPreview)) throw fail();
  value.epoch = Number(value.epoch); return value;
}
async function main(args = process.argv.slice(2), { env = process.env,
  createRuntime = () => require('../functions/services/userProfileWriterRuntime'),
  stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  let runtime, result, failure;
  try {
    const options = parseArgs(args);
    if (options.help) { stdout('관리자 세션 복구: 기본은 읽기 전용 미리보기입니다.' + '\n--writer-production|--writer-emulator --backend legacy|rtdb --epoch N --operation ID --parent-request ID --recovery-request ID\n적용: --apply --writers-drained --expected-preview SHA256\n공통 writer drain 및 이전 요청·인스턴스·Job·RPC 종료를 먼저 확인해야 합니다. 토큰/권한 재부여·잠금 직접 삭제·이전 재실행·자동 resume를 하지 않습니다. 부분 중단 뒤 같은 복구 ID로 미리보기를 다시 확인합니다.\n'); return 0; }
    const config = validateTarget(options, env); runtime = await createRuntime();
    const binding = runtime.getProfileWriterBinding();
    if (binding.transition.runId !== env.USER_PROFILE_WRITER_RUN_ID
        || options.production && JSON.stringify(config) !== JSON.stringify(binding.claimsStorage?.config)) throw fail();
    const writer = { backend: options.backend, epoch: options.epoch };
    const preview = await binding.transition[options.apply ? 'recoverSession' : 'previewSessionRecovery'](writer, options);
    result = { applied: options.apply, ...preview };
  } catch (error) { failure = error; }
  finally { if (runtime) { try { await runtime.closeProfileWriterRuntime(); } catch (_) { failure ||= fail(); } } }
  if (failure) {
    const code = /^(USER_STORAGE_|WRITER_|SESSION_WRITER_)[A-Z_]+$/.test(failure.code || '') ? failure.code : 'WRITER_SESSION_RECOVERY_FAILED';
    stderr(JSON.stringify({ code }) + '\n'); return code === 'USER_STORAGE_INVALID_ARGUMENT' ? 2 : 1;
  }
  stdout(JSON.stringify(result) + '\n'); return 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, main };
