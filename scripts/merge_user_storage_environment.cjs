#!/usr/bin/env node
'use strict';
// 비밀값을 제외한 검토 JSON만 병합한다. SDK·인증·네트워크·명령 실행은 하지 않는다.
const fs = require('node:fs'), path = require('node:path');
const PATCH_KEYS = ['NODE_ENV', 'USER_STORAGE_BACKEND', 'USER_STORAGE_MODE', 'USER_STORAGE_TARGET',
  'USER_DATABASE_URL', 'USER_PROFILE_WRITER_MODE', 'USER_PROFILE_WRITER_RUN_ID', 'STORAGE_BUCKET'];
const RESERVED = new Set(['CLOUD_RUNTIME_CONFIG', 'EVENTARC_CLOUD_EVENT_SOURCE', 'ENTRY_POINT', 'GCP_PROJECT',
  'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'PORT', 'LOG_EXECUTION_ID', 'PATH', 'HOME', 'NODE_PATH', 'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const fail = code => Object.assign(new Error('환경 병합의 비밀값 제외·프로젝트·입출력 범위를 확인해 주세요.'), { code });
const invalid = () => fail('USER_ENV_MERGE_INVALID');
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validKey(key) { return /^[A-Z_][A-Z0-9_]*$/.test(key); }
function assertVariables(value, secrets) {
  if (!isRecord(value)) throw invalid();
  for (const [key, entry] of Object.entries(value)) {
    if (!validKey(key) || RESERVED.has(key) || /^(X_GOOGLE_|FIREBASE_|EXT_|FUNCTION_|K_|CLOUD_RUN_|CLOUDSDK_|GCE_)/.test(key)
        || /EMULATOR|METADATA|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|API_KEY|ACCESS_KEY/.test(key)
        || key === 'CARD_SERVICE_URL' || secrets.has(key) || typeof entry !== 'string'
        || /[\u0000-\u0008\u000c\u000e-\u001f\u007f]/.test(entry)
        || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)) throw invalid();
  }
}
function escapeValue(value) {
  // Firebase CLI의 double-quoted dotenv parser가 해석하는 문자만 escape한다. $는 치환하지 않는다.
  const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\\': '\\\\', '"': '\\"', "'": "\\'" };
  return '"' + value.replace(/[\n\r\t\v\\'"]/g, character => escapes[character]) + '"';
}
function mergeEnvironment({ projectId, base, patch, secretNames }) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')
      || !Array.isArray(secretNames) || secretNames.some(key => typeof key !== 'string' || !validKey(key))
      || new Set(secretNames).size !== secretNames.length) throw invalid();
  const secrets = new Set(secretNames);
  assertVariables(base, secrets); assertVariables(patch, secrets);
  if (Object.keys(patch).sort().join(',') !== PATCH_KEYS.slice().sort().join(',')
      || patch.NODE_ENV !== 'production' || patch.USER_STORAGE_BACKEND !== 'rtdb' || patch.USER_STORAGE_MODE !== 'production'
      || patch.USER_PROFILE_WRITER_MODE !== 'production' || !/^[a-z][a-z0-9-]{0,62}$/.test(patch.USER_STORAGE_TARGET)
      || !/^[a-f0-9]{32}$/.test(patch.USER_PROFILE_WRITER_RUN_ID)
      || ![`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`].includes(patch.STORAGE_BUCKET)) throw invalid();
  let url; try { url = new URL(patch.USER_DATABASE_URL); } catch (_) { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
      || !/^https:\/\/[^\s\\]+\/$/.test(patch.USER_DATABASE_URL)
      || !/^[a-z][a-z0-9-]*\.(firebaseio\.com|(?:asia-southeast1|europe-west1)\.firebasedatabase\.app)$/.test(url.hostname)) throw invalid();
  // 이미 사용한 전환 ID/대상을 새 값으로 덮어써서 진행점·복구 자료를 잃지 않는다.
  if (base.USER_PROFILE_WRITER_RUN_ID && base.USER_PROFILE_WRITER_RUN_ID !== patch.USER_PROFILE_WRITER_RUN_ID
      || base.USER_PROFILE_WRITER_MODE === 'production' && ['USER_STORAGE_TARGET', 'USER_DATABASE_URL', 'STORAGE_BUCKET']
        .some(key => base[key] && base[key] !== patch[key])) throw fail('USER_ENV_MERGE_ACTIVE_TRANSITION');
  const merged = { ...base, ...patch };
  const summary = {
    preservedKeys: Object.keys(base).filter(key => !Object.hasOwn(patch, key)).sort(),
    addedKeys: PATCH_KEYS.filter(key => !Object.hasOwn(base, key)).sort(),
    updatedKeys: PATCH_KEYS.filter(key => Object.hasOwn(base, key) && base[key] !== patch[key]).sort(),
    unchangedPatchKeys: PATCH_KEYS.filter(key => Object.hasOwn(base, key) && base[key] === patch[key]).sort(),
    secretBindingNames: [...secrets].sort(),
  };
  return { dotenv: Object.keys(merged).sort().map(key => `${key}=${escapeValue(merged[key])}\n`).join(''), summary };
}
function localPath(root, input, { output = false } = {}) {
  if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw fail('USER_ENV_MERGE_PATH');
  const resolved = path.resolve(root, input), local = path.join(root, 'operations/user-storage/local');
  if (!resolved.startsWith(local + path.sep)) throw fail('USER_ENV_MERGE_PATH');
  for (let current = resolved; current !== root; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw fail('USER_ENV_MERGE_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (output) {
    if (fs.existsSync(resolved)) throw fail('USER_ENV_MERGE_EXISTS');
  } else if (path.extname(resolved) !== '.json' || /secret|credential|service.?account/i.test(path.basename(resolved))
      || !fs.statSync(resolved).isFile()) throw fail('USER_ENV_MERGE_PATH');
  return resolved;
}
function writeMergedEnvironment({ root, basePath, patchPath, projectId, output }) {
  root = fs.realpathSync(root);
  // 입력을 읽기 전에 출력 범위와 모든 symlink를 확인한다. 기존 dotenv는 읽지도 덮어쓰지도 않는다.
  const destination = localPath(root, output, { output: true });
  const baseFile = localPath(root, basePath), patchFile = localPath(root, patchPath);
  const review = JSON.parse(fs.readFileSync(baseFile, 'utf8')), patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  if (!isRecord(review) || Object.keys(review).sort().join(',') !== 'environmentVariables,projectId,secretNames' || review.projectId !== projectId) throw invalid();
  const result = mergeEnvironment({ projectId, base: review.environmentVariables, patch, secretNames: review.secretNames });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  localPath(root, output, { output: true });
  fs.writeFileSync(destination, result.dotenv, { flag: 'wx', mode: 0o600 });
  return result.summary;
}
function main(args = process.argv.slice(2), { root = path.resolve(__dirname, '..'), stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { stdout('오프라인 환경 병합: --base <검토 JSON> --patch <8키 JSON> --project <프로젝트 ID> --output <local 내부 새 파일>\n기존 dotenv·Secret 값은 읽지 않으며 출력에는 값 없는 키 목록만 표시합니다. dotenv는 shell source/eval로 실행하지 않습니다.\n'); return 0; }
    if (args.length !== 8 || args[0] !== '--base' || args[2] !== '--patch' || args[4] !== '--project' || args[6] !== '--output') throw fail('USER_ENV_MERGE_ARGUMENT');
    const summary = writeMergedEnvironment({ root, basePath: args[1], patchPath: args[3], projectId: args[5], output: args[7] });
    stdout(JSON.stringify(summary, null, 2) + '\n'); return 0;
  } catch (error) {
    stderr(JSON.stringify({ code: /^USER_ENV_MERGE_[A-Z_]+$/.test(error.code || '') ? error.code : 'USER_ENV_MERGE_FAILED' }) + '\n'); return 2;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { mergeEnvironment, writeMergedEnvironment, main };
