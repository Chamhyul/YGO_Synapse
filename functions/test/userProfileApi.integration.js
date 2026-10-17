'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { getApps } = require('firebase-admin/app');
const { Timestamp } = require('firebase-admin/firestore');
const { readSourceFile } = require('./sourceFile');
const { createUserStorageConnection } = require('../config/userStorage');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { createInventoryStore } = require('../services/user-storage/inventoryStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');

// 실제 Express·라우트·가입 판정·Auth 처리 로직·저장소·RTDB를 연결한다.
// Auth/App Check 토큰 검증 및 카드 조회는 합성 경계다. 운영 계정·Firestore·
// Storage·멤버십 검증 API에는 연결하지 않으며 실제 로그인 검증을 주장하지 않는다.
const connections = [], servers = [];
function open() {
  const connection = createUserStorageConnection();
  connections.push(connection);
  return connection;
}
const main = open();
after(async () => {
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  })));
  await Promise.all(connections.map(connection => connection.close()));
});
const profilePath = uid => `users/${encodeKey(uid)}/profile`;
const inventoryPath = uid => `inventories/${encodeKey(uid)}`;
const rawProfile = async uid => (await main.database.ref(profilePath(uid)).get()).val();
const rawInventory = async uid => (await main.database.ref(inventoryPath(uid)).get()).val();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const lazy = factory => Object.assign(factory, { lazyFixture: true });

