'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, saveKey } = require('./manage_card_api_keys');
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
