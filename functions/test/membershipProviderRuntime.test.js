'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../services/membershipProviderRuntime');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-membership',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-membership-default-rtdb' };
const response = () => ({ statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; },
  status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } });

test('멤버십 RTDB는 합성 의존성의 명시적 주입과 같은 demo 연결만 허용한다', () => {
  const storage = { membership: {}, config: resolveRtdbConfig(env) };
  for (const options of [{}, { storage }, { rtdbTestDependencies: true }]) {
    assert.throws(() => runtime.resolveMembershipProviderRuntime({ env, ...options }), { code: 'USER_STORAGE_FEATURE_UNAVAILABLE' });
  }
  assert.equal(runtime.resolveMembershipProviderRuntime({ env, storage, rtdbTestDependencies: true }).storage, storage);
  assert.throws(() => runtime.resolveMembershipProviderRuntime({ env, storage: { ...storage, config: { ...storage.config, projectId: 'demo-other' } },
    rtdbTestDependencies: true }), { code: 'USER_STORAGE_FEATURE_UNAVAILABLE' });
  assert.throws(() => runtime.resolveMembershipProviderRuntime({ env: { ...env, USER_STORAGE_MODE: 'production' }, storage,
    rtdbTestDependencies: true }), { code: 'USER_STORAGE_FEATURE_UNAVAILABLE' });
});

test('시험 claim 동기화는 주입 함수 없이 Auth 기본 구현에 접근하지 않는다', async () => {
  const auth = { getUser() { assert.fail('실제 Auth 접근 금지'); }, setCustomUserClaims() { assert.fail('실제 claims 쓰기 금지'); } };
  const context = { config: { mode: 'emulator' }, storage: {} };
  assert.deepEqual(await runtime.syncProviderMembershipClaims('uid', context, auth), { claimsPending: true, membershipClaims: { status: 'pending' } });
  assert.deepEqual(await runtime.syncProviderMembershipClaims('uid', context, auth, async () => ({ status: 'synced', version: 'v1', secret: 'private' })),
    { claimsPending: false, membershipClaims: { status: 'synced', version: 'v1' } });
  const result = await runtime.syncProviderMembershipClaims('uid', context, auth, async () => { throw new Error('private-auth-value'); });
  assert.equal(result.claimsPending, true); assert.doesNotMatch(JSON.stringify(result), /private/);
});

