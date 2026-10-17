'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, validateTarget } = require('./upload_membership_csv');
const demo = { USER_STORAGE_BACKEND: 'rtdb', NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-csv-tool',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-csv-tool-default-rtdb' };
test('CSV CLI는 기존 경로를 보존하고 RTDB 시험을 명시적으로 선택한다', () => {
  assert.deepEqual(parseArgs(['/synthetic.csv']), { csvFilePath: '/synthetic.csv', emulator: false, dryRun: false });
  assert.equal(validateTarget(parseArgs(['/synthetic.csv']), {}).mode, 'legacy');
  const options = parseArgs(['--rtdb-emulator', '--dry-run', '/synthetic.csv']);
  assert.equal(options.emulator, true); assert.equal(options.dryRun, true);
  assert.equal(validateTarget(options, demo).mode, 'emulator');
});
test('CSV CLI는 모호한 선택·운영 URL·production 플래그를 파일/SDK 접근 전에 거부한다', () => {
  for (const args of [[], ['a.csv','b.csv'], ['--production','a.csv'], ['--rtdb-production','a.csv'], ['--dry-run','--dry-run','a.csv']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.throws(() => validateTarget(parseArgs(['a.csv']), demo));
  for (const env of [{...demo,NODE_ENV:'production'}, {...demo, USER_DATABASE_URL:'https://real.firebaseio.com'},
    {...demo,USER_STORAGE_MODE:'production'}, {...demo,GCLOUD_PROJECT:'real-project'}]) {
    assert.throws(() => validateTarget(parseArgs(['--rtdb-emulator','a.csv']), env));
  }
});
test('독립 CSV CLI는 legacy SDK 열린 핸들과 무관하게 성공·실패 코드로 종료하고 import 실행은 종료하지 않는다', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'upload_membership_csv.js'), 'utf8');
  for (const failing of [false, true]) {
    const calls = [], loaded = { exports: {} }; let exited;
    const finished = new Promise(resolve => { exited = resolve; });
    const dependencies = {
      fs: { readFileSync: () => Buffer.from('합성'), existsSync: () => true, copyFileSync: () => calls.push('copy'), unlinkSync: () => calls.push('unlink') },
      path, 'node:crypto': require('node:crypto'),
      '../functions/services/membershipCsvService': {
        membershipCsvParseMembers: () => [{ channelId: 'synthetic' }],
        createMembershipCsvService: () => ({ preview: async () => ({}), apply: async () => { calls.push('apply'); if (failing) throw Error('synthetic'); } }),
      },
      '../functions/node_modules/firebase-admin': { firestore: () => ({}) },
      './cloud_credentials': { initializeDataToolFirebaseApp: () => { calls.push('init'); } },
      '../functions/services/membershipCsvRepository': { getMembershipCsvStore: () => ({}) },
    };
    const requireMock = name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; };
    requireMock.main = loaded;
    vm.runInNewContext(source, { module: loaded, require: requireMock, TextDecoder,
      console: { log() {}, warn() {}, error() {} }, process: { env: {}, argv: ['node', 'cli', '/synthetic.csv'], exit: exited } });
    assert.equal(await finished, failing ? 1 : 0);
    assert.deepEqual(calls, failing ? ['init','apply'] : ['init','apply','copy','unlink']);
  }
});
