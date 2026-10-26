'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { stage, main } = require('./stage_user_storage_deployment.cjs');
const { resolveProfileWriterConfig } = require('../functions/config/userProfileWriter');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-bundle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value); };
  const firebase = { functions: [{ source: 'functions', codebase: 'default', ignore: ['**/.env*'] }], hosting: { public: 'public', rewrites: [{ source: '**', destination: '/index.html' }] },
    firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, storage: [{ target: 'main', rules: 'storage.rules' }] };
  const firebaserc = { projects: { default: 'synthetic-project' }, targets: { 'synthetic-project': { storage: { main: ['synthetic-project.firebasestorage.app'] } } } };
  const config = { projectId: 'synthetic-project', storageBucket: 'synthetic-project.firebasestorage.app', targetId: 'user-data', databaseState: 'existing',
    instanceId: 'synthetic-default-rtdb', location: 'asia-southeast1', databaseURL: 'https://synthetic-default-rtdb.asia-southeast1.firebasedatabase.app/', writerRunId: 'a'.repeat(32),
    job: { name: 'synthetic-writer', region: 'asia-northeast3', serviceAccount: 'synthetic-writer@synthetic-project.iam.gserviceaccount.com', image: null, cpu: 2, memory: '1Gi', timeout: '3600s' } };
  const configPath = 'operations/user-storage/local/production.json', output = 'operations/user-storage/local/bundles/review';
  put(configPath, config); put('firebase.json', firebase); put('.firebaserc', firebaserc);
  for (const dir of ['config', 'integrations', 'routes', 'schedules', 'scrapers', 'services', 'tasks', 'utils', 'templates']) put(`functions/${dir}/keep.js`, 'module.exports = {};\n');
  put('functions/config/userStorageTargets.js', "module.exports = { PRODUCTION_TARGETS: [] };\n");
  put('functions/services/card-service/release.json', { version: 1 }); put('functions/templates/admin/test.html', '<p>관리자</p>');
  for (const name of ['functions/package.json', 'functions/package-lock.json', 'firestore.indexes.json']) put(name, {});
  for (const name of ['functions/index.js', 'functions/server.js', 'firestore.rules', 'storage.rules', 'LICENSE',
    'scripts/user_writer_job.cjs', 'scripts/manage_user_writer.cjs', 'scripts/reconcile_membership_claims.cjs', 'scripts/recover_admin_session.cjs',
    'operations/user-storage/Dockerfile', 'operations/user-storage/Dockerfile.dockerignore']) put(name, '// synthetic\n');
  put('operations/user-storage/database.rules.json', { rules: { '.read': false, '.write': false } });
  put('public/index.html', '<p>UI 원본</p>'); put('public/models/example.onnx', Buffer.from([0, 1, 255])); put('public/legal/source.tar.gz', Buffer.from([31, 139, 8]));
  for (const name of ['functions/.secret.local', 'functions/.env', 'functions/serviceAccountKey.json', 'functions/config/synthetic-service-account.json',
    'functions/node_modules/secret.js', 'functions/test/fixture.js', 'public/.env', 'public/private/value.json', 'private/record.md']) put(name, '합성 제외 자료');
  return { root, put, config, configPath, output, firebase, firebaserc, args: { root, configPath, output }, read: name => JSON.parse(fs.readFileSync(path.join(root, output, name), 'utf8')) };
}
test('묶음은 UI·모델·고지·카드 패키지/관리 HTML을 보존하고 시크릿·개발 자료를 복사하지 않는다', t => {
  const f = fixture(t), result = stage(f.args), manifest = f.read('bundle-manifest.json');
  for (const name of ['public/index.html', 'public/models/example.onnx', 'public/legal/source.tar.gz', 'functions/services/card-service/release.json', 'functions/templates/admin/test.html']) {
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.output, name)), fs.readFileSync(path.join(f.root, name)));
  }
  for (const name of ['functions/.secret.local', 'functions/.env', 'functions/serviceAccountKey.json', 'functions/config/synthetic-service-account.json', 'functions/node_modules', 'functions/test', 'public/.env', 'public/private', 'private']) {
    assert.equal(fs.existsSync(path.join(f.root, f.output, name)), false);
  }
  assert.equal(result.readyForDeployment, false); assert.equal(result.remoteExecutionPerformed, false);
  assert.deepEqual(result.needsInput, ['job.image']); assert.equal(manifest.files.some(f => f.path.startsWith('.github/')), false);
});
test('대상·env patch·Job의 같은 run을 준비하되 루트 설정·계정·UI와 원본 운영 목록은 바꾸지 않는다', t => {
  const f = fixture(t); stage(f.args); const bundle = path.join(f.root, f.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'firebase.json'))), f.firebase);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '.firebaserc'))), f.firebaserc);
  assert.deepEqual(require(path.join(f.root, 'functions/config/userStorageTargets.js')).PRODUCTION_TARGETS, []);
  const registry = require(path.join(bundle, 'functions/config/userStorageTargets.js')).PRODUCTION_TARGETS, patch = f.read('functions.env.patch.json');
  assert.equal(registry[0].databaseURL, f.config.databaseURL); assert.equal(registry[0].writerRunId, patch.USER_PROFILE_WRITER_RUN_ID);
  const settings = resolveProfileWriterConfig({ ...patch, GCLOUD_PROJECT: f.config.projectId, CLOUD_RUN_JOB: 'offline-check', CLOUD_RUN_EXECUTION: 'offline-check' }, registry);
  assert.equal(settings.databaseURL, f.config.databaseURL);
  const yaml = fs.readFileSync(path.join(bundle, 'job.env.yaml'), 'utf8'); assert.ok(yaml.includes(JSON.stringify(f.config.writerRunId)));
  assert.equal(Object.hasOwn(patch, 'GCLOUD_PROJECT'), false); assert.equal(fs.existsSync(path.join(bundle, 'functions/.env')), false);
  assert.deepEqual(f.read('firebase.json').hosting, f.firebase.hosting); assert.deepEqual(f.read('firebase.json').functions, f.firebase.functions);
  assert.deepEqual(f.read('.firebaserc').targets[f.config.projectId].storage, f.firebaserc.targets[f.config.projectId].storage);
  const review = f.read('deployment-review.json'); assert.equal(review.readyForDeployment, false);
  assert.equal(review.commands.some(c => c.id === 'create-database'), false);
  assert.equal(review.commands.some(c => c.argv.some(a => a.includes('<reviewedBundle>'))), false);
  assert.equal(f.read('runtime-identity.review.json').job.status, 'candidate-unverified');
});
test('기존 묶음·원본 경로 덮어쓰기와 소스/출력 심볼릭 링크를 거부한다', t => {
  const f = fixture(t); stage(f.args); const before = fs.readFileSync(path.join(f.root, f.output, 'bundle-manifest.json'));
  assert.throws(() => stage(f.args), { code: 'USER_DEPLOYMENT_BUNDLE_EXISTS' });
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.output, 'bundle-manifest.json')), before);
  assert.throws(() => stage({ ...f.args, output: 'functions' }), { code: 'USER_DEPLOYMENT_BUNDLE_PATH' });
  fs.symlinkSync(path.join(f.root, 'public/index.html'), path.join(f.root, 'public/link.html'));
  assert.throws(() => stage({ ...f.args, output: f.output + '-2' }), { code: 'USER_DEPLOYMENT_BUNDLE_SYMLINK' });
  fs.symlinkSync(path.join(f.root, 'nonexistent'), path.join(f.root, 'operations/user-storage/local/bundles/link'));
  assert.throws(() => stage({ ...f.args, output: 'operations/user-storage/local/bundles/link/review' }), { code: 'USER_DEPLOYMENT_BUNDLE_SYMLINK' });
});
test('불완전 대상·공개 Rules·다른 Functions 경로/배포 hook은 묶음 생성 전에 거부한다', t => {
  const f = fixture(t); f.config.writerRunId = null; f.put(f.configPath, f.config);
  assert.throws(() => stage(f.args), { code: 'USER_DEPLOYMENT_BUNDLE_INCOMPLETE' });
  f.config.writerRunId = 'a'.repeat(32); f.put(f.configPath, f.config);
  f.put('operations/user-storage/database.rules.json', { rules: { '.read': true, '.write': true } });
  assert.throws(() => stage(f.args), { code: 'USER_DEPLOYMENT_BUNDLE_RULES' });
  f.put('operations/user-storage/database.rules.json', { rules: { '.read': false, '.write': false } });
  f.firebase.functions[0].predeploy = ['unexpected-command']; f.put('firebase.json', f.firebase);
  assert.throws(() => stage(f.args), { code: 'USER_DEPLOYMENT_BUNDLE_LAYOUT' });
  assert.equal(fs.existsSync(path.join(f.root, f.output)), false);
});
test('CLI는 명시한 로컬 출력만 생성하고 비정상 입력은 원문 없이 보고한다', t => {
  const f = fixture(t), out = [], err = [];
  assert.equal(main(['--config', f.configPath, '--output', f.output], { root: f.root, stdout: v => out.push(v), stderr: v => err.push(v) }), 0);
  assert.equal(JSON.parse(out[0]).remoteExecutionPerformed, false);
  assert.equal(main(['--apply'], { root: f.root, stdout: () => {}, stderr: v => err.push(v) }), 2);
  assert.deepEqual(JSON.parse(err[0]), { code: 'USER_DEPLOYMENT_BUNDLE_ARGUMENT' });
});
test('확인된 앱 환경만 새 묶음에 병합하고 기존 설정·Secret 바인딩을 보존한다', t => {
  const f = fixture(t), environmentPath = 'operations/user-storage/local/environment.json';
  f.put(environmentPath, { projectId: f.config.projectId, environmentVariables: { FEATURE_LABEL: '기존 설정' }, secretNames: ['DISCORD_CLIENT_SECRET'] });
  const out = [];
  assert.equal(main(['--config', f.configPath, '--output', f.output, '--environment', environmentPath],
    { root: f.root, stdout: value => out.push(value), stderr: () => {} }), 0);
  const file = `functions/.env.${f.config.projectId}`, full = path.join(f.root, f.output, file);
  const dotenv = fs.readFileSync(full, 'utf8'), review = f.read('functions.env.review.json');
  assert.ok(dotenv.includes('FEATURE_LABEL=')); assert.ok(dotenv.includes('기존 설정'));
  assert.ok(dotenv.includes(f.config.writerRunId)); assert.ok(!dotenv.includes('DISCORD_CLIENT_SECRET='));
  assert.equal(fs.statSync(full).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.root, file)), false);
  assert.deepEqual(review.preservedKeys, ['FEATURE_LABEL']);
  assert.deepEqual(review.secretBindingNames, ['DISCORD_CLIENT_SECRET']);
  assert.equal(review.secretValuesCopied, false); assert.equal(review.platformVariablesCopied, false);
  assert.equal(f.read('deployment-review.json').environmentMerged, true);
  assert.ok(f.read('bundle-manifest.json').files.some(item => item.path === file));
  assert.ok(!out.join('').includes('기존 설정'));
});
test('다른 프로젝트의 환경이나 Secret 값은 묶음을 생성하기 전에 거부한다', t => {
  const f = fixture(t), environmentPath = 'operations/user-storage/local/environment.json';
  f.put(environmentPath, { projectId: 'other-project', environmentVariables: {}, secretNames: [] });
  assert.throws(() => stage({ ...f.args, environmentPath }), { code: 'USER_DEPLOYMENT_BUNDLE_ENVIRONMENT' });
  f.put(environmentPath, { projectId: f.config.projectId, environmentVariables: { DISCORD_CLIENT_SECRET: 'synthetic-only' }, secretNames: ['DISCORD_CLIENT_SECRET'] });
  assert.throws(() => stage({ ...f.args, environmentPath }));
  assert.equal(fs.existsSync(path.join(f.root, f.output)), false);
});