for (const provider of ['discord', 'youtube']) {
  test(`일반 ${provider} export는 시험 RTDB에서 AppCheck·등록 조회·Auth·외부 제공자보다 먼저 거부한다`, async () => {
    const forbidden = () => assert.fail('시험 RTDB export의 실제 인증·프록시 접근 금지');
    const source = fs.readFileSync(path.join(__dirname, `../routes/${provider}Membership.js`), 'utf8');
    const modules = {
      'firebase-functions/v2/https': { onRequest: (_, handler) => handler },
      '../config/firebase': { db: { collection: forbidden }, admin: { auth: forbidden }, DISCORD_CLIENT_ID: 'synthetic',
        DISCORD_GUILD_ID: 'synthetic', DISCORD_CLIENT_SECRET: { value: forbidden } },
      '../services/publicReadTransport': { isLocal: () => false },
      '../utils/auth': { verifyAppCheck: forbidden, verifyRegisteredUser: forbidden, setCors() {} },
      '../services/discordMembershipTransport': { forwardDiscordMembership: forbidden },
      '../services/youtubeMembershipTransport': { forwardYoutubeMembership: forbidden },
      '../integrations/discordMembership': { getDiscordMembershipWithCode: forbidden },
      '../services/discordMembership': require('../services/discordMembership'),
      '../services/youtubeMembership': require('../services/youtubeMembership'),
      '../services/membershipProviderRuntime': { guardMembershipProviderRoute: handler => runtime.guardMembershipProviderRoute(handler, { env }) },
      '../services/inventoryRequestTiming': { withMembershipRequestTiming: (name, handler) => require('../services/inventoryRequestTiming').withMembershipRequestTiming(name, handler, { emit() {} }) },
    };
    const exports = {};
    vm.runInNewContext(source, { exports, require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
    for (const handler of Object.values(exports)) {
      const res = response(); await handler({ method: 'POST', body: {}, headers: {} }, res);
      assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'USER_STORAGE_FEATURE_UNAVAILABLE');
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
  });
}

test('writer 시험 플래그는 일반 멤버십 export를 실제 인증 전에 거부하고 OPTIONS는 보존한다', async () => {
  const writerEnv = { ...env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
    FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' };
  let calls = 0; const handler = runtime.guardMembershipProviderRoute(async () => { calls++; }, { env: writerEnv });
  const res = response(); await handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 503); assert.equal(calls, 0);
  await handler({ method: 'OPTIONS' }, response()); assert.equal(calls, 1);
  assert.throws(() => runtime.resolveMembershipProviderRuntime({ env: writerEnv, rtdbTestDependencies: true, storage: { membership: {} } }), { code: 'USER_STORAGE_FEATURE_UNAVAILABLE' });
});
test('공통 멤버십 native 소스와 claims 장벽을 불러올 수 있다', () => {
  for (const name of ['userMembershipWriterAdapters', 'userMembershipWriterRepository', 'userClaimsWriterStore']) assert.equal(typeof require('../services/' + name), 'object');
});

test('공통 전환에 아직 참여하지 않는 관리자·키·CSV 도구는 시험 플래그를 우회하지 않는다', async () => {
  const env = { USER_PROFILE_WRITER_MODE: 'emulator' }, forbidden = () => assert.fail('공통 전환 우회 금지');
  const res = response();
  assert.equal(await require('../services/adminActionTransport').forwardAdminRequest({ method: 'POST', headers: { authorization: 'Bearer synthetic' } }, res, 'manageAdminRole', { env, fetchImpl: forbidden }), true);
  assert.equal(res.statusCode, 503);
  assert.throws(() => require('../services/adminSessionRepository').validateAdminSessionEnvironment(env), { code: 'USER_STORAGE_CONFIG_INVALID' });
  assert.throws(() => require('../../scripts/upload_membership_csv').validateTarget({ emulator: true }, env));
  assert.throws(() => require('../../scripts/manage_card_api_keys').validateTarget({ rtdbEmulator: true }, env));
});

test('운영 진입 route는 요청별 첫 선택에만 전달하고 다음 route·동시 요청에 재사용하지 않는다', async () => {
  const routes = require('../services/initialWriterRoute');
  let count = 0;
  const transition = { route: async () => ({ backend: 'rtdb', epoch: ++count, phase: 'accepting' }) };
  const storage = { membership: {}, writerTransition: transition }, env = { USER_STORAGE_MODE: 'production' };
  const context = { require: key => key === '../config/userStorage' ? { sameConnectionConfig: () => true }
    : key === './inventoryRequestTiming' ? { measure: (_, work) => work() }
    : key === './initialWriterRoute' ? routes
    : key === '../config/userProfileWriter' ? { resolveProfileWriterConfig: () => ({ mode: 'production' }) }
    : key === './userWriterSelection' ? { selectProductionWriter: () => ({ claimsStorage: storage }) }
    : assert.fail(key), module: { exports: {} } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/membershipProviderRuntime.js'), 'utf8'), context);
  const used = [];
  const handler = context.module.exports.guardMembershipProviderRoute(async () => {
    await Promise.resolve();
    const first = routes.takeInitialWriterRoute(transition); assert(first); used.push(first.epoch);
    assert.equal(routes.takeInitialWriterRoute(transition), undefined);
    const final = await transition.route(); assert(final.epoch > first.epoch);
  }, { env });
  await Promise.all([handler({ method: 'POST' }, response()), handler({ method: 'POST' }, response())]);
  assert.equal(new Set(used).size, 2); assert.equal(count, 4); assert.equal(routes.takeInitialWriterRoute(transition), undefined);
});
