'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepare, main } = require('./prepare_user_storage_deployment.cjs');
const { parseArgs } = require('./manage_user_writer.cjs');
const fixture = () => ({ config: { projectId: 'synthetic-project', storageBucket: 'synthetic-project.firebasestorage.app', targetId: 'user-data',
  instanceId: 'synthetic-users', location: 'asia-southeast1', databaseURL: 'https://synthetic-users.asia-southeast1.firebasedatabase.app/', writerRunId: 'a'.repeat(32),
  job: { name: 'synthetic-writer', region: 'asia-northeast3', serviceAccount: 'synthetic-writer@synthetic-project.iam.gserviceaccount.com',
    image: 'asia-northeast3-docker.pkg.dev/synthetic-project/synthetic/user-writer@sha256:' + 'b'.repeat(64), cpu: 2, memory: '1Gi', timeout: '3600s' } },
  firebase: { functions: [{ source: 'functions', ignore: ['**/.env*'] }], hosting: { site: 'synthetic', rewrites: [{ source: '**', destination: '/index.html' }] }, firestore: { rules: 'firestore.rules' }, storage: [{ target: 'main', rules: 'storage.rules' }] },
  firebaserc: { projects: { default: 'synthetic-project' }, targets: { 'synthetic-project': { storage: { main: ['synthetic-project.firebasestorage.app'] }, database: { retained: ['retained-database'] } } } } });
