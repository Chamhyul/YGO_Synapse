'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { prepare, main } = require('./prepare_source_release.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  };
  const bundle = 'bundle', output = 'output', basename = 'ygo-source-prepared-synthetic';
  const sources = ['LICENSE', '.firebaserc', 'firebase.json', 'firestore.rules', 'firestore.indexes.json', 'storage.rules',
    'functions/index.js', 'functions/server.js', 'functions/package.json', 'functions/package-lock.json',
    'functions/config/userStorage.js', 'functions/services/card-service/card.js', 'functions/templates/admin/home.html',
    'scripts/user_writer_job.cjs', 'scripts/manage_user_writer.cjs', 'scripts/reconcile_membership_claims.cjs',
    'operations/user-storage/Dockerfile', 'operations/user-storage/Dockerfile.dockerignore', 'operations/user-storage/database.rules.json',
    'public/index.html', 'public/licenses.html', 'public/vendor/example.js', 'public/vendor/ygo-card-detector.onnx',
    'public/legal/ASSET_RIGHTS.md', 'public/legal/THIRD_PARTY_NOTICES.md', 'public/legal/DEPLOYED_SOURCE.md',
    'public/legal/ygo-source-20260908.tar.gz', 'public/legal/ygo-source-prepared-synthetic.tar.gz',
    'public/legal/ygo-source-prepared-synthetic.sha256', 'public/favicon.png', 'public/favicon.ico',
    'functions/.env.synthetic', 'functions.env.patch.json', 'functions.env.review.json', 'job.env.yaml',
    'target-registration.json', 'runtime-identity.review.json', 'deployment-review.json'];
  const supplements = ['package.json', 'package-lock.json', 'card-service/package.json', 'card-service/manifest.json',
    'card-service/tools/export-compat.cjs', 'card-service/src/card.js', 'scripts/sync-card-service.cjs',
    'scripts/admin_notice_editor.js', 'scripts/build_notice_editor.js', 'scripts/build_license_inventory.js',
    'scripts/prepare_source_release.cjs', 'scripts/manage_card_api_keys.js', 'scripts/upload_membership_csv.js',
    'scripts/cloud_credentials.js', 'scripts/reconcile_inventory_operation.cjs', 'scripts/evaluate_draw2_detector.js',
    'legal/ASSET_RIGHTS.md', 'legal/THIRD_PARTY_NOTICES.md', 'legal/DEPLOYED_SOURCE.md'];
  for (const name of sources) put(`${bundle}/${name}`, '// synthetic source\n');
  for (const name of supplements) put(name, '// synthetic source\n');
  put('card-service/manifest.json', { format: 1, modules: ['card.js'] });
  put(`${bundle}/functions/index.js`, "throw new Error('앱 실행 금지');\nexports.first = () => {};\nexports.second = () => {};\n");
  for (const name of ['ASSET_RIGHTS.md', 'THIRD_PARTY_NOTICES.md', 'DEPLOYED_SOURCE.md']) {
    put(`legal/${name}`, '[전문](../LICENSE) [고지](../public/legal/example.txt)\n');
    put(`${bundle}/public/legal/${name}`, '[전문](AGPL-3.0-only.txt) [고지](example.txt)\n');
  }
  const refresh = () => {
    const files = sources.map(name => {
      const bytes = fs.readFileSync(path.join(root, bundle, name)); return { path: name, sha256: digest(bytes), bytes: bytes.length };
    });
    put(`${bundle}/bundle-manifest.json`, { format: 1, files });
  };
  refresh();
  return { root, bundle, output, basename, sources, put, refresh, args: { root, bundle, output, basename },
    manifest: () => JSON.parse(fs.readFileSync(path.join(root, output, 'SOURCE_MANIFEST.json'), 'utf8')) };
}
function contents(archive, name) { return execFileSync('tar', ['-xOzf', archive, './' + name]); }

test('검토 소스·편집 입력을 보존하고 환경 미조회·다운로드 자기 제외·준비본 상태를 기록한다', async t => {
  const f = fixture(t), read = fs.readFileSync;
  fs.readFileSync = function (filename, ...args) {
    if (typeof filename === 'string' && /\/(?:functions\/\.env\.synthetic|functions\.env\.(?:patch|review)\.json|job\.env\.yaml|target-registration\.json|runtime-identity\.review\.json|deployment-review\.json)$/.test(filename)) {
      throw new Error('제외 환경 내용 조회 금지');
    }
    return read.call(fs, filename, ...args);
  };
  let result;
  try { result = await prepare(f.args); } finally { fs.readFileSync = read; }
  const manifest = f.manifest();
  assert.equal(manifest.sourceState, 'prepared-not-deployed');
  assert.deepEqual(manifest.functionExports.names, ['first', 'second']);
  assert.equal(manifest.baseBundleManifestSha256, digest(fs.readFileSync(path.join(f.root, f.bundle, 'bundle-manifest.json'))));
  assert.equal(JSON.stringify(manifest).includes(f.root), false);
  for (const name of ['functions/index.js', 'public/index.html', 'public/vendor/ygo-card-detector.onnx']) {
    assert.deepEqual(contents(result.archive, name), fs.readFileSync(path.join(f.root, f.bundle, name)));
    assert.equal(manifest.files.find(item => item.path === name).origin, 'bundle');
  }
  for (const name of ['scripts/admin_notice_editor.js', 'card-service/src/card.js', 'scripts/prepare_source_release.cjs', 'scripts/manage_card_api_keys.js']) {
    assert.deepEqual(contents(result.archive, name), fs.readFileSync(path.join(f.root, name)));
    assert.equal(manifest.files.find(item => item.path === name).origin, 'repository');
  }
  assert.deepEqual(JSON.parse(contents(result.archive, 'SOURCE_MANIFEST.json')), manifest);
  const listed = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' });
  assert.equal(/ygo-source[^\n]*\.(?:tar\.gz|sha256)|\.env|favicon/.test(listed), false);
  assert.equal(manifest.excluded.filter(item => item.reason === 'source-download-self-reference').length, 3);
  assert.equal(manifest.excluded.filter(item => item.reason === 'unverified-icon-rights').length, 2);
  assert.equal(manifest.excluded.find(item => item.path === 'functions/.env.synthetic').hashVerified, false);
  assert.equal(manifest.files.some(item => item.path === 'scripts/upload_membership_csv.js'), false);
  assert.deepEqual(manifest.excluded.find(item => item.path === 'scripts/upload_membership_csv.js'), {
    path: 'scripts/upload_membership_csv.js', origin: 'repository', reason: 'private-local-defaults', contentRead: false, hashVerified: false,
  });
  assert.equal(result.remoteAccessPerformed, false); assert.equal(result.deploymentPerformed, false);
});

