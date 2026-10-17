'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getMembershipCsvStore } = require('../services/membershipCsvRepository');
const { closeRtdbUserStorage } = require('../services/userStorageRuntime');
const runFile = promisify(execFile), dirs = [];
const script = path.resolve(__dirname, '../../scripts/upload_membership_csv.js');
const store = getMembershipCsvStore();
after(async () => { await closeRtdbUserStorage(); for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const csv = '회원,프로필에 연결,현재 등급\n합성 CSV 도구 회원,https://youtube.com/channel/UC' + 'c'.repeat(22) + ',합성 CSV 등급';
function file() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-csv-')); dirs.push(dir); const result = path.join(dir, 'synthetic.csv'); fs.writeFileSync(result, csv); return result; }
async function run(args, env = {}) {
  try { return { ...(await runFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 })), code: 0 }; }
  catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
}
test('RTDB CSV CLI 합성 적용은 별도 프로세스로 반영하고 원본·보관 폴더를 변경하지 않는다', { timeout: 30000 }, async () => {
  const input = file(), before = await store.read();
  const preview = await run(['--rtdb-emulator', '--dry-run', input]);
  assert.equal(preview.code, 0); assert.equal(fs.readFileSync(input, 'utf8'), csv);
  assert.deepEqual(await store.read(), before);
  const applied = await run(['--rtdb-emulator', input]);
  assert.equal(applied.code, 0, '합성 CSV CLI 종료 코드 확인');
  assert.equal(fs.readFileSync(input, 'utf8'), csv);
  assert.deepEqual((await store.read()).members, [{ channelId: 'UC' + 'c'.repeat(22), memberName: '합성 CSV 도구 회원', levelName: '합성 CSV 등급' }]);
  assert.doesNotMatch(applied.stdout + applied.stderr, /UCc{22}|합성 CSV 도구 회원|CloudStorage/);
});
test('RTDB CSV CLI 모호한 선택·잘못된 운영 설정·CSV는 기존 목록과 원본을 보존한다', { timeout: 30000 }, async () => {
  const input = file(), previous = await store.read();
  for (const spec of [ { args: [input] }, { args: ['--rtdb-production',input] },
    { args: ['--rtdb-emulator',input], env: { NODE_ENV: 'production' } },
    { args: ['--rtdb-emulator',input], env: { USER_DATABASE_URL: 'https://synthetic.invalid' } } ]) {
    assert.equal((await run(spec.args, spec.env)).code, 1);
    assert.deepEqual(await store.read(), previous); assert.equal(fs.readFileSync(input, 'utf8'), csv);
  }
  fs.writeFileSync(input, '회원,프로필에 연결,현재 등급');
  assert.equal((await run(['--rtdb-emulator',input])).code, 1);
  assert.deepEqual(await store.read(), previous); assert.equal(fs.existsSync(input), true);
});