test('운영 준비는 코드 등록과 같은 설정을 검증하며 SDK나 명령을 실행하지 않는다', () => {
  const f = fixture(), original = structuredClone(f), plan = prepare(f.config, f);
  assert.equal(plan.executionPerformed, false); assert.equal(plan.configurationComplete, true); assert.deepEqual(plan.needsInput, []);
  assert.deepEqual(f, original); assert.deepEqual(require('../functions/config/userStorageTargets').PRODUCTION_TARGETS, []);
  assert.equal(plan.artifacts.targetRegistration.writerRunId, f.config.writerRunId);
});
test('미정 값은 임의 생성/기본 지역 선택 없이 검토 자료의 미확정 목록에 남는다', () => {
  const f = fixture(); f.config.instanceId = null; f.config.databaseURL = null; f.config.writerRunId = null; f.config.job.image = null;
  const plan = prepare(f.config, f); assert.equal(plan.configurationComplete, false);
  assert.deepEqual(plan.needsInput, ['instanceId', 'databaseURL', 'writerRunId', 'job.image']);
  assert.equal(plan.artifacts.functionsEnvPatch.USER_DATABASE_URL, '<databaseURL>');
  assert.equal(plan.commands.find(c => c.id === 'create-database').argv.includes('asia-southeast1'), true);
});
test('이미 생성한 DB는 생성 명령을 내보내지 않으며 실제 확인을 완료로 추정하지 않는다', () => {
  const f = fixture(); f.config.databaseState = 'existing'; const plan = prepare(f.config, f);
  assert.equal(plan.databaseState, 'existing'); assert.equal(plan.commands.some(c => c.id === 'create-database'), false);
  assert.equal(plan.commands.some(c => c.id === 'database-rules'), true); assert.ok(plan.operationalChecksRequired.length);
  f.config.instanceId = null; assert.throws(() => prepare(f.config, f));
  f.config = { ...fixture().config, databaseState: 'verified' }; assert.throws(() => prepare(f.config, f));
});
test('준비 양식의 프로젝트/버킷/URL/run/이미지/미지 필드 오류를 거부한다', () => {
  for (const patch of [{ projectId: 'other-project' }, { storageBucket: 'other.appspot.com' }, { location: 'asia-northeast3' },
    { databaseURL: 'https://synthetic-users.firebaseio.com/' }, { databaseURL: 'https://user:pass@synthetic-users.asia-southeast1.firebasedatabase.app/' },
    { writerRunId: 'bad' }, { secret: 'synthetic-private' }]) { const f = fixture(); assert.throws(() => prepare({ ...f.config, ...patch }, f)); }
  for (const patch of [{ serviceAccount: 'writer@other-project.iam.gserviceaccount.com' }, { image: 'image:latest' }, { image: 'asia-northeast3-docker.pkg.dev/other-project/repo/image@sha256:' + 'b'.repeat(64) }, { cpu: 0 }, { memory: 'unlimited' }, { timeout: '999999s' }]) {
    const f = fixture(); assert.throws(() => prepare({ ...f.config, job: { ...f.config.job, ...patch } }, f));
  }
});
test('기존 Firebase/Hosting/Storage 설정과 다른 대상은 보존하며 활성 설정을 직접 바꾸지 않는다', () => {
  const f = fixture(), plan = prepare(f.config, f);
  for (const key of ['functions', 'hosting', 'firestore', 'storage']) assert.deepEqual(plan.artifacts.firebaseConfig[key], f.firebase[key]);
  assert.deepEqual(plan.artifacts.firebaserc.targets[f.config.projectId].storage, f.firebaserc.targets[f.config.projectId].storage);
  assert.deepEqual(plan.artifacts.firebaserc.targets[f.config.projectId].database.retained, ['retained-database']);
  f.firebase.database = {}; assert.throws(() => prepare(f.config, f)); delete f.firebase.database;
  f.firebaserc.targets[f.config.projectId].database['user-data'] = ['existing']; assert.throws(() => prepare(f.config, f));
});
test('Functions env patch에는 예약된 프로젝트/metadata 키·인증값을 넣지 않는다', () => {
  const f = fixture(), plan = prepare(f.config, f);
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_CONFIG', 'K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB', 'CLOUD_RUN_EXECUTION', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(Object.hasOwn(plan.artifacts.functionsEnvPatch, key), false);
  assert.equal(plan.artifacts.jobEnv.GCLOUD_PROJECT, f.config.projectId); assert.equal(Object.hasOwn(plan.artifacts.jobEnv, 'CLOUD_RUN_JOB'), false);
  assert.equal(plan.commands.some(c => c.argv.includes('--force') || c.argv.includes('--dry-run') || c.argv.includes('--execute-now')), false);
});
test('미완성 설정에서도 인증정보가 들어간 URL을 출력하기 전에 거부한다', () => {
  const f = fixture(); f.config.instanceId = null; f.config.writerRunId = null;
  f.config.databaseURL = 'https://user:synthetic-private@synthetic-users.asia-southeast1.firebasedatabase.app/';
  assert.throws(() => prepare(f.config, f), { code: 'USER_DEPLOYMENT_PLAN_INVALID' });
});
test('출력한 전환/역전환/복구 명령은 실제 CLI 인자 계약과 종료 확인을 따른다', () => {
  const f = fixture(), plan = prepare(f.config, f);
  for (const command of plan.commands.filter(c => c.argv.includes('execute'))) {
    const arg = command.argv.find(a => a.startsWith('--args=')), values = arg.slice(7).split(','); assert.equal(values.shift(), 'writer');
    const options = parseArgs(values.map(v => v === '<observedEpoch>' ? '7' : v === '<observedBackend>' ? 'legacy' : ['<observedOperationId>', '<resumeRequestId>'].includes(v) ? 'c'.repeat(32) : v));
    if (['resume', 'cancel-prepared', 'activate', 'fence'].includes(options.command)) assert.equal(options.writersDrained, true);
    if (command.id.startsWith('rollback')) assert.equal(options.backend, 'rtdb');
    assert.equal(command.argv.includes('--wait'), true);
  }
  const job = plan.commands.find(c => c.id === 'create-job').argv;
  for (const [key, value] of [['--tasks', '1'], ['--parallelism', '1'], ['--max-retries', '0']]) assert.equal(job[job.indexOf(key) + 1], value);
});
test('준비 CLI는 apply/미지 인자를 거부하고 오류 원문·설정값을 출력하지 않는다', () => {
  const out = [], err = [];
  assert.equal(main(['--apply'], { stdout: v => out.push(v), stderr: v => err.push(v) }), 2); assert.deepEqual(out, []);
  assert.deepEqual(JSON.parse(err[0]), { code: 'USER_DEPLOYMENT_PLAN_INVALID' });
  assert.equal(main(['--help'], { stdout: v => out.push(v) }), 0);
});