function loadSource(relative, mocks, environment) {
  const filename = path.join(__dirname, '..', relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    // 고정 계측 모듈은 SDK·운영 연결 없이 실제 구현을 사용한다.
    if (name === '../services/inventoryRequestTiming') return require('../services/inventoryRequestTiming');
    assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${relative}: ${name}`);
    return typeof mocks[name] === 'function' && mocks[name].lazyFixture ? mocks[name]() : mocks[name];
  };
  const source = readSourceFile(filename, 'utf8');
  loaded._compile(environment ? `const process = { env: ${JSON.stringify(environment)} };\n${source}` : source, filename);
  return loaded.exports;
}

function instrument(database, hook = (_event, invoke) => invoke()) {
  const events = [], proposals = [];
  const wrap = (ref, refPath) => new Proxy(ref, {
    get(target, key) {
      if (key === 'child') return child => wrap(target.child(child), [refPath, child].filter(Boolean).join('/'));
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['get', 'once', 'on', 'off', 'set', 'update', 'remove', 'transaction'].includes(key)) return value.bind(target);
      return (...args) => {
        const event = { method: key, path: refPath };
        events.push(event);
        if (key === 'transaction') {
          const update = args[0];
          args[0] = current => {
            const proposed = update(current);
            if (proposed !== undefined) proposals.push({ path: refPath, value: JSON.parse(JSON.stringify(proposed)) });
            return proposed;
          };
        }
        return hook(event, () => value.apply(target, args));
      };
    },
  });
  return { events, proposals, database: new Proxy(database, {
    get(target, key) {
      if (key === 'ref') return (refPath = '') => wrap(target.ref(refPath), refPath.replace(/^\/|\/$/g, ''));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}

async function harness({ hook, claims = {}, authFailure, roleFailure, repositoryFailure,
  timeoutMs } = {}) {
  const tracked = instrument(open().database, hook);
  const profile = createProfileStore({ database: tracked.database, timeoutMs });
  const inventory = createPartitionedInventoryStore({ database: tracked.database, timeoutMs });
  const { createRtdbUserProfileRepository } = require('../services/userProfileRepository');
  const repository = createRtdbUserProfileRepository({ storage: { profile, inventory } });
  const profileModule = { getUserProfileRepository: () => {
    if (repositoryFailure) throw repositoryFailure;
    return repository;
  } };
  const registration = loadSource('services/registrationService.js', {
    './userProfileRepository': profileModule,
  });
  const authCalls = [], appCheckCalls = [];
  const auth = loadSource('utils/auth.js', {
    '../config/firebase': { admin: {
      auth: () => ({
        verifyIdToken: async (token, checkRevoked) => {
          authCalls.push({ token, checkRevoked });
          if (authFailure) throw authFailure;
          const match = /^synthetic:([a-zA-Z0-9_-]+)$/.exec(token);
          if (!match) throw Object.assign(new Error('합성 무효 토큰'), { code: 'auth/invalid-id-token' });
          return { uid: match[1], role: 'owner' }; // 토큰의 과거 권한을 신뢰하지 않는지 확인한다.
        },
        getUser: async uid => {
          if (roleFailure) throw roleFailure;
          return { uid, customClaims: claims };
        },
      }),
      appCheck: () => ({ verifyToken: async token => {
        appCheckCalls.push(token);
        if (token !== 'synthetic-appcheck') throw Object.assign(new Error('합성 무효 앱 토큰'), {
          code: 'app-check/invalid-argument',
        });
      } }),
    } },
    './safeError': require('../utils/safeError'),
    '../services/publicReadTransport': {
      isLocal: () => false, requestProduction() { assert.fail('운영 인증 API 접근 금지'); },
    },
    '../services/registrationService': registration,
    '../services/membershipPolicy': require('../services/membershipPolicy'),
  }, {});
  let inventoryFacade;
  const lookup = {
    resolveInventoryCid: async () => 'synthetic-cid',
    resolveCardNumber: async number => number,
    normalizeNumber: number => String(number).trim().toUpperCase(),
    mapLimited: async (items, action) => Promise.all(items.map(action)),
    getCardByCid: async () => ({ cid: 'synthetic-cid', data: {} }),
    findCard() { assert.fail('운영 카드 조회 금지'); },
  };
  const migration = loadSource('services/inventoryMigrationService.js', {
    './inventoryCardLookup': lookup,
    '../utils/common': { normalizeText: value => String(value).trim().toLowerCase() },
    'node:timers': require('node:timers'),
    '../utils/inventoryStorage': lazy(() => inventoryFacade),
  });
  const { createRtdbInventoryRepository } = require('../services/inventoryRepository');
  const inventoryRepository = createRtdbInventoryRepository({ storage: { inventory }, migration });
  inventoryFacade = loadSource('utils/inventoryStorage.js', {
    '../config/firebase': { admin: { storage() { assert.fail('기존 Storage 접근 금지'); } } },
    '../services/inventoryMigrationService': migration,
    '../services/inventoryRepository': { getRtdbInventoryRepository: () => inventoryRepository },
  });
  const common = {
    'firebase-functions/v2/https': { onRequest: (_options, handler) =>
      Object.assign(handler, { __endpoint: { httpsTrigger: {} } }) },
    '../utils/auth': auth,
    '../services/userProfileRepository': profileModule,
  };
  const user = loadSource('routes/user.js', { ...common,
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
    '../services/user-storage/membershipStore': require('../services/user-storage/membershipStore'),
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    '../utils/inventoryStorage': inventoryFacade,
    '../services/inventoryMigrationService': migration,
  });
  const registrationRoutes = loadSource('routes/registration.js', { ...common,
    '../services/registrationService': registration,
    '../utils/safeError': require('../utils/safeError'),
  });
  const routes = { ...registrationRoutes,
    getUserData: user.getUserData, clearUserData: user.clearUserData,
    updateUserSettings: user.updateUserSettings, updateNickname: user.updateNickname };
  const { createMainApp } = loadSource('server.js', { express: require('express'), './index': routes });
  const server = createMainApp({ GCLOUD_PROJECT: 'demo-user-storage', STORAGE_BUCKET: 'synthetic-only.invalid' })
    .listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  async function call(name, uid, body = {}, options = {}) {
    const method = options.method || (name === 'getRegistrationStatus' ? 'GET' : 'POST');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${name}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'synthetic-appcheck',
        Authorization: `Bearer synthetic:${uid}`, ...options.headers },
      ...(['GET', 'OPTIONS'].includes(method) ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, headers: response.headers,
      body: response.status === 204 ? null : await response.json() };
    if (options.expectedStatus !== undefined) assert.equal(result.status, options.expectedStatus, JSON.stringify(result.body));
    return result;
  }
  async function ok(name, uid, body = {}, options = {}) {
    const result = await call(name, uid, body, { ...options, expectedStatus: 200 });
    assert.equal(result.body.success, true);
    return result.body;
  }
  async function consent(uid) {
    const { consentVersions } = await ok('getRegistrationStatus', uid);
    return { agreements: { terms: true, privacy: true }, consentVersions };
  }
  return { call, ok, consent, profile, inventory, repository, tracked, authCalls, appCheckCalls };
}

const isWrite = event => ['transaction', 'set', 'update', 'remove'].includes(event.method);
const externalMembership = { status: 'active', type: 'csv', verificationVersion: 2,
  verificationProvider: 'youtube', levelName: '합성 회원', channelId: 'synthetic-channel' };

test('HTTP 신규 가입 조회는 읽기 전용이고 개인 API는 가입 전 403이며 동의 오류도 저장하지 않는다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'profile-new-synthetic';
  const status = await app.call('getRegistrationStatus', uid, {}, { expectedStatus: 200 });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(status.body).sort(), ['success', 'registered', 'consentVersions'].sort());
  assert.equal(status.body.registered, false);
  assert.ok(Object.values(status.body.consentVersions).every(value => /^[a-f0-9]{64}$/.test(value)));
  for (const route of ['getUserData', 'updateUserSettings', 'updateNickname', 'clearUserData']) {
    const response = await app.call(route, uid, { settings: { theme: 'dark' }, nickname: '합성' }, { expectedStatus: 403 });
    assert.equal(response.body.code, 'REGISTRATION_REQUIRED');
  }
  await app.call('completeRegistration', uid, { agreements: { terms: true } }, { expectedStatus: 400 });
  const changed = await app.call('completeRegistration', uid, { agreements: { terms: true, privacy: true },
    consentVersions: { terms: 'old', privacy: 'old' } }, { expectedStatus: 409 });
  assert.equal(changed.body.code, 'CONSENT_VERSION_CHANGED');
  assert.equal(app.tracked.events.some(isWrite), false);
  assert.equal(await rawProfile(uid), null);
  assert.equal(await rawInventory(uid), null);
});

test('HTTP 신규 가입은 RTDB 서버 시각으로 한 번만 저장하며 동시 가입·재요청이 기존 프로필을 보존한다', { timeout: 25000 }, async () => {
  const uid = 'profile-signup-race-synthetic', gate = deferred();
  let entering = 0;
  const hook = async (event, invoke) => {
    if (event.method === 'transaction' && event.path === profilePath(uid) && entering < 2) {
      if (++entering === 2) gate.resolve();
      await gate.promise;
    }
    return invoke();
  };
  const first = await harness({ hook }), second = await harness({ hook });
  const body = await first.consent(uid), beforeTime = Date.now();
  await Promise.all([first.ok('completeRegistration', uid, body), second.ok('completeRegistration', uid, body)]);
  const saved = await first.profile.read(uid), afterTime = Date.now();
  assert.equal(saved.revision, 1);
  assert.equal(saved.value.registration.completed, true);
  assert.equal(saved.value.registration.consent.terms, body.consentVersions.terms);
  assert.equal(saved.value.registration.consent.privacy, body.consentVersions.privacy);
  assert.ok(saved.value.createdAt instanceof Timestamp);
  assert.ok(saved.value.createdAt.toMillis() >= beforeTime - 2000 && saved.value.createdAt.toMillis() <= afterTime + 2000);
  assert.equal(saved.value.registration.consent.acceptedAt.toMillis(), saved.value.createdAt.toMillis());
  assert.ok([...first.tracked.proposals, ...second.tracked.proposals]
    .some(proposal => JSON.stringify(proposal.value).includes('".sv":"timestamp"')),
  '서버 시각 placeholder가 실제 RTDB transaction에 전달되어야 한다');
  assert.equal(JSON.stringify(await rawProfile(uid)).includes('".sv"'), false);
  assert.equal(await rawInventory(uid), null);
  await first.profile.update(uid, { settings: { theme: 'dark', membership: externalMembership }, Nickname: '유지' });
  const beforeRetry = await rawProfile(uid);
  await second.ok('completeRegistration', uid, body);
  assert.deepEqual(await rawProfile(uid), beforeRetry);
});

test('HTTP 기존 프로필·구형 인벤토리만 있는 회원은 동의·가입일을 새로 만들지 않는다', { timeout: 25000 }, async () => {
  const app = await harness(), profileUid = 'profile-legacy-synthetic', inventoryUid = 'profile-inventory-only-synthetic';
  await app.profile.update(profileUid, { Nickname: '기존', settings: { membership: externalMembership }, unknown: { keep: true } });
  const before = await rawProfile(profileUid);
  await app.ok('completeRegistration', profileUid, await app.consent(profileUid));
  assert.deepEqual(await rawProfile(profileUid), before);
  assert.equal((await app.ok('getUserData', profileUid)).createdAt, null);
  const legacy = createInventoryStore({ database: main.database });
  await legacy.update(inventoryUid, value => {
    value.version = 3;
    value.amount = 2;
    value.locations = { '이전 보관': ['CARD-A'] };
    value.rarities = { N: 2 };
    value.cards = { 'CARD-A': { name: '구형 합성', cid: 'synthetic-cid',
      items: [{ rarity: 'N', qty: 2, loc: '이전 보관', illustration: '1' }] } };
  });
  const beforeInventory = await rawInventory(inventoryUid);
  assert.equal((await app.ok('getRegistrationStatus', inventoryUid)).registered, true);
  await app.ok('completeRegistration', inventoryUid, await app.consent(inventoryUid));
  assert.equal(await rawProfile(inventoryUid), null);
  assert.deepEqual(await rawInventory(inventoryUid), beforeInventory);
  await app.ok('updateUserSettings', inventoryUid, { settings: { theme: 'light' } });
  const resulting = await app.profile.read(inventoryUid);
  assert.equal(resulting.value.settings.theme, 'light');
  assert.equal(Object.hasOwn(resulting.value, 'createdAt'), false);
  assert.equal(Object.hasOwn(resulting.value, 'registration'), false);
});

test('HTTP 설정 허용 키·중첩 병합·빈 객체 초기화·null·배열을 유지하고 멤버십·다른 필드는 보존한다', { timeout: 25000 }, async () => {
  const app = await harness(), uid = 'profile-settings-synthetic';
  await app.profile.update(uid, { Nickname: '합성', createdAt: 1000, registration: { completed: true },
    settings: { theme: 'light', readNotices: ['old'], membership: externalMembership,
      onboarding: { page: 1, nested: { keep: true, change: 'old' } } },
    other: { preserve: '原文😀' } });
  const result = await app.ok('updateUserSettings', uid, { uid: 'other-person', settings: {
    theme: 'dark', isDetailMode: true, hideMembershipVerify: false,
    onboarding: { nested: { change: 'new' } },
    membership: { status: 'active', type: 'account', levelName: '소유자' },
    createdAt: 999, unexpected: 'ignored',
  } });
  assert.deepEqual(result, { success: true, message: '설정이 성공적으로 저장되었습니다.' });
  let value = (await app.profile.read(uid)).value;
  assert.deepEqual(value.settings.onboarding, { page: 1, nested: { keep: true, change: 'new' } });
  assert.deepEqual(value.settings.membership, externalMembership);
  assert.equal(value.createdAt, 1000);
  assert.deepEqual(value.other, { preserve: '原文😀' });
  assert.equal(typeof value.settings.updatedAt, 'number');
  assert.equal((await app.ok('getUserData', uid)).createdAt, 1000);
  assert.equal(Object.hasOwn(value.settings, 'createdAt'), false);
  assert.equal(Object.hasOwn(value.settings, 'unexpected'), false);
  await app.ok('updateUserSettings', uid, { settings: { onboarding: {}, readNotices: [], theme: null } });
  value = (await app.profile.read(uid)).value;
  assert.deepEqual(value.settings.onboarding, {});
  assert.deepEqual(value.settings.readNotices, []);
  assert.equal(value.settings.theme, null);
  assert.equal(value.settings.isDetailMode, true);
  assert.deepEqual(value.settings.membership, externalMembership);
  const beforeRejected = await rawProfile(uid);
  for (const settings of [null, 'dark', [], {}, { membership: { status: 'active' } }, { arbitrary: true }]) {
    await app.call('updateUserSettings', uid, { settings }, { expectedStatus: 400 });
  }
  assert.deepEqual(await rawProfile(uid), beforeRejected);
});

test('HTTP 닉네임은 기존 공백·10자·POST 계약을 유지하고 동시 설정 변경을 보존한다', { timeout: 25000 }, async () => {
  const uid = 'profile-nickname-race-synthetic', gate = deferred();
  let entering = 0, active = false;
  const hook = async (event, invoke) => {
    if (active && event.method === 'transaction' && event.path === profilePath(uid) && entering < 2) {
      if (++entering === 2) gate.resolve();
      await gate.promise;
    }
    return invoke();
  };
  const first = await harness({ hook }), second = await harness({ hook });
  await first.profile.update(uid, { Nickname: '이전', settings: { theme: 'light', membership: externalMembership } });
  const before = await rawProfile(uid);
  for (const nickname of ['', '   ', 7, '12345678901']) {
    await first.call('updateNickname', uid, { nickname }, { expectedStatus: 400 });
  }
  await first.call('updateNickname', uid, {}, { method: 'GET', expectedStatus: 405 });
  assert.deepEqual(await rawProfile(uid), before);
  active = true;
  await Promise.all([
    first.ok('updateNickname', uid, { nickname: '  1234567890  ' }),
    second.ok('updateUserSettings', uid, { settings: { theme: 'dark' } }),
  ]);
  const saved = await first.profile.read(uid);
  assert.equal(saved.value.Nickname, '1234567890');
  assert.equal(saved.value.settings.theme, 'dark');
  assert.deepEqual(saved.value.settings.membership, externalMembership);
  assert.ok(saved.value.updatedAt instanceof Timestamp);
  assert.equal(saved.revision, 3);
});

test('HTTP 사용자 조회는 기존 Timestamp·밀리초·7열 재고·현재 계정 권한 응답을 유지하며 초기화는 프로필을 보존한다', { timeout: 25000 }, async () => {
  const app = await harness({ claims: { role: 'admin' } }), uid = 'profile-user-data-synthetic';
  const timestamp = new Timestamp(1700000000, 123456789);
  await app.profile.update(uid, { createdAt: timestamp, Nickname: '合成😀',
    settings: { theme: 'dark', membership: externalMembership } });
  await app.inventory.update(uid, value => {
    value.version = 3;
    value.amount = 3;
    value.locations = { '보관.#/[]$': ['CARD-A'] };
    value.rarities = { N: 3 };
    value.cards = { 'CARD-A': { name: '合成 카드', cid: 'synthetic-cid',
      items: [{ rarity: 'N', qty: 3, loc: '보관.#/[]$', illustration: '1' }] } };
  });
  const profileBefore = await rawProfile(uid), user = await app.ok('getUserData', uid);
  assert.deepEqual(Object.keys(user).sort(), ['success', 'lastUpdated', 'amount', 'locations', 'rarities', 'names',
    'allCards', 'inventoryVersion', 'inventoryMigration', 'settings', 'sourceMembership', 'membershipClaims', 'nickname', 'createdAt', 'debug'].sort());
  assert.deepEqual(user.membershipClaims, { status: 'pending' });
  assert.equal(user.createdAt, timestamp.toDate().getTime());
  assert.equal(user.nickname, '合成😀');
  assert.equal(user.settings.theme, 'dark');
  assert.deepEqual(user.sourceMembership, externalMembership);
  assert.deepEqual(user.settings.membership, { status: 'active', type: 'account', levelName: '관리자', accountRole: 'admin' });
  assert.equal(user.amount, 3);
  assert.deepEqual(user.allCards, [['合成 카드', 'CARD-A', 'N', 3, '보관.#/[]$', '1', 'synthetic-cid']]);
  assert.deepEqual(user.names, ['合成 카드']);
  assert.equal(typeof user.lastUpdated, 'number');
  assert.equal(typeof user.debug.serverTime, 'number');
  await app.ok('clearUserData', uid);
  assert.deepEqual(await rawProfile(uid), profileBefore);
  assert.equal((await rawInventory(uid)).tombstone, true);
  assert.equal((await app.ok('getRegistrationStatus', uid)).registered, true);
  const empty = await app.ok('getUserData', uid);
  assert.deepEqual(empty.allCards, []);
  assert.equal(empty.nickname, '合成😀');
  assert.equal(empty.createdAt, timestamp.toDate().getTime());
  assert.equal(getApps().some(app => app.name === '[DEFAULT]'), false);
});

test('HTTP Auth·App Check 오류·본문 UID 위조를 차단하며 과거 토큰 권한으로 멤버십을 올리지 않는다', { timeout: 25000 }, async () => {
  const app = await harness(), uid = 'profile-auth-synthetic', targetUid = 'profile-auth-target-synthetic';
  await app.profile.update(uid, { Nickname: '본인', settings: { theme: 'light' } });
  await app.profile.update(targetUid, { Nickname: '다른 합성 계정', settings: { theme: 'light' } });
  const targetBefore = await rawProfile(targetUid);
  for (const authorization of ['', 'synthetic:no-bearer', 'Bearer invalid']) {
    const invalid = await app.call('updateNickname', uid, { nickname: '거부' }, {
      headers: { Authorization: authorization }, expectedStatus: 401,
    });
    assert.equal(invalid.body.code, 'AUTH_INVALID');
  }
  for (const route of ['getRegistrationStatus', 'completeRegistration', 'clearUserData']) {
    const missing = await app.call(route, uid, {}, {
      headers: { 'X-Firebase-AppCheck': '' }, expectedStatus: 401,
    });
    assert.equal(missing.body.code, 'APPCHECK_REQUIRED');
    const invalid = await app.call(route, uid, {}, {
      headers: { 'X-Firebase-AppCheck': 'invalid' }, expectedStatus: 401,
    });
    assert.equal(invalid.body.code, 'APPCHECK_INVALID');
  }
  await app.ok('updateNickname', uid, { uid: targetUid, nickname: '본인만 변경' });
  await app.ok('updateUserSettings', uid, { uid: targetUid, settings: { theme: 'dark' } });
  assert.deepEqual(await rawProfile(targetUid), targetBefore);
  assert.equal((await app.profile.read(uid)).value.Nickname, '본인만 변경');
  const current = await app.ok('getUserData', uid);
  assert.deepEqual(current.settings.membership, {
    status: 'none', type: 'none', levelName: '일반', verificationRequired: false,
  });
  assert.ok(app.authCalls.length > 0 && app.authCalls.every(call => call.checkRevoked === true));
  assert.ok(app.appCheckCalls.length > 0);
});

test('HTTP 가입 조회 장애·지원하지 않는 프로필은 503으로 닫고 다른 저장소로 대체하지 않는다', { timeout: 25000 }, async () => {
  const uid = 'profile-malformed-synthetic';
  await createRecordStore({ database: main.database, path: 'users', suffix: 'profile' }).compareAndSet(uid, 0, ['unsupported-profile']);
  const before = await rawProfile(uid), app = await harness();
  await app.call('getRegistrationStatus', uid, {}, { expectedStatus: 503 });
  await app.call('updateUserSettings', uid, { settings: { theme: 'dark' } }, { expectedStatus: 503 });
  await app.call('completeRegistration', uid, { agreements: { terms: true, privacy: true },
    consentVersions: { terms: 'a189fde0dce4ec14f7ae6b8b495674e42b455f1d453d785084ffd5a083dca7ca',
      privacy: '227208e70b6de548fd8e081b50a0b01dd2adc6537d3c8d05fa80e60879ada2e8' } }, { expectedStatus: 503 });
  assert.deepEqual(await rawProfile(uid), before);
  const failed = await harness({ hook: (event, invoke) => {
    if (event.method === 'get' && event.path.startsWith('users/')) {
      return Promise.reject(Object.assign(new Error('합성 읽기 장애'), { code: 'SYNTHETIC_READ_FAILURE' }));
    }
    return invoke();
  } });
  await failed.call('getRegistrationStatus', 'profile-read-failure-synthetic', {}, { expectedStatus: 503 });
  assert.equal(failed.tracked.events.some(isWrite), false);
  const invalidConfig = await harness({ repositoryFailure: Object.assign(new Error('합성 설정 거부'), {
    code: 'USER_STORAGE_CONFIG_INVALID',
  }) });
  await invalidConfig.call('getRegistrationStatus', 'profile-config-failure-synthetic', {}, { expectedStatus: 503 });
  assert.equal(invalidConfig.tracked.events.length, 0);
});

test('HTTP 저장 거부는 기존 프로필을 보존하고 권한 조회 장애는 인벤토리 접근 전에 503을 반환한다', { timeout: 20000 }, async () => {
  const uid = 'profile-write-failure-synthetic';
  let rejectWrites = false;
  const app = await harness({ hook: (event, invoke) => {
    if (rejectWrites && event.method === 'transaction' && event.path === profilePath(uid)) {
      return Promise.reject(Object.assign(new Error('합성 저장 거부'), { code: 'PERMISSION_DENIED' }));
    }
    return invoke();
  } });
  await app.profile.update(uid, { Nickname: '보존', settings: { theme: 'light', membership: externalMembership } });
  const before = await rawProfile(uid);
  rejectWrites = true;
  await app.call('updateUserSettings', uid, { settings: { theme: 'dark' } }, { expectedStatus: 500 });
  await app.call('updateNickname', uid, { nickname: '실패' }, { expectedStatus: 500 });
  assert.deepEqual(await rawProfile(uid), before);
  const denied = await harness({ roleFailure: new Error('합성 권한 조회 장애') });
  const result = await denied.call('getUserData', uid, {}, { expectedStatus: 503 });
  assert.equal(result.body.code, 'ACCOUNT_ROLE_UNAVAILABLE');
  assert.equal(denied.tracked.events.some(event => event.path.startsWith('inventories/')), false);
});
