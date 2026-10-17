#!/usr/bin/env node
'use strict';
// 로컬 JSON만 읽고 검토 자료를 stdout으로 출력한다. SDK·인증·프로세스 실행·파일 쓰기는 없다.
const fs = require('node:fs'), path = require('node:path');
const { resolveProfileWriterConfig } = require('../functions/config/userProfileWriter');
const { parseArgs: writerArgs } = require('./manage_user_writer.cjs');
const failure = () => Object.assign(new Error('운영 준비 설정의 필드와 같은 프로젝트 대상을 확인해 주세요.'), { code: 'USER_DEPLOYMENT_PLAN_INVALID' });
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) throw failure();
}
function optional(value, expression) { if (value !== null && (typeof value !== 'string' || !expression.test(value))) throw failure(); }
function prepare(config, { firebase, firebaserc }) {
  fields(config, ['projectId', 'storageBucket', 'targetId', 'instanceId', 'location', 'databaseURL', 'writerRunId', 'job',
    ...(Object.hasOwn(config, 'databaseState') ? ['databaseState'] : [])]);
  const databaseState = config.databaseState ?? 'create';
  if (!['create', 'existing'].includes(databaseState)
      || databaseState === 'existing' && ['instanceId', 'location', 'databaseURL'].some(key => config[key] === null)) throw failure();
  fields(config.job, ['name', 'region', 'serviceAccount', 'image', 'cpu', 'memory', 'timeout']);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId) || config.projectId.startsWith('demo-')
      || config.projectId !== firebaserc?.projects?.default
      || ![`${config.projectId}.firebasestorage.app`, `${config.projectId}.appspot.com`].includes(config.storageBucket)
      || !firebaserc.targets?.[config.projectId]?.storage?.main?.includes(config.storageBucket)
      || !/^[a-z][a-z0-9-]{0,62}$/.test(config.targetId)) throw failure();
  optional(config.instanceId, /^[a-z][a-z0-9-]{0,62}$/);
  optional(config.writerRunId, /^[a-f0-9]{32}$/);
  if (config.location !== null && !['us-central1', 'europe-west1', 'asia-southeast1'].includes(config.location)) throw failure();
  optional(config.databaseURL, /^https:\/\/[^\s\\]+\/$/);
  if (config.databaseURL !== null) {
    let url; try { url = new URL(config.databaseURL); } catch (_) { throw failure(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw failure();
  }
  optional(config.job.serviceAccount, /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
  if (config.job.serviceAccount && !config.job.serviceAccount.endsWith(`@${config.projectId}.iam.gserviceaccount.com`)) throw failure();
  optional(config.job.image, /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/);
  if (config.job.image && config.job.image.split('/')[1] !== config.projectId) throw failure();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.job.name) || !/^[a-z]+-[a-z]+[0-9]$/.test(config.job.region)
      || ![1, 2, 4, 8].includes(config.job.cpu) || !['1Gi', '2Gi', '4Gi', '8Gi'].includes(config.job.memory)
      || !/^\d+s$/.test(config.job.timeout) || Number(config.job.timeout.slice(0, -1)) < 60 || Number(config.job.timeout.slice(0, -1)) > 86400) throw failure();
  if (firebase.database !== undefined || firebaserc.targets?.[config.projectId]?.database?.[config.targetId] !== undefined) throw failure();
  const needsInput = ['instanceId', 'location', 'databaseURL', 'writerRunId'].filter(key => config[key] === null)
    .concat(['serviceAccount', 'image'].filter(key => config.job[key] === null).map(key => `job.${key}`));
  const get = key => config[key] ?? `<${key}>`, target = { id: config.targetId, projectId: config.projectId,
    instanceId: get('instanceId'), location: get('location'), databaseURL: get('databaseURL'), writerRunId: get('writerRunId') };
  // URL은 이름에서 추정해 등록하지 않는다. 항목이 모두 있을 때 기존의 순수 설정 검사를 쓴다.
  const commonEnv = { NODE_ENV: 'production', USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production',
    USER_STORAGE_TARGET: config.targetId, USER_DATABASE_URL: get('databaseURL'), USER_PROFILE_WRITER_MODE: 'production',
    USER_PROFILE_WRITER_RUN_ID: get('writerRunId'), STORAGE_BUCKET: config.storageBucket };
  if (!['instanceId', 'location', 'databaseURL', 'writerRunId'].some(key => config[key] === null)) {
    try { resolveProfileWriterConfig({ ...commonEnv, GCLOUD_PROJECT: config.projectId, CLOUD_RUN_JOB: 'offline-validation', CLOUD_RUN_EXECUTION: 'offline-validation' }, [target]); }
    catch (_) { throw failure(); }
  }
  const preparedFirebase = structuredClone(firebase), preparedRc = structuredClone(firebaserc);
  preparedFirebase.database = [{ target: config.targetId, rules: 'operations/user-storage/database.rules.json' }];
  preparedRc.targets[config.projectId].database = { ...preparedRc.targets[config.projectId].database, [config.targetId]: [get('instanceId')] };
  const jobEnv = { ...commonEnv, GCLOUD_PROJECT: config.projectId };
  const command = (id, kind, argv, requires) => ({ id, kind, requires, argv });
  const execute = args => ['gcloud', 'run', 'jobs', 'execute', config.job.name, '--project', config.projectId,
    '--region', config.job.region, '--wait', `--args=${['writer', ...args].join(',')}`];
  const writer = (action, backend, confirmation = false) => {
    // 실제 epoch는 각 상태 조회에서 얻는다. 검증에는 대체1만 쓰고 출력에는 미확정 표식을 남긴다.
    const args = [action, '--writer-production', '--apply', '--backend', backend, '--epoch', '<observedEpoch>', ...(confirmation ? ['--writers-drained'] : [])];
    writerArgs(args.map(value => value === '<observedEpoch>' ? '1' : value)); return execute(args);
  };
  const commands = [
    ...(databaseState === 'existing' ? [] : [command('create-database', 'cloud-write', ['firebase', 'database:instances:create', get('instanceId'), '--location', get('location'), '--project', config.projectId], ['대상 생성·위치에 대한 별도 승인'])]),
    command('database-rules', 'deploy', ['firebase', 'deploy', '--project', config.projectId, '--config', '<reviewedBundle>/firebase.json', '--only', `database:${config.targetId}`], ['실제 소속/URL 확인', '검토한 Firebase 설정·대상 매핑 준비']),
    command('build-job-image', 'local-build', ['docker', 'build', '--platform', 'linux/amd64', '-f', 'operations/user-storage/Dockerfile', '-t', '<reviewedJobImageTag>', '.'], ['Functions와 동일 검토 소스', '승인된 대상 등록', '실제 env/키/사용자 자료 제외']),
    command('publish-job-image', 'registry-write', ['docker', 'push', '<reviewedJobImageTag>'], ['이미지 게시 승인', '승인된 프로젝트/저장소', '게시 후 digest 확인·job.image에 고정']),
    command('create-job', 'cloud-write', ['gcloud', 'run', 'jobs', 'create', config.job.name, '--project', config.projectId,
      '--region', config.job.region, '--image', config.job.image ?? '<immutableJobImage>', '--service-account', config.job.serviceAccount ?? '<jobServiceAccount>',
      '--env-vars-file', '<reviewedBundle>/job.env.yaml', '--cpu', String(config.job.cpu), '--memory', config.job.memory,
      '--tasks', '1', '--parallelism', '1', '--max-retries', '0', '--task-timeout', config.job.timeout, '--args=writer,--help'], ['같은 검토 소스의 이미지 게시', 'Job/실행 계정/IAM 승인', '이미지 안 대상 등록']),
    command('initialize', 'data-write', execute(['initialize', '--writer-production', '--apply']), ['백업 완료', '동일 run 미초기화 여부 확인', 'Functions 전환 설정 배포 전 실행']),
    command('status', 'cloud-read', execute(['status', '--writer-production']), ['운영 읽기/Job 실행 승인']),
    command('deploy-functions-hosting', 'deploy', ['firebase', 'deploy', '--project', config.projectId, '--config', '<reviewedBundle>/firebase.json', '--only', 'functions,hosting'], ['기존 env/Secret/계정 보존', '초기 상태 legacy/accepting 확인', '등록 소스·env patch 준비', '배포 승인']),
    command('copy', 'data-write', writer('copy', 'legacy'), ['모든 구형·미참여 writer/RPC 종료 확인', '현행 공통 writer만 사용', '원본/대상 백업·대상 공백·epoch 확인']),
    command('replay', 'data-write', writer('replay', 'legacy'), ['같은 transfer/epoch의 복사 완료']),
    command('drain', 'data-write', writer('drain', 'legacy'), ['쓰기 중단 시간/실패 처리 정책 승인']),
    command('resume-source', 'data-write', execute(['resume', '--writer-production', '--apply', '--backend', '<observedBackend>', '--epoch', '<observedEpoch>', '--operation', '<resumeRequestId>', '--writers-drained']), ['drain 상태/현행 backend·epoch 확인', '이전 업무·복사/재생/활성화/복구 Job·RPC 실제 종료', '미확정0', '새 재개 요청 ID·응답 유실에는 같은 ID 재시도']),
    command('cancel-prepared', 'data-write', execute(['cancel-prepared', '--writer-production', '--apply', '--backend', '<observedBackend>', '--epoch', '<observedEpoch>', '--operation', '<observedOperationId>', '--writers-drained']), ['개별 작업이 prepared인지 확인', '해당 원격 요청/Job 실제 종료', '명시 취소 승인·executing은 기존 recover/fence 사용']),
    command('activate', 'data-write', writer('activate', 'legacy', true), ['진행 중 작업·외부 RPC의 실제 종료', 'unresolved/externalUnresolved=0', '최종 재생/대조', '활성화 승인']),
    command('rollback-drain', 'data-write', writer('drain', 'rtdb'), ['현행 backend=rtdb/epoch 조회', '역전환 승인']),
    command('rollback-copy', 'data-write', writer('copy', 'rtdb'), ['비활성 legacy 자료의 보호', '현재 RTDB 변경분 포함', '읽기/쓰기 공통 코드 유지']),
    command('rollback-replay', 'data-write', writer('replay', 'rtdb'), ['같은 역전환 transfer/epoch']),
    command('rollback-activate', 'data-write', writer('activate', 'rtdb', true), ['실제 writer/RPC 종료·미확정0', '원본/대상 최종 대조']),
    command('recover', 'data-write', execute(['recover', '--writer-production', '--apply', '--operation', '<observedOperationId>']), ['작업 ID/현재 상태·영수증 대조']),
    command('fence', 'data-write', execute(['fence', '--writer-production', '--apply', '--operation', '<observedOperationId>', '--writers-drained']), ['원격 요청의 실제 종료', '명시 취소 승인']),
  ];
  return { executionPerformed: false, databaseState, configurationComplete: needsInput.length === 0, needsInput,
    operationalChecksRequired: ['실제 DB 소속/URL·IAM·함수 실행 계정', '전체 원본 백업/크기/대조', '구형 writer/RPC 종료', '쓰기 중단 한도·resume 전 작업/RPC 실제 종료', '실계정 핵심 기능'],
    artifacts: { targetRegistration: target, functionsEnvPatch: commonEnv, jobEnv, firebaseConfig: preparedFirebase, firebaserc: preparedRc }, commands };
}
function main(args = process.argv.slice(2), { root = path.resolve(__dirname, '..'), stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { stdout('오프라인 운영 준비: --config <비밀값 없는 JSON>\nJSON 설정·env patch·검토할 배포/전환 명령만 출력합니다. 파일 쓰기·SDK·인증·명령 실행은 하지 않으며 --apply도 지원하지 않습니다.\n'); return 0; }
    if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw failure();
    const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
    const result = prepare(read(path.resolve(root, args[1])), { firebase: read(path.join(root, 'firebase.json')), firebaserc: read(path.join(root, '.firebaserc')) });
    stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch (_) { stderr('{"code":"USER_DEPLOYMENT_PLAN_INVALID"}\n'); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { prepare, main };
