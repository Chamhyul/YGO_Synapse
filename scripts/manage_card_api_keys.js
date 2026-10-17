'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { UNLIMITED, newKey, keyOptions } = require('../functions/services/cardApiAccess');
const { initializeDataToolFirebaseApp } = require('./cloud_credentials');
const ROOT = path.resolve(__dirname, '..');
function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['issue', 'disable', 'rotate'].includes(command)) throw new Error('명령은 issue, disable, rotate 중 하나여야 합니다.');
  const result = { command, origins: [], apply: false, production: false, rtdbEmulator: false, writerEmulator: false };
  const names = { '--label': 'label', '--id': 'id', '--out': 'out', '--origin': 'origin', '--minute-limit': 'minuteLimit', '--day-limit': 'dayLimit', '--expires-at': 'expiresAt', '--emulator': 'emulator' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--apply', '--production', '--rtdb-emulator', '--writer-emulator', '--writer-production'].includes(flag)) {
      const name = flag === '--writer-production' ? 'writerProduction' : flag === '--writer-emulator' ? 'writerEmulator' : flag === '--rtdb-emulator' ? 'rtdbEmulator' : flag.slice(2);
      if (result[name]) throw new Error('중복 옵션'); result[name] = true; continue;
    }
    const name = names[flag], value = args[++i];
    if (!name || !value || value.startsWith('--')) throw new Error('잘못된 옵션');
    if (name === 'origin') result.origins.push(value);
    else { if (result[name] !== undefined) throw new Error('중복 옵션'); result[name] = value; }
  }
  if ([result.production, result.emulator, result.rtdbEmulator, result.writerEmulator, result.writerProduction].filter(Boolean).length !== 1) throw new Error('실행 대상을 하나만 지정하세요.');
  if (result.emulator && !/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(result.emulator)) throw new Error('에뮬레이터는 루프백 주소만 허용합니다.');
  if (command === 'issue') {
    if (result.id !== undefined) throw new Error('issue는 ID를 직접 받지 않습니다.');
    result.options = keyOptions({ label: result.label, origins: result.origins,
      minuteLimit: result.minuteLimit === undefined ? 60 : result.minuteLimit === UNLIMITED ? UNLIMITED : Number(result.minuteLimit),
      dayLimit: result.dayLimit === undefined ? 5000 : result.dayLimit === UNLIMITED ? UNLIMITED : Number(result.dayLimit),
      expiresAt: result.expiresAt === undefined ? null : Date.parse(result.expiresAt) });
  } else {
    if (!/^[a-f0-9]{24}$/.test(result.id || '')) throw new Error('유효한 키 ID가 필요합니다.');
    if (result.label !== undefined || result.origins.length || result.minuteLimit !== undefined || result.dayLimit !== undefined || result.expiresAt !== undefined) throw new Error('키 설정은 issue에서만 받습니다.');
  }
  if (command === 'disable' && result.out !== undefined) throw new Error('disable에는 출력 파일이 필요하지 않습니다.');
  if (command !== 'disable' && (!result.out || !path.isAbsolute(result.out))) throw new Error('--out에 저장소 밖의 절대 경로를 지정하세요.');
  return result;
}
function validateTarget(args, env = process.env) {
  if (args.writerProduction) {
    if (require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env).mode !== 'production') throw new Error('등록된 운영 공통 writer가 필요합니다.');
    return;
  }
  if (args.writerEmulator) {
    require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env);
    if (env.CARD_SERVICE_URL) throw new Error('writer 시험은 같은 프로젝트의 격리 카드 DB만 허용합니다.');
    return;
  }
  if (env.USER_PROFILE_WRITER_MODE || env.USER_STORAGE_MODE === 'production') throw new Error('공통 writer 관리 대상을 명시해 주세요.');
  const backend = env.USER_STORAGE_BACKEND;
  if (args.rtdbEmulator) {
    // 명시 대상이어도 기존 demo/test/URL 경계를 그대로 검사한다. 기본 Firebase 앱은 만들지 않는다.
    require('../functions/config/userStorage').resolveRtdbConfig(env);
    return;
  }
  if (backend !== undefined && backend !== '' && backend !== 'storage') {
    throw new Error('사용자 저장소 설정과 키 관리 대상이 일치하지 않습니다. RTDB 시험에는 --rtdb-emulator를 명시하세요.');
  }
  const emulatorVariables = ['FIRESTORE_EMULATOR_HOST', 'FUNCTIONS_EMULATOR', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST'];
  if (args.production && emulatorVariables.some(name => env[name])) throw new Error('운영 모드에서는 에뮬레이터 환경변수를 제거하세요.');
  if (args.emulator && env.FIRESTORE_EMULATOR_HOST && env.FIRESTORE_EMULATOR_HOST !== args.emulator) throw new Error('에뮬레이터 설정 불일치');
}
function saveKey(filename, key, target) {
  const parent = fs.realpathSync(path.dirname(filename));
  const resolved = path.join(parent, path.basename(filename));
  const repository = fs.realpathSync(ROOT);
  if (resolved === repository || resolved.startsWith(repository + path.sep)) throw new Error('키 원문은 저장소 안에 저장할 수 없습니다.');
  const fd = fs.openSync(resolved, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ id: key.id, apiKey: key.token, target }) + '\n'); }
  finally { fs.closeSync(fd); }
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  validateTarget(args);
  if (!args.apply) { process.stdout.write('미적용: 입력 검증만 완료했습니다. --apply가 있어야 키 파일과 DB를 변경합니다.\n'); return; }
  try {
    let db, writerBinding;
    if (args.writerEmulator || args.writerProduction) writerBinding = require('../functions/services/userProfileWriterRuntime').getProfileWriterBinding();
    if (!args.rtdbEmulator && !args.writerEmulator && !args.writerProduction) {
      const admin = require('../functions/node_modules/firebase-admin');
      if (args.emulator) {
        process.env.FIRESTORE_EMULATOR_HOST = args.emulator;
        admin.initializeApp({ projectId: 'ygo-synapse' });
      } else initializeDataToolFirebaseApp(admin, { projectId: 'ygo-synapse' });
      db = admin.firestore();
    }
    const access = require('../functions/services/cardApiAccessRepository').getCardApiAccess({ db, writerBinding });
    if (args.command === 'disable') await access.disable(args.id);
    else {
      const key = newKey(args.command === 'rotate' ? args.id : undefined);
      // DB 처리 전에 원문을 안전하게 보관한다. 응답 불명확 시 파일을 삭제하지 않는다.
      saveKey(args.out, key, args.writerProduction ? 'writer-production' : args.writerEmulator ? 'writer-emulator' : args.rtdbEmulator ? 'rtdb-emulator' : args.production ? 'production' : 'emulator');
      try {
        if (args.command === 'issue') await access.register(key, args.options);
        else await access.rotate(key);
      } catch (_) { throw new Error('DB 적용을 확인하지 못했습니다. 출력 파일은 보존했습니다. 키 상태를 확인하기 전 사용하거나 같은 명령을 재실행하지 마세요.'); }
    }
    process.stdout.write('키 관리 적용 완료. 키 원문은 출력 파일에서만 확인하세요.\n');
  } finally {
    if (args.writerEmulator || args.writerProduction) await require('../functions/services/userProfileWriterRuntime').closeProfileWriterRuntime();
    if (args.rtdbEmulator) await require('../functions/services/userStorageRuntime').closeRtdbUserStorage();
  }
}
if (require.main === module) main().catch(error => {
  // SDK 원본 오류에는 요청/자격증명 정보가 섞일 수 있으므로 출력하지 않는다.
  process.stderr.write(error.message?.startsWith('DB 적용을') ? error.message + '\n' : '키 관리 실패: 명령 옵션·출력 경로·인증·DB 접근을 확인하세요.\n');
  process.exitCode = 1;
});
module.exports = { parseArgs, validateTarget, saveKey, main };
