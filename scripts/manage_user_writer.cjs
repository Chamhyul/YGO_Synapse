#!/usr/bin/env node
'use strict';
const failure = code => Object.assign(new Error('사용자 writer 관리 설정을 확인해 주세요.'), { code });
const commands = ['status', 'initialize', 'drain', 'resume', 'cancel-prepared', 'copy', 'replay', 'activate', 'recover', 'fence', 'compact', 'plan-cleanup'];
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [command, ...rest] = args;
  if (!commands.includes(command)) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  const options = { command, apply: false, writersDrained: false }, seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!['--writer-production', '--writer-emulator', '--apply', '--writers-drained', '--backend', '--epoch', '--operation', '--before-epoch', '--limit'].includes(flag) || seen.has(flag)) throw failure('USER_STORAGE_INVALID_ARGUMENT');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--writers-drained') options.writersDrained = true;
    else if (flag.startsWith('--writer-')) options[flag === '--writer-production' ? 'production' : 'emulator'] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw failure('USER_STORAGE_INVALID_ARGUMENT'); options[flag.slice(2)] = value; }
  }
  if (!!options.production === !!options.emulator) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  if (['drain', 'resume', 'cancel-prepared', 'copy', 'replay', 'activate', 'plan-cleanup'].includes(command)) {
    if (!['legacy', 'rtdb'].includes(options.backend) || !/^[1-9]\d*$/.test(options.epoch || '') || !Number.isSafeInteger(Number(options.epoch))) throw failure('USER_STORAGE_INVALID_ARGUMENT');
    options.epoch = Number(options.epoch);
  } else if (options.backend || options.epoch) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  if (['resume', 'cancel-prepared', 'recover', 'fence', 'plan-cleanup'].includes(command)) {
    if (!/^[a-f0-9]{32}$/.test(options.operation || '')) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  } else if (options.operation) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  if (command === 'plan-cleanup') {
    if (!/^[1-9]\d*$/.test(options['before-epoch'] || '') || !Number.isSafeInteger(Number(options['before-epoch'])) || Number(options['before-epoch']) > options.epoch) throw failure('USER_STORAGE_INVALID_ARGUMENT');
    options.beforeEpoch = Number(options['before-epoch']); delete options['before-epoch'];
    if (options.limit !== undefined && (!/^[1-9]\d*$/.test(options.limit) || Number(options.limit) > 32)) throw failure('USER_STORAGE_INVALID_ARGUMENT');
    options.limit = Number(options.limit ?? 32);
  } else if (options['before-epoch'] || options.limit !== undefined) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  if (options.writersDrained && !['resume', 'cancel-prepared', 'activate', 'fence', 'plan-cleanup'].includes(command) || options.apply && ['resume', 'cancel-prepared', 'activate', 'fence', 'plan-cleanup'].includes(command) && !options.writersDrained
      || command === 'status' && options.apply) throw failure('USER_STORAGE_INVALID_ARGUMENT');
  return options;
}
function validateTarget(options, env) {
  const config = require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env);
  if (config.mode !== (options.production ? 'production' : 'emulator')) throw failure('USER_STORAGE_CONFIG_INVALID');
  return config;
}
function safeStatus(value) {
  if (!value || !['legacy', 'rtdb'].includes(value.backend) || !['accepting', 'draining'].includes(value.phase)
      || !['epoch', 'unresolved', 'externalUnresolved', 'captured', 'replayed'].every(key => Number.isSafeInteger(value[key]) && value[key] >= (key === 'epoch' ? 1 : 0))
      || typeof value.copying !== 'boolean') throw failure('WRITER_STATE_INVALID');
  return Object.fromEntries(['backend', 'epoch', 'phase', 'unresolved', 'externalUnresolved', 'captured', 'replayed', 'copying'].map(key => [key, value[key]]));
}
function safeCleanup(value) {
  if (!value || !['selected', 'scanned', 'retained'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      || value.selected > 32 || value.retained > value.scanned || typeof value.hasMore !== 'boolean'
      || value.removed !== undefined && (!Number.isSafeInteger(value.removed) || value.removed < 0 || value.removed > value.selected)) throw failure('WRITER_PLAN_CLEANUP_CONFLICT');
  return Object.fromEntries(['selected', 'scanned', 'retained', 'hasMore', ...(value.removed === undefined ? [] : ['removed'])].map(key => [key, value[key]]));
}
async function main(args = process.argv.slice(2), { env = process.env,
  createRuntime = () => require('../functions/services/userProfileWriterRuntime'),
  stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  let runtime, report, caught;
  try {
    const options = parseArgs(args);
    if (options.help) { stdout('공통 writer 관리: status | initialize | drain | resume | cancel-prepared | copy | replay | activate | recover | fence | compact | plan-cleanup\n--writer-production 또는 --writer-emulator로 대상을 명시합니다. 변경은 --apply, 전환 기준은 --backend/--epoch를 요구합니다. resume/cancel-prepared/activate/fence/plan-cleanup 적용은 --writers-drained 확인도 필요합니다.\nresume은 --backend/--epoch/--operation을 요구하며 같은 DB에서 epoch를 올려 원본 쓰기를 재개합니다. 새 재개 요청 ID를 사용하며 이전 업무·전환/복구 Job·RPC 종료 확인과 미확정0이 필요합니다. 같은 ID 재호출은 재개 결과를 재사용합니다.\ncancel-prepared는 개별 제출 전 준비 작업만 취소합니다. executing은 recover/fence로 대조합니다.\nplan-cleanup은 --before-epoch/--operation과 선택 --limit(1~32)을 요구합니다. --apply 없이는 읽기 전용 후보 집계이며 원문/UID를 출력하지 않습니다.\n'); return 0; }
    const config = validateTarget(options, env);
    if (!['status', 'plan-cleanup'].includes(options.command) && !options.apply) { stdout('{"applied":false}\n'); return 0; }
    runtime = await createRuntime(); const binding = runtime.getProfileWriterBinding(), transition = binding.transition;
    if (transition.runId !== env.USER_PROFILE_WRITER_RUN_ID) throw failure('USER_STORAGE_CONFIG_INVALID');
    if (options.production && JSON.stringify(config) !== JSON.stringify(binding.claimsStorage?.config)) throw failure('USER_STORAGE_CONFIG_INVALID');
    const writer = { backend: options.backend, epoch: options.epoch };
    if (options.command === 'plan-cleanup') {
      const optionsForCleanup = { id: options.operation, beforeEpoch: options.beforeEpoch, limit: options.limit, writersDrained: options.writersDrained };
      report = { applied: options.apply, ...safeCleanup(await transition[options.apply ? 'cleanupPlans' : 'previewPlanCleanup'](writer, optionsForCleanup)) };
    }
    else if (options.command === 'resume') await transition.resume(writer, { id: options.operation, writersDrained: options.writersDrained });
    else if (options.command === 'cancel-prepared') await transition.cancelPrepared(writer, options.operation);
    else if (options.command === 'initialize') await transition.initialize();
    else if (['drain', 'copy', 'replay', 'activate'].includes(options.command)) await transition[options.command](writer);
    else if (options.command === 'recover') await transition.recover(options.operation);
    else if (options.command === 'fence') await transition.fenceUncommitted(options.operation);
    else if (options.command === 'compact') await transition.compact();
    if (options.command !== 'plan-cleanup') report = { applied: options.command !== 'status', ...safeStatus(await transition.inspect()) };
  } catch (error) { caught = error; }
  finally { if (runtime) { try { await runtime.closeProfileWriterRuntime(); } catch (_) { caught ||= failure('USER_STORAGE_CLOSE_FAILED'); } } }
  if (caught) {
    const code = /^(USER_STORAGE_|WRITER_)[A-Z_]+$/.test(caught.code || '') ? caught.code : 'USER_STORAGE_MANAGEMENT_FAILED';
    stderr(JSON.stringify({ code }) + '\n'); return code === 'USER_STORAGE_INVALID_ARGUMENT' ? 2 : 1;
  }
  stdout(JSON.stringify(report) + '\n'); return 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = { parseArgs, validateTarget, safeStatus, safeCleanup, main };
