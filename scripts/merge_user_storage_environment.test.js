'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { mergeEnvironment, writeMergedEnvironment, main } = require('./merge_user_storage_environment.cjs');
// 운영과 동일한 고정 Firebase CLI의 실제 parser를 Docker 이미지 안에서만 사용한다.
const { parseStrict } = require('/usr/local/lib/node_modules/firebase-tools/lib/functions/env.js');
function options(base = {}) {
  return { projectId: 'ygo-synapse', base, secretNames: ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET'], patch: {
    NODE_ENV: 'production', USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production', USER_STORAGE_TARGET: 'user-data',
    USER_DATABASE_URL: 'https://ygo-synapse-default-rtdb.asia-southeast1.firebasedatabase.app/',
    USER_PROFILE_WRITER_MODE: 'production', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32), STORAGE_BUCKET: 'ygo-synapse.firebasestorage.app',
  } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-env-merge-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = 'operations/user-storage/local', input = options({ APP_LABEL: '합성 검토 값' });
  fs.mkdirSync(path.join(root, local), { recursive: true });
  const basePath = `${local}/base.json`, patchPath = `${local}/patch.json`, output = `${local}/merged/.env.ygo-synapse`;
  fs.writeFileSync(path.join(root, basePath), JSON.stringify({ projectId: input.projectId, environmentVariables: input.base, secretNames: input.secretNames }));
  fs.writeFileSync(path.join(root, patchPath), JSON.stringify(input.patch));
  return { root, local, input, basePath, patchPath, output, projectId: input.projectId };
}
test('기존 앱 환경은 보존하고 명시 8키만 갱신하며 검토 결과에 값·해시를 싣지 않는다', () => {
  const input = options({ APP_LABEL: '합성 검토 값', NODE_ENV: 'development', USER_STORAGE_TARGET: 'user-data' }), before = structuredClone(input);
  const result = mergeEnvironment(input);
  assert.deepEqual(parseStrict(result.dotenv), { ...input.base, ...input.patch }); assert.deepEqual(input, before);
  assert.deepEqual(result.summary.preservedKeys, ['APP_LABEL']); assert.deepEqual(result.summary.updatedKeys, ['NODE_ENV']);
  assert.deepEqual(result.summary.unchangedPatchKeys, ['USER_STORAGE_TARGET']); assert.equal(result.summary.addedKeys.length, 6);
  for (const value of ['합성 검토 값', input.patch.USER_DATABASE_URL, input.patch.USER_PROFILE_WRITER_RUN_ID, 'sha256', 'hash']) assert.equal(JSON.stringify(result.summary).includes(value), false);
  const empty = mergeEnvironment(options()); assert.equal(empty.summary.addedKeys.length, 8); assert.deepEqual(empty.summary.preservedKeys, []);
});
test('Firebase dotenv parser에서 공백·개행·따옴표·역슬래시·달러 치환 표기를 그대로 왕복한다', () => {
  const input = options({ APP_LABEL: '  처음\n다음\r줄\t탭\v끝  ', APP_QUOTE: '\'따옴표" #주석 아님', APP_PATH: 'C:\\name\\n\\t\\"\\',
    APP_LITERAL: '${HOME} $APP_LABEL $(printf ignored) `ignored`', APP_EMPTY: '' });
  assert.deepEqual(parseStrict(mergeEnvironment(input).dotenv), { ...input.base, ...input.patch });
});
test('Secret 바인딩·비밀 의심 키와 플랫폼·에뮬레이터·ADC·metadata·카드 서비스 재지정을 거부한다', () => {
  for (const key of ['DISCORD_CLIENT_SECRET', 'CLIENT_TOKEN', 'DB_PASSWORD', 'PRIVATE_KEY', 'APP_CREDENTIAL', 'APP_API_KEY',
    'LOG_EXECUTION_ID', 'GCLOUD_PROJECT', 'FIREBASE_CONFIG', 'X_GOOGLE_TEST', 'EXT_VALUE', 'FUNCTION_TARGET', 'K_SERVICE',
    'CLOUD_RUN_JOB', 'FIRESTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'GCE_METADATA_HOST', 'METADATA_SERVER_DETECTION', 'CARD_SERVICE_URL', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
    assert.throws(() => mergeEnvironment(options({ [key]: '합성 금지 값' })), { code: 'USER_ENV_MERGE_INVALID' });
  }
  const input = options({ PUBLIC_LOOKING_NAME: '합성 금지 값' }); input.secretNames.push('PUBLIC_LOOKING_NAME');
  assert.throws(() => mergeEnvironment(input), { code: 'USER_ENV_MERGE_INVALID' });
  assert.throws(() => mergeEnvironment(options({ APP_LABEL: '-----BEGIN PRIVATE KEY-----' })), { code: 'USER_ENV_MERGE_INVALID' });
});
test('프로젝트·patch 누락/추가·비문자열/제어 문자와 기존 전환 ID·대상 교체는 닫힌 상태로 거부한다', () => {
  for (const mutate of [input => { input.projectId = 'demo-example'; }, input => { delete input.patch.STORAGE_BUCKET; },
    input => { input.patch.EXTRA = 'value'; }, input => { input.patch.STORAGE_BUCKET = 'other-project.appspot.com'; },
    input => { input.patch.USER_DATABASE_URL = 'http://localhost:9000/'; }, input => { input.patch.NODE_ENV = 'test'; },
    input => { input.base.APP_LABEL = null; }, input => { input.base.APP_LABEL = 'bad\u0000value'; },
    input => { input.secretNames.push(input.secretNames[0]); }]) {
    const input = options(); mutate(input); assert.throws(() => mergeEnvironment(input), { code: 'USER_ENV_MERGE_INVALID' });
  }
  assert.throws(() => mergeEnvironment(options({ USER_PROFILE_WRITER_RUN_ID: 'b'.repeat(32) })), { code: 'USER_ENV_MERGE_ACTIVE_TRANSITION' });
  assert.throws(() => mergeEnvironment(options({ USER_PROFILE_WRITER_MODE: 'production', USER_STORAGE_TARGET: 'other' })), { code: 'USER_ENV_MERGE_ACTIVE_TRANSITION' });
});
test('CLI 병합은 local의 새 0600 파일에만 저장하고 원본 JSON·dotenv를 보존한다', t => {
  const f = fixture(t), outputs = [], errors = [], before = fs.readFileSync(path.join(f.root, f.basePath));
  fs.mkdirSync(path.join(f.root, 'functions')); fs.writeFileSync(path.join(f.root, 'functions/.env'), '원본 그대로');
  const code = main(['--base', f.basePath, '--patch', f.patchPath, '--project', f.projectId, '--output', f.output],
    { root: f.root, stdout: value => outputs.push(value), stderr: value => errors.push(value) });
  assert.equal(code, 0); assert.deepEqual(errors, []); assert.equal(outputs.join('').includes('합성 검토 값'), false);
  assert.equal(fs.statSync(path.join(f.root, f.output)).mode & 0o777, 0o600);
  assert.deepEqual(parseStrict(fs.readFileSync(path.join(f.root, f.output), 'utf8')), { ...f.input.base, ...f.input.patch });
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.basePath)), before); assert.equal(fs.readFileSync(path.join(f.root, 'functions/.env'), 'utf8'), '원본 그대로');
});
test('기존 파일 덮어쓰기·local 외부·입력 dotenv·입출력 symlink를 거부한다', t => {
  const f = fixture(t); writeMergedEnvironment(f);
  assert.throws(() => writeMergedEnvironment(f), { code: 'USER_ENV_MERGE_EXISTS' });
  for (const output of ['functions/.env', `${f.local}/../.env`, path.join(f.root, f.local, 'absolute')]) {
    assert.throws(() => writeMergedEnvironment({ ...f, output }), { code: 'USER_ENV_MERGE_PATH' });
  }
  const output = `${f.local}/another.env`;
  assert.throws(() => writeMergedEnvironment({ ...f, output, basePath: `${f.local}/.secret.local` }), { code: 'USER_ENV_MERGE_PATH' });
  fs.symlinkSync(path.join(f.root, f.basePath), path.join(f.root, f.local, 'link.json'));
  assert.throws(() => writeMergedEnvironment({ ...f, output, basePath: `${f.local}/link.json` }), { code: 'USER_ENV_MERGE_SYMLINK' });
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.root, f.local, 'dangling'));
  assert.throws(() => writeMergedEnvironment({ ...f, output: `${f.local}/dangling/.env` }), { code: 'USER_ENV_MERGE_SYMLINK' });
});
test('CLI는 프로젝트 불일치·손상 JSON·apply에서 값 없는 오류만 보고한다', t => {
  const f = fixture(t), output = [], errors = [], io = { root: f.root, stdout: value => output.push(value), stderr: value => errors.push(value) };
  const args = ['--base', f.basePath, '--patch', f.patchPath, '--project', 'other-project', '--output', f.output];
  assert.equal(main(args, io), 2); assert.equal(fs.existsSync(path.join(f.root, f.output)), false);
  fs.writeFileSync(path.join(f.root, f.basePath), '{합성 비공개 원문'); args[5] = f.projectId;
  assert.equal(main(args, io), 2); assert.equal(main(['--apply'], io), 2);
  assert.deepEqual(output, []); assert.equal(errors.join('').includes('합성 비공개 원문'), false);
  assert.deepEqual(errors.map(value => Object.keys(JSON.parse(value))), [['code'], ['code'], ['code']]);
});
