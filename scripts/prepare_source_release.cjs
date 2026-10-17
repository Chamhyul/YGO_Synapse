#!/usr/bin/env node
'use strict';
// 명시한 로컬 검토 묶음의 공개 소스만 준비한다. 앱·SDK·인증·네트워크를 실행하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FUNCTION_DIRS = new Set(['config', 'integrations', 'routes', 'schedules', 'scrapers', 'services', 'tasks', 'utils', 'templates']);
const BUNDLE_FILES = new Set(['LICENSE', '.firebaserc', 'firebase.json', 'firestore.rules', 'firestore.indexes.json', 'storage.rules',
  'functions/index.js', 'functions/server.js', 'functions/package.json', 'functions/package-lock.json',
  'scripts/user_writer_job.cjs', 'scripts/manage_user_writer.cjs', 'scripts/reconcile_membership_claims.cjs',
  'operations/user-storage/Dockerfile', 'operations/user-storage/Dockerfile.dockerignore', 'operations/user-storage/database.rules.json']);
const OPERATOR_FILES = new Set(['functions.env.patch.json', 'functions.env.review.json', 'job.env.yaml',
  'target-registration.json', 'runtime-identity.review.json', 'deployment-review.json']);
const VENDOR_BINARIES = new Set(['public/vendor/ygo-card-detector.onnx', 'public/vendor/ort-wasm-simd-threaded.wasm',
  'public/vendor/ort-wasm-simd-threaded.jsep.wasm']);
const SUPPLEMENTS = ['package.json', 'package-lock.json', 'card-service/package.json', 'card-service/manifest.json',
  'card-service/tools/export-compat.cjs', 'scripts/sync-card-service.cjs', 'scripts/admin_notice_editor.js',
  'scripts/build_notice_editor.js', 'scripts/build_license_inventory.js', 'scripts/prepare_source_release.cjs',
  'scripts/manage_card_api_keys.js', 'scripts/cloud_credentials.js',
  'scripts/reconcile_inventory_operation.cjs', 'scripts/evaluate_draw2_detector.js',
  'legal/ASSET_RIGHTS.md', 'legal/THIRD_PARTY_NOTICES.md', 'legal/DEPLOYED_SOURCE.md'];
const fail = code => Object.assign(new Error('공개 소스 준비의 입력·해시·제외 범위를 확인해 주세요.'), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

function relativeName(name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || /[\\\u0000-\u001f\u007f]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) throw fail('SOURCE_RELEASE_PATH');
  return name;
}
function checkAncestors(filename) {
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw fail('SOURCE_RELEASE_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function regularFile(root, name) {
  const filename = path.join(root, relativeName(name));
  checkAncestors(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail('SOURCE_RELEASE_FILE');
  return filename;
}
function listFiles(root, prefix = '') {
  const directory = prefix ? path.join(root, relativeName(prefix)) : root;
  checkAncestors(directory);
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = relativeName(prefix ? `${prefix}/${item.name}` : item.name);
    if (item.isSymbolicLink()) throw fail('SOURCE_RELEASE_SYMLINK');
    if (item.isDirectory()) result.push(...listFiles(root, name));
    else if (item.isFile()) result.push(name);
    else throw fail('SOURCE_RELEASE_FILE');
  }
  return result;
}
function classification(name) {
  relativeName(name);
  // 환경 내용은 읽거나 해시하지 않는다. manifest의 제외 경로만 기록한다.
  if (/^functions\/\.env(?:\.[^/]*)?$/.test(name)) return { reason: 'runtime-environment-not-read', read: false };
  if (OPERATOR_FILES.has(name)) return { reason: 'operator-configuration-not-read', read: false };
  const parts = name.split('/'), leaf = parts.at(-1);
  if (parts.some(part => ['private', 'docs', '.git', 'node_modules', 'test', 'tests', '.firebase', 'previews', 'data'].includes(part.toLowerCase()))
      || parts.some(part => /^(?:\.env|\.secret|gha-creds-)/i.test(part))
      || /service[-_]?account.*\.json$/i.test(leaf) || /\.(?:pem|p12|key|log)$/i.test(leaf)) throw fail('SOURCE_RELEASE_EXCLUDED_PATH');
  if (/^public\/legal\/ygo-source[^/]*\.(?:tar\.gz|sha256)$/.test(name)) return { reason: 'source-download-self-reference', read: true };
  if (name.startsWith('public/') && /\.(?:png|ico)$/i.test(leaf)) return { reason: 'unverified-icon-rights', read: true };
  if (BUNDLE_FILES.has(name)) return { include: true };
  if (parts[0] === 'functions' && FUNCTION_DIRS.has(parts[1]) && /\.(?:js|json|html)$/.test(leaf)) return { include: true };
  if (name.startsWith('public/') && (/\.(?:html|css|js|mjs|json|md|txt|xml|svg|webmanifest)$/.test(leaf) || VENDOR_BINARIES.has(name))) return { include: true };
  throw fail('SOURCE_RELEASE_UNKNOWN_FILE');
}
function scan(bytes) {
  // 실제 값 형태만 검사한다. 검사 코드 안의 정규식 설명을 값으로 간주하지 않는다.
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)
      || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|ya29\.[A-Za-z0-9_-]{40,}|GOCSPX-[A-Za-z0-9_-]{15,}|AKIA[0-9A-Z]{16})\b/.test(text)
      || /["']type["']\s*:\s*["']service_account["']/.test(text)
      || /["']private_key["']\s*:\s*["'][^"']+/.test(text)) throw fail('SOURCE_RELEASE_SECRET');
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)
      || /[A-Za-z]:\\Users\\[^\\\s]+\\/.test(text)) throw fail('SOURCE_RELEASE_PERSONAL_PATH');
}
function under(parent, child) { return child === parent || child.startsWith(parent + path.sep); }