test('같은 입력은 동일 압축본과 체크섬을 생성하고 기존 출력은 덮어쓰지 않는다', async t => {
  const f = fixture(t), one = await prepare(f.args), before = fs.readFileSync(one.archive);
  const two = await prepare({ ...f.args, output: 'output-two' });
  assert.deepEqual(fs.readFileSync(two.archive), before); assert.equal(two.sha256, one.sha256);
  assert.equal(fs.readFileSync(path.join(f.root, 'output', f.basename + '.sha256'), 'utf8'), `${digest(before)}  ${f.basename}.tar.gz\n`);
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_EXISTS' });
  assert.deepEqual(fs.readFileSync(one.archive), before);
});

test('묶음 해시 변경·목록 밖 파일·모르는 게시 파일을 거부한다', async t => {
  const f = fixture(t); f.put(`${f.bundle}/functions/config/userStorage.js`, '// altered\n');
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_BUNDLE_DRIFT' });
  assert.equal(fs.existsSync(path.join(f.root, f.output)), false);
  f.refresh(); f.put(`${f.bundle}/unexpected.txt`, 'not-listed');
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_UNLISTED_FILE' });
  f.sources.push('unexpected.txt'); f.refresh();
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_UNKNOWN_FILE' });
});

test('심볼릭 링크·경로 탈출·공개 경로의 설정 파일을 거부한다', async t => {
  const f = fixture(t), destination = path.join(f.root, f.bundle, 'public/index.html');
  fs.unlinkSync(destination); fs.symlinkSync(path.join(f.root, 'package.json'), destination);
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_SYMLINK' });
  fs.unlinkSync(destination); f.put(`${f.bundle}/public/index.html`, '// synthetic source\n');
  const m = JSON.parse(fs.readFileSync(path.join(f.root, f.bundle, 'bundle-manifest.json')));
  m.files[0].path = '../outside'; f.put(`${f.bundle}/bundle-manifest.json`, m);
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_PATH' });
  f.sources.push('public/.env'); f.put(`${f.bundle}/public/.env`, 'not-to-read'); f.refresh();
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_EXCLUDED_PATH' });
});

test('비밀값 형태와 오래된 웹 고지를 거부하며 값을 오류에 담지 않는다', async t => {
  const f = fixture(t); const secret = 'ghp_' + 'A'.repeat(36);
  f.put(`${f.bundle}/functions/config/userStorage.js`, `const token = '${secret}';\n`); f.refresh();
  await assert.rejects(prepare(f.args), error => error.code === 'SOURCE_RELEASE_SECRET' && !error.message.includes(secret));
  f.put(`${f.bundle}/functions/config/userStorage.js`, '// synthetic source\n'); f.refresh();
  f.put('legal/DEPLOYED_SOURCE.md', 'changed notice\n');
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_NOTICE_MISMATCH' });
});

test('보충한 카드 원본과 배포 생성본이 다르면 소스 공개를 중단한다', async t => {
  const f = fixture(t); f.put('card-service/src/card.js', '// changed card source\n');
  await assert.rejects(prepare(f.args), { code: 'SOURCE_RELEASE_CARD_SOURCE_MISMATCH' });
});

test('개인 홈 경로는 출력하지 않고 거부하고 제외한 로컬 보조 도구는 읽지 않는다', async t => {
  const f = fixture(t), personal = '/Users/' + 'synthetic-owner' + '/Cloud/example';
  f.put('scripts/upload_membership_csv.js', `const local = ${JSON.stringify(personal)};`);
  await prepare(f.args);
  f.put('scripts/admin_notice_editor.js', `const local = ${JSON.stringify(personal)};`);
  await assert.rejects(prepare({ ...f.args, output: 'unsafe-output' }),
    error => error.code === 'SOURCE_RELEASE_PERSONAL_PATH' && !error.message.includes(personal));
  assert.equal(fs.existsSync(path.join(f.root, 'unsafe-output')), false);
});

test('CLI는 명시한 준비 경로만 받고 앱 실행·운영 옵션을 받지 않는다', async t => {
  const f = fixture(t), out = [], err = [];
  assert.equal(await main(['--help'], { stdout: value => out.push(value) }), 0);
  assert.equal(await main(['--apply'], { stderr: value => err.push(value) }), 2);
  assert.deepEqual(JSON.parse(err[0]), { code: 'SOURCE_RELEASE_ARGUMENT' });
  assert.equal(await main(['--root', f.root, '--bundle', f.bundle, '--output', f.output, '--basename', f.basename],
    { stdout: value => out.push(value), stderr: value => err.push(value) }), 0);
  assert.equal(JSON.parse(out[1]).sourceState, 'prepared-not-deployed');
});
