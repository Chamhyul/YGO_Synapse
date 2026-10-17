'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { resolveRtdbConfig } = require('../config/userStorage');
function load(env, mocks) {
  const filename = path.join(__dirname, '../services/membershipCsvRepository.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.environment = env;
  loaded.require = name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; };
  loaded._compile(`const process = { env: module.environment };\n${fs.readFileSync(filename, 'utf8')}`, filename);
  return loaded.exports;
}
const methods = ['read', 'readMember', 'status', 'begin', 'stage', 'commit', 'fail', 'expire'];
const demo = () => ({ USER_STORAGE_BACKEND: 'rtdb', NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-csv',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000/?ns=demo-csv-default-rtdb' });
test('CSV selector는 storage와 RTDB에서 같은 인터페이스를 유지하며 호출마다 선택을 재검사한다', async () => {
  for (const backend of [undefined, '', 'storage', 'rtdb']) {
    const env = { ...demo(), USER_STORAGE_BACKEND: backend }, calls = [], db = {};
    const store = Object.fromEntries(methods.map(method => [method, async (...args) => { calls.push([method, ...args]); return method; }]));
    let legacy = 0, checks = 0;
    const repo = load(env, {
      './membershipCsvService': { createFirestoreMembershipCsvStore(actual) { assert.equal(actual, db); legacy++; return store; } },
      './userStorageRuntime': { getRtdbUserStorage() { resolveRtdbConfig(env); checks++; return { membershipCsv: store }; } },
    }).getMembershipCsvStore({ db });
    for (const method of methods) assert.equal(await repo[method]('synthetic'), method);
    assert.equal(legacy, backend === 'rtdb' ? 0 : 1);
    assert.equal(checks, backend === 'rtdb' ? methods.length + 1 : 0);
    env.USER_STORAGE_BACKEND = backend === 'rtdb' ? 'storage' : 'rtdb';
    for (const method of methods) await assert.rejects(repo[method](), { code: 'USER_STORAGE_CONFIG_INVALID' });
    assert.equal(calls.length, methods.length);
  }
});
test('CSV selector는 없는 RTDB 저장소·잘못된 설정을 Firestore로 대체하지 않는다', () => {
  assert.throws(() => load({ USER_STORAGE_BACKEND: 'unknown' }, {}).getMembershipCsvStore(), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.throws(() => load(demo(), { './userStorageRuntime': { getRtdbUserStorage: () => ({}) } }).getMembershipCsvStore(), { code: 'USER_STORAGE_CONFIG_INVALID' });
  const env = { ...demo(), NODE_ENV: 'production' };
  assert.throws(() => load(env, { './userStorageRuntime': { getRtdbUserStorage() { resolveRtdbConfig(env); } } }).getMembershipCsvStore(), { code: 'USER_STORAGE_CONFIG_INVALID' });
});