async function prepare({ root, bundle, output, basename }) {
  if (![root, bundle, output, basename].every(value => typeof value === 'string' && value)
      || !/^ygo-source-prepared-[a-zA-Z0-9][a-zA-Z0-9-]{0,70}$/.test(basename)) throw fail('SOURCE_RELEASE_ARGUMENT');
  root = path.resolve(root); bundle = path.resolve(root, bundle); output = path.resolve(root, output);
  for (const value of [root, bundle, output]) checkAncestors(value);
  if (!fs.statSync(root).isDirectory() || !fs.statSync(bundle).isDirectory()
      || under(output, root) || under(bundle, output) || under(output, bundle)) throw fail('SOURCE_RELEASE_PATH');
  if (fs.existsSync(output)) throw fail('SOURCE_RELEASE_EXISTS');
  const manifestBytes = fs.readFileSync(regularFile(bundle, 'bundle-manifest.json'));
  if (manifestBytes.length > 4 * 1024 * 1024) throw fail('SOURCE_RELEASE_MANIFEST');
  let base;
  try { base = JSON.parse(manifestBytes); } catch (_) { throw fail('SOURCE_RELEASE_MANIFEST'); }
  if (base?.format !== 1 || !Array.isArray(base.files) || !base.files.length) throw fail('SOURCE_RELEASE_MANIFEST');
  const declared = new Map();
  for (const entry of base.files) {
    const name = relativeName(entry.path);
    if (name === 'bundle-manifest.json' || declared.has(name) || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) throw fail('SOURCE_RELEASE_MANIFEST');
    declared.set(name, entry);
  }
  const actual = listFiles(bundle);
  if (actual.length !== declared.size + 1 || actual.some(name => name !== 'bundle-manifest.json' && !declared.has(name))) throw fail('SOURCE_RELEASE_UNLISTED_FILE');
  for (const required of BUNDLE_FILES) if (!declared.has(required)) throw fail('SOURCE_RELEASE_MANIFEST');
  for (const name of ['public/index.html', 'public/licenses.html', 'public/legal/ASSET_RIGHTS.md', 'public/legal/THIRD_PARTY_NOTICES.md', 'public/legal/DEPLOYED_SOURCE.md']) {
    if (!declared.has(name)) throw fail('SOURCE_RELEASE_MANIFEST');
  }
  const selections = [], exclusions = [{ path: 'scripts/upload_membership_csv.js', origin: 'repository',
    reason: 'private-local-defaults', contentRead: false, hashVerified: false }], verified = [];
  for (const [name, entry] of [...declared].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const policy = classification(name), filename = regularFile(bundle, name);
    if (policy.read !== false) {
      const bytes = fs.readFileSync(filename);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw fail('SOURCE_RELEASE_BUNDLE_DRIFT');
      verified.push({ filename, sha256: entry.sha256 });
      if (policy.include) { scan(bytes); selections.push({ path: name, filename, origin: 'bundle', sha256: entry.sha256, bytes: bytes.length }); }
    }
    if (!policy.include) exclusions.push({ path: name, origin: 'bundle', reason: policy.reason, contentRead: policy.read !== false, hashVerified: policy.read !== false });
  }
  const supplementNames = [...SUPPLEMENTS, ...listFiles(root, 'card-service/src')];
  if (!supplementNames.some(name => name.startsWith('card-service/src/'))) throw fail('SOURCE_RELEASE_SUPPLEMENT');
  for (const name of supplementNames.sort()) {
    if (declared.has(name) || selections.some(item => item.path === name)) throw fail('SOURCE_RELEASE_SUPPLEMENT');
    if (name.startsWith('card-service/src/') && !/\.js$/.test(name)) throw fail('SOURCE_RELEASE_SUPPLEMENT');
    if (name.startsWith('card-service/src/')) classification(`functions/services/${name}`);
    const filename = regularFile(root, name), bytes = fs.readFileSync(filename);
    scan(bytes);
    const item = { path: name, filename, origin: 'repository', sha256: hash(bytes), bytes: bytes.length };
    selections.push(item); verified.push({ filename, sha256: item.sha256 });
  }
  let cardManifest;
  try { cardManifest = JSON.parse(fs.readFileSync(path.join(root, 'card-service/manifest.json'), 'utf8')); }
  catch (_) { throw fail('SOURCE_RELEASE_SUPPLEMENT'); }
  if (!Array.isArray(cardManifest.modules) || !cardManifest.modules.length
      || new Set(cardManifest.modules).size !== cardManifest.modules.length) throw fail('SOURCE_RELEASE_SUPPLEMENT');
  const cardSourceNames = supplementNames.filter(name => name.startsWith('card-service/src/'));
  if (cardSourceNames.length !== cardManifest.modules.length) throw fail('SOURCE_RELEASE_SUPPLEMENT');
  for (const moduleName of cardManifest.modules) {
    relativeName(moduleName);
    const source = selections.find(item => item.path === `card-service/src/${moduleName}`);
    const generated = selections.find(item => item.path === `functions/services/card-service/${moduleName}`);
    if (!source || !generated || source.sha256 !== generated.sha256) throw fail('SOURCE_RELEASE_CARD_SOURCE_MISMATCH');
  }
  for (const name of ['ASSET_RIGHTS.md', 'THIRD_PARTY_NOTICES.md', 'DEPLOYED_SOURCE.md']) {
    const expected = fs.readFileSync(path.join(root, 'legal', name), 'utf8')
      .replace(/\]\(\.\.\/public\/legal\//g, '](').replace(/\]\(\.\.\/LICENSE\)/g, '](AGPL-3.0-only.txt)');
    if (fs.readFileSync(path.join(bundle, 'public/legal', name), 'utf8') !== expected) throw fail('SOURCE_RELEASE_NOTICE_MISMATCH');
  }
  const index = fs.readFileSync(path.join(bundle, 'functions/index.js'), 'utf8');
  const names = [...index.matchAll(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm)].map(match => match[1]);
  if (!names.length || new Set(names).size !== names.length) throw fail('SOURCE_RELEASE_EXPORTS');
  selections.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceManifest = {
    format: 1, sourceState: 'prepared-not-deployed', baseBundleManifestSha256: hash(manifestBytes),
    functionExports: { source: 'functions/index.js', method: 'static-export-assignment', names: names.sort() },
    files: selections.map(({ filename, ...item }) => item), excluded: exclusions,
    generatedFiles: [{ path: 'SOURCE_MANIFEST.json', origin: 'generated', hashIncluded: false, reason: 'manifest-self-reference' }],
    verification: { bundleFiles: declared.size, bundleFilesHashVerified: verified.length - supplementNames.length,
      excludedContentNotRead: exclusions.filter(item => !item.contentRead).map(item => item.path),
      remoteAccessPerformed: false, deploymentPerformed: false },
  };
  const tarEnvironment = { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
  try { if (!execFileSync('tar', ['--version'], { env: tarEnvironment, encoding: 'utf8', maxBuffer: 1024 * 1024 }).includes('GNU tar')) throw fail('SOURCE_RELEASE_TAR'); }
  catch (_) { throw fail('SOURCE_RELEASE_TAR'); }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(output + '.building-');
  try {
    const tree = path.join(temporary, 'tree'), artifacts = path.join(temporary, 'artifacts');
    fs.mkdirSync(tree); fs.mkdirSync(artifacts);
    for (const item of selections) {
      const destination = path.join(tree, item.path), bytes = fs.readFileSync(item.filename);
      if (hash(bytes) !== item.sha256) throw fail('SOURCE_RELEASE_SOURCE_CHANGED');
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
    }
    fs.writeFileSync(path.join(tree, 'SOURCE_MANIFEST.json'), json(sourceManifest), { flag: 'wx', mode: 0o644 });
    const raw = path.join(temporary, 'source.tar'), archiveName = `${basename}.tar.gz`, archive = path.join(artifacts, archiveName);
    try { execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX',
      '--format=gnu', '-cf', raw, '-C', tree, '.'], { env: tarEnvironment, stdio: 'pipe', maxBuffer: 1024 * 1024 }); }
    catch (_) { throw fail('SOURCE_RELEASE_TAR'); }
    await pipeline(fs.createReadStream(raw), createGzip({ level: 9 }), fs.createWriteStream(archive, { flags: 'wx', mode: 0o644 }));
    const archiveHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) archiveHash.update(chunk);
    const archiveSha256 = archiveHash.digest('hex');
    fs.writeFileSync(path.join(artifacts, `${basename}.sha256`), `${archiveSha256}  ${archiveName}\n`, { flag: 'wx', mode: 0o644 });
    fs.writeFileSync(path.join(artifacts, 'SOURCE_MANIFEST.json'), json(sourceManifest), { flag: 'wx', mode: 0o644 });
    if (hash(fs.readFileSync(path.join(bundle, 'bundle-manifest.json'))) !== sourceManifest.baseBundleManifestSha256
        || verified.some(item => hash(fs.readFileSync(item.filename)) !== item.sha256)) throw fail('SOURCE_RELEASE_SOURCE_CHANGED');
    if (fs.existsSync(output)) throw fail('SOURCE_RELEASE_EXISTS');
    fs.renameSync(artifacts, output);
    return { sourceState: sourceManifest.sourceState, archive: path.join(output, archiveName), sha256: archiveSha256,
      sourceFiles: selections.length, functionExports: names.length, excludedFiles: exclusions.length,
      bundleFilesHashVerified: sourceManifest.verification.bundleFilesHashVerified,
      excludedContentNotRead: sourceManifest.verification.excludedContentNotRead,
      baseBundleManifestSha256: sourceManifest.baseBundleManifestSha256, remoteAccessPerformed: false, deploymentPerformed: false };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function main(args = process.argv.slice(2), { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      stdout('오프라인 공개 소스 준비: --root <원본> --bundle <검토 묶음> --output <새 폴더> --basename <ygo-source-prepared-이름>\n운영 접속·배포 없이 새 tar.gz·체크섬·SOURCE_MANIFEST.json을 생성합니다. GNU tar가 필요합니다.\n'); return 0;
    }
    if (args.length !== 8 || args[0] !== '--root' || args[2] !== '--bundle' || args[4] !== '--output' || args[6] !== '--basename') throw fail('SOURCE_RELEASE_ARGUMENT');
    stdout(json(await prepare({ root: args[1], bundle: args[3], output: args[5], basename: args[7] }))); return 0;
  } catch (error) { stderr(json({ code: /^SOURCE_RELEASE_[A-Z_]+$/.test(error.code || '') ? error.code : 'SOURCE_RELEASE_FAILED' })); return 2; }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { prepare, main };
