#!/usr/bin/env node
'use strict';
// 로컬 검토 묶음만 만든다. SDK·인증·네트워크·명령 실행·기존 설정 덮어쓰기는 하지 않는다.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { prepare } = require('./prepare_user_storage_deployment.cjs');
const { mergeEnvironment } = require('./merge_user_storage_environment.cjs');
const fail = code => Object.assign(new Error('로컬 배포 묶음의 입력과 출력 범위를 확인해 주세요.'), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const FUNCTION_DIRS = ['config', 'integrations', 'routes', 'schedules', 'scrapers', 'services', 'tasks', 'utils', 'templates'];
const JOB_FILES = ['scripts/user_writer_job.cjs', 'scripts/manage_user_writer.cjs', 'scripts/reconcile_membership_claims.cjs',
  'operations/user-storage/Dockerfile', 'operations/user-storage/Dockerfile.dockerignore', 'operations/user-storage/database.rules.json'];
function excluded(name) {
  const lower = name.toLowerCase();
  return name.startsWith('.') || ['node_modules', 'test', 'private', 'docs', 'data', 'previews'].includes(lower)
    || lower.startsWith('gha-creds-') || /service[-_]?account.*\.json$/.test(lower)
    || /\.(pem|p12|key|log)$/.test(lower);
}
function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw fail('USER_DEPLOYMENT_BUNDLE_PATH');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw fail('USER_DEPLOYMENT_BUNDLE_SYMLINK');
  }
  return current;
}
function stage({ root, configPath, output, environmentPath }) {
  root = fs.realpathSync(root); output = path.resolve(root, output);
  const local = path.join(root, 'operations/user-storage/local'), allowed = path.join(local, 'bundles');
  if (!output.startsWith(allowed + path.sep)) throw fail('USER_DEPLOYMENT_BUNDLE_PATH');
  for (let ancestor = output; ancestor !== root; ancestor = path.dirname(ancestor)) {
    let stat; try { stat = fs.lstatSync(ancestor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw fail('USER_DEPLOYMENT_BUNDLE_SYMLINK');
  }
  if (fs.existsSync(output)) throw fail('USER_DEPLOYMENT_BUNDLE_EXISTS');
  const configInputs = new Map();
  const read = relative => { const bytes = fs.readFileSync(safePath(root, relative)); configInputs.set(relative, digest(bytes)); return JSON.parse(bytes.toString('utf8')); };
  const config = read(configPath), firebase = read('firebase.json'), firebaserc = read('.firebaserc');
  const plan = prepare(config, { firebase, firebaserc });
  if (plan.needsInput.some(key => key !== 'job.image')) throw fail('USER_DEPLOYMENT_BUNDLE_INCOMPLETE');
  let mergedEnvironment;
  if (environmentPath !== undefined) {
    const base = read(environmentPath);
    if (!base || Object.keys(base).sort().join(',') !== 'environmentVariables,projectId,secretNames'
        || base.projectId !== config.projectId) throw fail('USER_DEPLOYMENT_BUNDLE_ENVIRONMENT');
    mergedEnvironment = mergeEnvironment({ projectId: config.projectId, base: base.environmentVariables,
      patch: plan.artifacts.functionsEnvPatch, secretNames: base.secretNames });
  }
  // 현재 단일 저장소의 경로 계약이 바뀌면 누락된 소스를 조용히 배포하지 않는다.
  if (!Array.isArray(firebase.functions) || firebase.functions.length !== 1 || firebase.functions[0].source !== 'functions'
      || firebase.hosting?.public !== 'public' || firebase.firestore?.rules !== 'firestore.rules'
      || firebase.firestore?.indexes !== 'firestore.indexes.json' || !Array.isArray(firebase.storage)
      || firebase.storage.some(item => item.rules !== 'storage.rules')
      || Object.hasOwn(firebase.functions[0], 'predeploy') || Object.hasOwn(firebase.functions[0], 'postdeploy')) throw fail('USER_DEPLOYMENT_BUNDLE_LAYOUT');
  if (JSON.stringify(read('operations/user-storage/database.rules.json')) !== JSON.stringify({ rules: { '.read': false, '.write': false } })) throw fail('USER_DEPLOYMENT_BUNDLE_RULES');
  const files = new Set(['functions/package.json', 'functions/package-lock.json', 'functions/index.js', 'functions/server.js',
    'firestore.rules', 'firestore.indexes.json', 'storage.rules', 'LICENSE', ...JOB_FILES]);
  function walk(relative, isFunctions) {
    for (const item of fs.readdirSync(safePath(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded(item.name)) continue;
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw fail('USER_DEPLOYMENT_BUNDLE_SYMLINK');
      if (item.isDirectory()) walk(name, isFunctions);
      else if (item.isFile()) {
        if (isFunctions && !/\.(js|json|html)$/.test(item.name)) throw fail('USER_DEPLOYMENT_BUNDLE_LAYOUT');
        files.add(name);
      } else throw fail('USER_DEPLOYMENT_BUNDLE_LAYOUT');
    }
  }
  for (const dir of FUNCTION_DIRS) walk(`functions/${dir}`, true);
  walk('public', false);
  for (const file of files) if (!fs.statSync(safePath(root, file)).isFile()) throw fail('USER_DEPLOYMENT_BUNDLE_LAYOUT');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = fs.mkdtempSync(output + '.building-'), manifest = [], inputs = [];
  const put = (relative, data, sourceHash, mode) => {
    fs.mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true });
    fs.writeFileSync(path.join(temp, relative), data, { flag: 'wx', ...(mode ? { mode } : {}) });
    manifest.push({ path: relative, sha256: digest(data), bytes: Buffer.byteLength(data), ...(sourceHash ? { sourceSha256: sourceHash } : {}) });
  };
  try {
    for (const file of [...files].sort()) {
      const bytes = fs.readFileSync(safePath(root, file)), hash = digest(bytes); inputs.push({ file, hash });
      // 운영 등록은 검토 묶음 안에만 준비한다. 원본의 빈 목록/기본 실행 설정은 보존한다.
      if (file === 'functions/config/userStorageTargets.js') {
        put(file, "'use strict';\n// 로컬 검토 후보: 실제 소속·권한·운영 승인은 별도 확인한다.\nconst PRODUCTION_TARGETS = Object.freeze(" + json([plan.artifacts.targetRegistration]).trim() + ".map(Object.freeze));\nmodule.exports = { PRODUCTION_TARGETS };\n", hash);
      } else put(file, bytes, hash);
    }
    put('firebase.json', json(plan.artifacts.firebaseConfig)); put('.firebaserc', json(plan.artifacts.firebaserc));
    put('functions.env.patch.json', json(plan.artifacts.functionsEnvPatch));
    if (mergedEnvironment) {
      put(`functions/.env.${config.projectId}`, mergedEnvironment.dotenv, undefined, 0o600);
      put('functions.env.review.json', json({ projectId: config.projectId, merged: true, remoteExecutionPerformed: false,
        ...mergedEnvironment.summary, platformVariablesCopied: false, secretValuesCopied: false }));
    }
    put('job.env.yaml', Object.entries(plan.artifacts.jobEnv).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join(''));
    put('target-registration.json', json(plan.artifacts.targetRegistration));
    put('runtime-identity.review.json', json({
      job: { serviceAccount: config.job.serviceAccount, status: 'candidate-unverified', authentication: 'managed-runtime-metadata' },
      functions: { strategy: 'preserve-current-per-function-identities', verified: false },
      secrets: { strategy: 'preserve-existing-bindings-and-values', copyLocalCredentials: false },
      iamChangesPerformed: false,
      checksRequired: ['실제 함수별 실행 계정·Secret 바인딩 확인', 'Job 계정 존재·필요 리소스 권한 확인', '게시자·배포자·Job 실행자 권한 분리',
        'RTDB update 권한의 Rules/enable 변경 범위 확인', 'Storage list는 객체 이름 조건만으로 prefix 제한되지 않음'],
    }));
    // 모든 상대 경로는 묶음 루트에서 실행하는 형식이다. 자동 실행 파일은 만들지 않는다.
    const commands = plan.commands.map(command => ({ ...command, argv: command.argv.map(arg => arg.replaceAll('<reviewedBundle>/', './')) }));
    put('deployment-review.json', json({ ...plan, commands, workingDirectory: 'bundle-root', readyForDeployment: false,
      environmentMerged: !!mergedEnvironment,
      checksRequired: ['실제 DB 소속·Rules·내용 확인', '함수별 현행 계정/Secret/env 보존·env patch 병합', '관리 Job 계정/권한 확인',
        '검토 소스의 이미지 게시·digest 고정', '초기 상태 legacy/accepting 확인', '배포/전환 승인과 중단·복구 기준 확정'] }));
    for (const { file, hash } of inputs) if (digest(fs.readFileSync(safePath(root, file))) !== hash) throw fail('USER_DEPLOYMENT_BUNDLE_SOURCE_CHANGED');
    for (const [file, hash] of configInputs) if (digest(fs.readFileSync(safePath(root, file))) !== hash) throw fail('USER_DEPLOYMENT_BUNDLE_SOURCE_CHANGED');
    const result = { format: 1, readyForDeployment: false, remoteExecutionPerformed: false, databaseState: plan.databaseState,
      sourceFiles: inputs.length, generatedFiles: manifest.filter(item => !item.sourceSha256).length,
      transformedSourceFiles: ['functions/config/userStorageTargets.js'], files: manifest };
    fs.writeFileSync(path.join(temp, 'bundle-manifest.json'), json(result), { flag: 'wx' });
    if (fs.existsSync(output)) throw fail('USER_DEPLOYMENT_BUNDLE_EXISTS');
    fs.renameSync(temp, output);
    return { readyForDeployment: false, remoteExecutionPerformed: false, sourceFiles: result.sourceFiles,
      generatedFiles: result.generatedFiles, needsInput: plan.needsInput, commands: commands.length };
  } catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error; }
}
function main(args = process.argv.slice(2), { root = path.resolve(__dirname, '..'), stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { stdout('로컬 배포 묶음 준비: --config <비밀값 없는 JSON> --output operations/user-storage/local/bundles/<새이름> [--environment <확인한 앱 환경 JSON>]\n기존 출력은 덮어쓰지 않으며 SDK·인증·네트워크·명령 실행은 하지 않습니다.\n'); return 0; }
    if (![4, 6].includes(args.length) || args[0] !== '--config' || args[2] !== '--output'
        || args.length === 6 && args[4] !== '--environment') throw fail('USER_DEPLOYMENT_BUNDLE_ARGUMENT');
    stdout(json(stage({ root, configPath: args[1], output: args[3], ...(args.length === 6 ? { environmentPath: args[5] } : {}) }))); return 0;
  } catch (error) {
    stderr(json({ code: /^USER_DEPLOYMENT_[A-Z_]+$/.test(error.code || '') ? error.code : 'USER_DEPLOYMENT_BUNDLE_FAILED' })); return 2;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { stage, main };
