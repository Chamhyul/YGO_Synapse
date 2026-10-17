'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, validateTarget, saveKey, main } = require('./manage_card_api_keys');
const script = path.join(__dirname, 'manage_card_api_keys.js');
test('키 관리 도구: 명시 대상·옵션 검사와 미적용 기본 동작', () => {
  const args = ['issue', '--label', '합성', '--emulator', '127.0.0.1:5003', '--out', '/tmp/synthetic-key.json'];
  assert.equal(parseArgs(args).apply, false);
  assert.equal(parseArgs(args).options.minuteLimit, 60);
  const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.match(stdout, /미적용/); assert.equal(fs.existsSync('/tmp/synthetic-key.json'), false);
  for (const input of [[], ['issue', '--production'], [...args, '--production'], [...args, '--origin', '*'], [...args, '--minute-limit', '0'], ['rotate', '--id', 'bad', '--production', '--out', '/tmp/k'], ['disable', '--id', 'a'.repeat(24), '--production', '--out', '/tmp/k']]) assert.throws(() => parseArgs(input));
});
test('키 원문 파일: 저장소 밖·0600·덮어쓰기 및 심볼릭 링크 거부', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-api-key-test-'));
  try {
    const out = path.join(dir, 'key.json'), key = { id: 'synthetic-id', token: 'synthetic-secret' };
    saveKey(out, key, 'emulator'); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(out)).apiKey, 'synthetic-secret');
    assert.throws(() => saveKey(out, key, 'emulator'));
    const link = path.join(dir, 'link.json'); fs.symlinkSync(out, link); assert.throws(() => saveKey(link, key, 'emulator'));
    assert.throws(() => saveKey(path.join(__dirname, 'key.json'), key, 'emulator'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('관리 도구의 unlimited 식별자: 개별/동시 지정·미적용·오타 거부', () => {
  const args = ['issue', '--label', '합성 무제한', '--emulator', '127.0.0.1:5003', '--out', '/tmp/synthetic-unlimited-key.json'];
  const both = [...args, '--minute-limit', 'unlimited', '--day-limit', 'unlimited'];
  assert.equal(parseArgs(both).options.minuteLimit, 'unlimited'); assert.equal(parseArgs(both).options.dayLimit, 'unlimited');
  assert.equal(parseArgs([...args, '--minute-limit', 'unlimited']).options.dayLimit, 5000);
  assert.equal(parseArgs([...args, '--day-limit', 'unlimited']).options.minuteLimit, 60);
  for (const invalid of ['Unlimited', 'null', 'none', 'Infinity']) assert.throws(() => parseArgs([...args, '--minute-limit', invalid]));
  const stdout = execFileSync(process.execPath, [script, ...both], { encoding: 'utf8' });
  assert.match(stdout, /미적용/); assert.equal(fs.existsSync('/tmp/synthetic-unlimited-key.json'), false);
});

test('RTDB 에뮬레이터 설정만 있어도 운영 API 키 변경은 SDK 접근 전에 거부한다', async () => {
  const previous = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9000';
  try {
    await assert.rejects(main(['disable', '--id', 'a'.repeat(24), '--production', '--apply']),
      /운영 모드에서는 에뮬레이터 환경변수를 제거하세요/);
  } finally {
    if (previous === undefined) delete process.env.FIREBASE_DATABASE_EMULATOR_HOST;
    else process.env.FIREBASE_DATABASE_EMULATOR_HOST = previous;
  }
  // CLI는 내부 오류 원문 대신 기존의 안전한 공통 메시지만 출력한다.
  assert.throws(() => execFileSync(process.execPath,
    [script, 'disable', '--id', 'a'.repeat(24), '--production', '--apply'], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: 'localhost:9000' },
    }), error => error.status === 1 && /키 관리 실패: 명령 옵션·출력 경로·인증·DB 접근을 확인하세요/.test(error.stderr));
});

const rtdbEnv = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
test('RTDB 키 관리 대상은 명시 옵션 하나만 받고 기존 시험 연결 경계를 유지한다', () => {
  const base = ['issue', '--label', '합성 RTDB', '--out', '/tmp/synthetic-rtdb-key.json'];
  const selected = parseArgs([...base, '--rtdb-emulator']);
  assert.equal(selected.rtdbEmulator, true);
  assert.equal(selected.apply, false);
  assert.doesNotThrow(() => validateTarget(selected, rtdbEnv));
  for (const flags of [[], ['--rtdb-emulator', '--production'], ['--rtdb-emulator', '--emulator', '127.0.0.1:5003'],
    ['--rtdb-emulator', '--rtdb-emulator'], ['--rtdb-emulator', 'emulators:9000']]) {
    assert.throws(() => parseArgs([...base, ...flags]));
  }
  for (const invalid of [{}, { USER_STORAGE_BACKEND: 'storage' }, { NODE_ENV: 'production' },
    { GCLOUD_PROJECT: 'ygo-synapse' }, { FIREBASE_DATABASE_EMULATOR_HOST: 'remote.example:9000' },
    { USER_DATABASE_URL: 'https://demo-user-storage-default-rtdb.firebaseio.com' },
    { USER_DATABASE_URL: 'http://emulators:9000?ns=other-project' }]) {
    const env = Object.keys(invalid).length ? { ...rtdbEnv, ...invalid } : {};
    assert.throws(() => validateTarget(selected, env), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
});

test('RTDB 또는 알 수 없는 backend에서 기존 Firestore 관리 명령으로 우회하지 않는다', () => {
  for (const backend of ['rtdb', 'unknown']) {
    for (const flags of [['--production'], ['--emulator', '127.0.0.1:5003']]) {
      const args = parseArgs(['disable', '--id', 'a'.repeat(24), ...flags]);
      assert.throws(() => validateTarget(args, { USER_STORAGE_BACKEND: backend }), /저장소 설정과 키 관리 대상/);
    }
  }
  for (const backend of [undefined, '', 'storage']) {
    const args = parseArgs(['disable', '--id', 'a'.repeat(24), '--emulator', '127.0.0.1:5003']);
    assert.doesNotThrow(() => validateTarget(args, { USER_STORAGE_BACKEND: backend }));
  }
});

test('RTDB CLI 미적용은 SDK 연결 없이 설정만 검사하고 키 파일을 만들지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-api-rtdb-dryrun-'));
  const out = path.join(dir, 'key.json');
  // 존재하지 않는 루프백 포트에서도 미적용 명령은 연결 없이 종료되어야 한다.
  const env = { ...process.env, ...rtdbEnv, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1',
    USER_DATABASE_URL: 'http://127.0.0.1:1?ns=demo-user-storage-default-rtdb' };
  try {
    const stdout = execFileSync(process.execPath, [script, 'issue', '--rtdb-emulator', '--label', '합성', '--out', out],
      { encoding: 'utf8', env, timeout: 5000 });
    assert.match(stdout, /미적용/);
    assert.equal(fs.existsSync(out), false);
    assert.throws(() => execFileSync(process.execPath,
      [script, 'issue', '--production', '--label', '합성', '--out', out], { encoding: 'utf8', env, stdio: 'pipe', timeout: 5000 }),
    error => error.status === 1 && /키 관리 실패/.test(error.stderr));
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
