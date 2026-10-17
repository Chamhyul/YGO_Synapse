'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getCardApiAccess } = require('../services/cardApiAccessRepository');
const { closeRtdbUserStorage } = require('../services/userStorageRuntime');
const { createUserStorageConnection } = require('../config/userStorage');
const { encodeKey } = require('../services/user-storage/codec');

// 합성 키만 컨테이너의 저장소 밖 임시 폴더에 만들고 검사 후 삭제한다.
const script = path.resolve(__dirname, '../../scripts/manage_card_api_keys.js');
const runFile = promisify(execFile);
const dirs = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-access-cli-')); dirs.push(dir); return dir; };
const access = getCardApiAccess();
const inspection = createUserStorageConnection();
after(async () => {
  await Promise.all([closeRtdbUserStorage(), inspection.close()]);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args, env = {}) {
  try {
    const result = await runFile(process.execPath, [script, ...args], {
      env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.code, killed: error.killed };
  }
}
function privateOutput(result, expectedCode = 0) {
  assert.equal(result.code, expectedCode, 'CLI 종료 상태가 예상과 다릅니다. 출력 원문은 노출하지 않습니다.');
  assert.equal(/ygo_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}/.test(result.stdout + result.stderr), false, 'CLI 출력에는 키 원문이 없어야 합니다.');
}
function readKey(out) {
  const key = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(/^[a-f0-9]{24}$/.test(key.id), true);
  assert.equal(/^ygo_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(key.apiKey), true);
  assert.equal(key.target, 'rtdb-emulator');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  return key;
}
async function issue(dir, label, origins = []) {
  const out = path.join(dir, 'issued.json');
  const result = await run(['issue', '--rtdb-emulator', '--apply', '--label', label, '--out', out,
    '--minute-limit', 'unlimited', '--day-limit', '50', ...origins.flatMap(origin => ['--origin', origin])]);
  privateOutput(result);
  return readKey(out);
}

test('RTDB CLI 발급·교체·중지는 별도 프로세스에서 반영되고 사용량·CORS 계약을 보존한다', { timeout: 60000 }, async () => {
  const dir = temp(), origin = 'https://synthetic-cli-cycle.example';
  const key = await issue(dir, '합성 CLI 전체 과정', [origin]);
  const raw = JSON.stringify((await inspection.database.ref(`apiAccess/keys/${encodeKey(key.id)}`).get()).val());
  assert.equal(raw.includes(key.apiKey) || raw.includes(key.apiKey.split('.')[1]), false,
    '실제 RTDB 레코드에는 키 원문이나 비밀 부분을 저장하면 안 됩니다.');
  const authenticated = await access.authenticate(key.apiKey);
  assert.equal(authenticated.id, key.id);
  assert.equal(authenticated.minuteLimit, 'unlimited');
  assert.equal(authenticated.dayLimit, 50);
  assert.equal(await access.allowsPreflight(origin), true);
  const first = await access.consume(key.apiKey, origin);
  assert.equal(first.minuteRemaining, 'unlimited');
  assert.equal(first.dayRemaining, 49);

  const rotatedOut = path.join(dir, 'rotated.json');
  const rotatedResult = await run(['rotate', '--rtdb-emulator', '--apply', '--id', key.id, '--out', rotatedOut]);
  privateOutput(rotatedResult);
  const rotated = readKey(rotatedOut);
  assert.equal(rotated.id, key.id);
  assert.equal(rotated.apiKey === key.apiKey, false, '교체는 비밀값을 변경해야 합니다.');
  await assert.rejects(access.authenticate(key.apiKey), { code: 'API_KEY_INVALID' });
  assert.equal((await access.authenticate(rotated.apiKey)).id, key.id);
  assert.equal((await access.consume(rotated.apiKey, origin)).dayRemaining, 48, '교체는 집계를 초기화하지 않습니다.');
  assert.equal(await access.allowsPreflight(origin), true);

  privateOutput(await run(['disable', '--rtdb-emulator', '--apply', '--id', key.id]));
  await assert.rejects(access.authenticate(rotated.apiKey), { code: 'API_KEY_DISABLED' });
  assert.equal(await access.allowsPreflight(origin), false);
  const disabledOut = path.join(dir, 'disabled-rotate.json');
  const refused = await run(['rotate', '--rtdb-emulator', '--apply', '--id', key.id, '--out', disabledOut]);
  privateOutput(refused, 1);
  assert.equal(/출력 파일은 보존했습니다/.test(refused.stderr), true);
  readKey(disabledOut);
  await assert.rejects(access.authenticate(rotated.apiKey), { code: 'API_KEY_DISABLED' });
  assert.equal(await access.allowsPreflight(origin), false);
});

test('RTDB CLI 미적용은 발급·교체·중지에 파일이나 상태 변경을 만들지 않는다', { timeout: 60000 }, async () => {
  const dir = temp(), origin = 'https://synthetic-cli-dryrun.example';
  const out = path.join(dir, 'dryrun-issue.json');
  const preview = await run(['issue', '--rtdb-emulator', '--label', '합성 미적용', '--origin', origin, '--out', out]);
  privateOutput(preview);
  assert.equal(/미적용/.test(preview.stdout), true);
  assert.equal(fs.existsSync(out), false);
  assert.equal(await access.allowsPreflight(origin), false);
  const key = await issue(dir, '합성 변경 보존', [origin]);
  const before = await access.authenticate(key.apiKey), rotateOut = path.join(dir, 'dryrun-rotate.json');
  for (const args of [['rotate', '--out', rotateOut], ['disable']]) {
    privateOutput(await run([...args, '--rtdb-emulator', '--id', key.id]));
    assert.deepEqual(await access.authenticate(key.apiKey), before);
    assert.equal(await access.allowsPreflight(origin), true);
  }
  assert.equal(fs.existsSync(rotateOut), false);
});

test('RTDB CLI 출력 파일 충돌·링크·저장소 안 경로는 DB를 바꾸지 않고 기존 키를 보존한다', { timeout: 60000 }, async () => {
  const dir = temp(), key = await issue(dir, '합성 파일 보존');
  const out = path.join(dir, 'issued.json'), original = fs.readFileSync(out, 'utf8');
  const link = path.join(dir, 'linked.json'); fs.symlinkSync(out, link);
  const inside = path.resolve(__dirname, 'synthetic-cli-key-must-not-exist.json');
  assert.equal(fs.existsSync(inside), false);
  for (const target of [out, link, inside]) {
    privateOutput(await run(['rotate', '--rtdb-emulator', '--apply', '--id', key.id, '--out', target]), 1);
    assert.equal((await access.authenticate(key.apiKey)).id, key.id);
    assert.equal(fs.readFileSync(out, 'utf8') === original, true, '기존 원문 파일을 덮어쓰지 않습니다.');
  }
  assert.equal(fs.existsSync(inside), false);
});

test('RTDB CLI 대상 불일치·운영 프로젝트·잘못된 URL은 키 파일 생성과 DB 변경 전에 차단한다', { timeout: 60000 }, async () => {
  const dir = temp(), out = path.join(dir, 'blocked.json'), origin = 'https://synthetic-cli-blocked.example';
  const base = ['issue', '--apply', '--label', '합성 거부', '--origin', origin, '--out', out];
  const cases = [
    { args: ['--production'] }, { args: ['--emulator', '127.0.0.1:5003'] },
    { args: ['--rtdb-emulator'], env: { USER_STORAGE_BACKEND: 'unknown' } },
    { args: ['--rtdb-emulator'], env: { GCLOUD_PROJECT: 'ygo-synapse' } },
    { args: ['--rtdb-emulator'], env: { NODE_ENV: 'production' } },
    { args: ['--rtdb-emulator'], env: { USER_DATABASE_URL: 'http://emulators:9000?ns=other-project' } },
  ];
  for (const item of cases) {
    privateOutput(await run([...base, ...item.args], item.env), 1);
    assert.equal(fs.existsSync(out), false);
    assert.equal(await access.allowsPreflight(origin), false);
  }
});

test('RTDB CLI DB 거부 뒤 안전한 원문 파일을 보존하며 자동 재발급하지 않는다', { timeout: 30000 }, async () => {
  const dir = temp(), out = path.join(dir, 'missing-rotate.json'), id = randomBytes(12).toString('hex');
  const result = await run(['rotate', '--rtdb-emulator', '--apply', '--id', id, '--out', out]);
  privateOutput(result, 1);
  assert.equal(/출력 파일은 보존했습니다/.test(result.stderr), true);
  const key = readKey(out), original = fs.readFileSync(out, 'utf8');
  assert.equal(key.id, id);
  await assert.rejects(access.authenticate(key.apiKey), { code: 'API_KEY_INVALID' });
  privateOutput(await run(['rotate', '--rtdb-emulator', '--apply', '--id', id, '--out', out]), 1);
  assert.equal(fs.readFileSync(out, 'utf8') === original, true);
  await assert.rejects(access.authenticate(key.apiKey), { code: 'API_KEY_INVALID' });
});
