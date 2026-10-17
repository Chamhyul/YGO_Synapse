'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { getApps } = require('firebase-admin/app');
const { readSourceFile } = require('./sourceFile');
const { createUserStorageConnection } = require('../config/userStorage');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');

// HTTP·RTDB·저장 coordinator·라우트·mutator는 실제 구현이다. 운영 인증/카드
// 조회/Firestore/Storage는 명시적 합성 경계이며 실제 계정 검증을 주장하지 않는다.
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
const headPath = uid => `inventories/${encodeKey(uid)}`;
const versionsPath = uid => `inventoryCardVersions/${encodeKey(uid)}`;
const cardHash = number => `h${createHash('sha256').update(JSON.stringify(number)).digest('base64url')}`;
const rawHead = async uid => (await main.database.ref(headPath(uid)).get()).val();
const rawVersions = async uid => (await main.database.ref(versionsPath(uid)).get()).val();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const clone = value => JSON.parse(JSON.stringify(value));

function loadSource(relative, mocks, environment) {
  const filename = path.join(__dirname, '..', relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${relative}: ${name}`);
    return typeof mocks[name] === 'function' && mocks[name].lazyFixture
      ? mocks[name]() : mocks[name];
  };
  // Storage 비교 fixture만 독립적인 process.env를 주입한다. 실제 RTDB
  // 연결 설정이나 병렬 HTTP 요청의 전역 환경은 변경하지 않는다.
  const source = readSourceFile(filename, 'utf8');
  loaded._compile(environment ? `const process = { env: ${JSON.stringify(environment)} };\n${source}` : source, filename);
  return loaded.exports;
}
const lazy = factory => Object.assign(factory, { lazyFixture: true });

function instrument(database, hook = (_event, invoke) => invoke()) {
  const events = [];
  const wrap = (ref, refPath) => new Proxy(ref, {
    get(target, key) {
      if (key === 'child') return child => wrap(target.child(child), [refPath, child].filter(Boolean).join('/'));
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['get', 'once', 'on', 'off', 'set', 'update', 'remove', 'transaction'].includes(key)) return value.bind(target);
      return (...args) => {
        const event = { method: key, path: refPath, args };
        events.push(event);
        return hook(event, () => value.apply(target, args));
      };
    },
  });
  return { events, database: new Proxy(database, {
    get(target, key) {
      if (key === 'ref') return (refPath = '') => wrap(target.ref(refPath), refPath.replace(/^\/|\/$/g, ''));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}

async function harness({ hook, resolveCid = async number => number === 'CARD-A' ? 'cid-A' : null,
  profiles = new Map(), legacyStorage } = {}) {
  const tracked = instrument(open().database, hook);
  const inventory = createPartitionedInventoryStore({ database: tracked.database });
  let facade;
  const lookupCalls = [];
  const lookup = {
    resolveCardNumber: async number => number,
    resolveInventoryCid: async (number, name) => { lookupCalls.push(number); return resolveCid(number, name); },
    getCardByCid: async cid => cid === 'cid-A' ? { cid, data: { numbers: ['CARD-A'], names: ['푸른眼 Dragon'] } } : null,
    normalizeNumber: number => String(number).trim().toUpperCase(),
    mapLimited: async (items, action) => Promise.all(items.map(action)),
    findCard() { assert.fail('운영 카드 조회 금지'); },
  };
  const migration = loadSource('services/inventoryMigrationService.js', {
    './inventoryCardLookup': lookup,
    '../utils/common': { normalizeText: value => String(value).trim().toLowerCase() },
    'node:timers': require('node:timers'),
    '../utils/inventoryStorage': lazy(() => facade),
  });
  const { createRtdbInventoryRepository } = require('../services/inventoryRepository');
  const repository = createRtdbInventoryRepository({ storage: { inventory }, migration });
  const firebase = {
    admin: { storage() {
      if (legacyStorage) return legacyStorage;
      assert.fail('RTDB 요청에서 기존 Storage 접근 금지');
    } },
    db: { collection: collection => {
      assert.equal(collection, 'users');
      return { doc: uid => ({
        get: async () => ({ exists: profiles.has(uid), data: () => clone(profiles.get(uid)) }),
        set() { assert.fail('인벤토리 요청에서 프로필 변경 금지'); },
      }) };
    } },
  };
  facade = loadSource('utils/inventoryStorage.js', {
    '../config/firebase': firebase,
    '../services/inventoryMigrationService': migration,
    '../services/inventoryRepository': { getRtdbInventoryRepository: () => repository },
  }, legacyStorage ? { USER_STORAGE_BACKEND: 'storage' } : undefined);
  const verifyAppCheck = async (req, res) => {
    if (req.headers['x-firebase-appcheck'] !== 'synthetic-appcheck') {
      res.status(401).json({ success: false, code: 'APPCHECK_INVALID' });
      return false;
    }
    return true;
  };
  const auth = {
    setCors() {}, verifyAppCheck,
    verifyRegisteredUser: async (req, res) => {
      if (!await verifyAppCheck(req, res)) return null;
      const match = /^Bearer synthetic:([a-zA-Z0-9_-]+)$/.exec(req.headers.authorization || '');
      if (!match) { res.status(401).json({ success: false, code: 'AUTH_INVALID' }); return null; }
      if (match[1] === 'unregistered') {
        res.status(403).json({ success: false, code: 'REGISTRATION_REQUIRED' }); return null;
      }
      return match[1];
    },
    getVerifiedAccountRole: async () => 'none',
  };
  const common = {
    'firebase-functions/v2/https': { onRequest: (_options, handler) =>
      Object.assign(handler, { __endpoint: { httpsTrigger: {} } }) },
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../utils/auth': auth,
    '../utils/inventoryStorage': facade,
    '../services/inventoryMigrationService': migration,
    '../services/inventoryCardLookup': lookup,
  };
  const inventoryRoutes = loadSource('routes/inventory.js', common);
  const importRoutes = loadSource('routes/migration.js', { ...common,
    '../services/migrationService': loadSource('services/migrationService.js', {
      '../integrations/googleSheets': {}, 'node:crypto': require('node:crypto'),
    }),
    '../integrations/googleSheets': { sheetsIsValidSpreadsheetId: () => false },
    '../utils/safeError': require('../utils/safeError'),
  });
  const userRoutes = loadSource('routes/user.js', { ...common,
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
    '../services/user-storage/membershipStore': require('../services/user-storage/membershipStore'),
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    '../services/userProfileRepository': { getUserProfileRepository: () =>
      require('../services/userProfileRepository').createFirestoreUserProfileRepository(firebase) },
  });
  const routes = { ...inventoryRoutes, ...importRoutes,
    getUserData: userRoutes.getUserData, clearUserData: userRoutes.clearUserData };
  const { createMainApp } = loadSource('server.js', { express: require('express'), './index': routes });
  const server = createMainApp({ GCLOUD_PROJECT: 'demo-user-storage', STORAGE_BUCKET: 'synthetic-only.invalid' })
    .listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  async function call(name, uid, body = {}, options = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${name}`, {
      method: options.method || 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'synthetic-appcheck',
        Authorization: `Bearer synthetic:${uid}`, ...options.headers },
      ...(['OPTIONS', 'GET'].includes(options.method) ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status,
      body: response.status === 204 ? null : await response.json() };
    if (options.expectedStatus !== undefined) assert.equal(result.status, options.expectedStatus, JSON.stringify(result.body));
    return result;
  }
  async function ok(name, uid, body = {}) {
    const response = await call(name, uid, body, { expectedStatus: 200 });
    assert.equal(response.body.success, true);
    return response.body;
  }
  return { call, ok, facade, repository, inventory, tracked, lookupCalls, profiles };
}

const addBody = (number = 'CARD-A', qty = 1, loc = '보관.#/[]$') => ({ rows: [
  [number === 'CARD-A' ? '푸른眼 Dragon' : `합성 ${number}`, number, 'N', qty, loc, '1'],
] });
const readsCard = (events, number) => events.some(event =>
  event.path.includes(`/${cardHash(number)}/`) && ['get', 'once', 'on'].includes(event.method));
const isStage = (event, uid) => event.path.startsWith(`${versionsPath(uid)}/`)
  && event.method === 'transaction' && event.args[0](null)?.type !== 'inventory-stage-closed';

test('HTTP 추가·이동·제거·가져오기·전체 조회·초기화가 기존 7열과 집계·CID·문자열을 유지한다', { timeout: 30000 }, async () => {
  const app = await harness(), uid = 'http-contract-synthetic';
  const added = await app.ok('addCards', uid, { rows: [
    ['푸른眼 Dragon', 'CARD-A', 'N', 3, '보관.#/[]$', '1', 'cid-A'],
    ['龍のカード', 'CARD-B', 'UR.$', 2, '棚😀', 'unknown'],
    ['푸른眼 Dragon', 'CARD-A', 'N', 1, '보관.#/[]$', '1'],
    ['오류', 'INVALID', 'N', -1, '무시', '1'],
  ] });
  assert.deepEqual(Object.keys(added).sort(), ['success', 'updatedItems', 'operationResults',
    'inventoryVersion', 'inventoryMigration', 'amount', 'locations', 'rarities'].sort());
  assert.equal(added.amount, 6);
  assert.deepEqual(added.operationResults.map(item => [item.requestIndex, item.status, item.qty]),
    [[3, 'fail', 0], [0, 'success', 3], [2, 'success', 1], [1, 'success', 2]]);
  assert.deepEqual(added.inventoryMigration, { status: 'complete', pendingCount: 0, unresolvedCount: 1, retryAt: 0 });
  const moved = await app.ok('moveCards', uid, { moves: [{ cardNo: 'CARD-A', rarity: 'N', illustration: '1',
    currentLoc: '보관.#/[]$', targetLoc: '移動箱', moveQty: 1 }] });
  assert.equal(moved.amount, 6);
  assert.deepEqual(moved.updatedItems.map(row => [row.loc, row.qty]), [['보관.#/[]$', 3], ['移動箱', 1]]);
  const discarded = await app.ok('discardCards', uid, { discards: [{ cardNo: 'CARD-A', rarity: 'N', illustration: '1',
    loc: '보관.#/[]$', qty: 2 }] });
  assert.equal(discarded.amount, 4);
  assert.deepEqual(discarded.rarities, { N: 2, 'UR.$': 2 });
  const imported = await app.ok('migrateFromData', uid, { data: [
    { name: '푸른眼 Dragon', no: 'CARD-A', rare: 'N', qty: 2, loc: '보관.#/[]$', illust: '1' },
    { name: 'Import 合成', no: 'CARD-C', rare: '', qty: 1, loc: '', illust: '' },
  ] });
  assert.equal(imported.importedCount, 2);
  assert.equal(imported.importedQty, 3);
  const user = await app.ok('getUserData', uid);
  assert.equal(user.amount, 7);
  assert.deepEqual(user.rarities, { N: 4, 'UR.$': 2, 기본: 1 });
  assert.deepEqual(user.locations, { '보관.#/[]$': ['CARD-A'], '移動箱': ['CARD-A'], '棚😀': ['CARD-B'], 미보관: ['CARD-C'] });
  assert.deepEqual(user.allCards, [
    ['푸른眼 Dragon', 'CARD-A', 'N', 3, '보관.#/[]$', '1', 'cid-A'],
    ['푸른眼 Dragon', 'CARD-A', 'N', 1, '移動箱', '1', 'cid-A'],
    ['龍のカード', 'CARD-B', 'UR.$', 2, '棚😀', 'unknown', null],
    ['Import 合成', 'CARD-C', '기본', 1, '미보관', '1', null],
  ]);
  assert.equal(user.inventoryVersion, 3);
  assert.equal(user.inventoryMigration.unresolvedCount, 2);
  assert.ok(user.allCards.every(row => row.length === 7 && typeof row[4] === 'string'));
  assert.equal(Object.hasOwn(user, 'locationNames'), false);
  await app.ok('clearUserData', uid);
  assert.equal((await rawHead(uid)).tombstone, true);
  const empty = await app.ok('getUserData', uid);
  assert.equal(empty.amount, 0);
  assert.deepEqual(empty.allCards, []);
  assert.equal(getApps().some(app => app.name === '[DEFAULT]'), false);
});

test('HTTP 카드별 변경은 다른 카드 본문을 읽지 않고 전체 집계와 미확정 CID 개수를 응답한다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'http-selected-synthetic';
  await app.ok('addCards', uid, { rows: [
    ...addBody('CARD-A', 2).rows, ...addBody('CARD-B', 5, '다른 위치').rows,
  ] });
  const before = await rawHead(uid);
  app.tracked.events.length = 0;
  app.lookupCalls.length = 0;
  const added = await app.ok('addCards', uid, addBody('CARD-A', 3, '다른 위치'));
  assert.equal(added.amount, 10);
  assert.deepEqual(added.rarities, { N: 10 });
  assert.deepEqual(added.locations['다른 위치'], ['CARD-B', 'CARD-A']);
  assert.equal(added.inventoryMigration.unresolvedCount, 1);
  assert.equal(readsCard(app.tracked.events, 'CARD-B'), false, '변경하지 않은 카드 본문을 읽으면 안 된다');
  assert.equal(app.lookupCalls.includes('CARD-B'), false);
  assert.deepEqual((await rawHead(uid)).payload.cards[cardHash('CARD-B')], before.payload.cards[cardHash('CARD-B')]);
  app.tracked.events.length = 0;
  const removed = await app.ok('discardCards', uid, { discards: [
    { cardNo: 'CARD-A', rarity: 'N', illustration: '1', loc: '보관.#/[]$', qty: 2 },
    { cardNo: 'CARD-A', rarity: 'N', illustration: '1', loc: '다른 위치', qty: 3 },
  ] });
  assert.equal(removed.amount, 5);
  assert.deepEqual(removed.locations, { '다른 위치': ['CARD-B'] });
  assert.equal(removed.inventoryMigration.unresolvedCount, 1);
  assert.equal(readsCard(app.tracked.events, 'CARD-B'), false);
});

test('HTTP 마지막 카드 제거 뒤 GET은 rarity 0을 응답에서만 숨기고 재저장하지 않는다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'http-discard-readonly-synthetic';
  await app.ok('addCards', uid, addBody('CARD-A', 1));
  const removed = await app.ok('discardCards', uid, { discards: [
    { cardNo: 'CARD-A', rarity: 'N', illustration: '1', loc: '보관.#/[]$', qty: 1 },
  ] });
  assert.equal(removed.amount, 0);
  assert.deepEqual(removed.rarities, { N: 0 }, '기존 변경 API 응답의 rarity 0을 보존한다');
  assert.deepEqual((await app.inventory.read(uid)).value.rarities, { N: 0 });
  const before = await rawHead(uid), versions = await rawVersions(uid);
  app.tracked.events.length = 0;
  for (let index = 0; index < 2; index++) {
    const { body } = await app.call('getUserData', uid, {}, { method: 'GET', expectedStatus: 200 });
    assert.equal(body.success, true);
    assert.equal(body.amount, 0);
    assert.deepEqual(body.rarities, {});
    assert.deepEqual(body.locations, {});
    assert.deepEqual(body.allCards, []);
    assert.equal(body.inventoryMigration.status, 'complete');
  }
  assert.deepEqual(app.tracked.events.filter(event => ['set', 'update', 'remove', 'transaction'].includes(event.method)), []);
  assert.deepEqual(await rawHead(uid), before, '조회는 revision·영수증·집계 원본을 바꾸지 않는다');
  assert.deepEqual(await rawVersions(uid), versions);
});

test('HTTP GET의 과거 배열형 집계 교정은 유지하고 다음 조회는 재저장하지 않는다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'http-array-summary-synthetic';
  await app.inventory.update(uid, value => {
    Object.assign(value, { version: 3, amount: 0, cards: {}, locations: [], rarities: [] });
  });
  const before = await rawHead(uid), versions = await rawVersions(uid);
  const first = await app.call('getUserData', uid, {}, { method: 'GET', expectedStatus: 200 });
  assert.deepEqual(first.body.locations, {});
  assert.deepEqual(first.body.rarities, {});
  const corrected = (await app.inventory.read(uid)).value, after = await rawHead(uid);
  assert.deepEqual(corrected.locations, {});
  assert.deepEqual(corrected.rarities, {});
  assert.ok(after.revision > before.revision, '배열형 집계는 기존 조건부 저장 경로에서 교정한다');
  assert.deepEqual(await rawVersions(uid), versions);
  app.tracked.events.length = 0;
  const second = await app.call('getUserData', uid, {}, { method: 'GET', expectedStatus: 200 });
  assert.deepEqual(second.body.locations, {});
  assert.deepEqual(second.body.rarities, {});
  assert.deepEqual(app.tracked.events.filter(event => ['set', 'update', 'remove', 'transaction'].includes(event.method)), []);
  assert.deepEqual(await rawHead(uid), after);
});

test('GET 응답용 집계 정리는 공유 snapshot을 변경하지 않고 양수·특수 이름을 보존한다', async () => {
  const rarities = Object.freeze(Object.fromEntries([['N', 0], ['과거 음수', -1], ['__proto__', 2]]));
  const inventory = Object.freeze({ version: 3, amount: 2, cards: Object.freeze({}),
    locations: Object.freeze({}), rarities });
  const routes = loadSource('routes/user.js', {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
    '../services/userProfileRepository': { getUserProfileRepository: () => ({ read: async () => ({ exists: false }) }) },
    '../utils/auth': { setCors() {}, verifyRegisteredUser: async () => 'shared-read-synthetic', getVerifiedAccountRole: async () => 'none' },
    '../utils/inventoryStorage': { updateInventoryWithRetry() { assert.fail('표시용 집계 필터의 저장 금지'); } },
    '../services/inventoryMigrationService': { ensureInventoryV2: async () => inventory,
      inventoryMigrationStatus: () => ({ status: 'complete' }) },
  }, { USER_STORAGE_BACKEND: 'rtdb' });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await routes.getUserData({ method: 'GET', query: {}, headers: {} }, response);
  assert.equal(response.code, 200);
  assert.deepEqual(response.body.rarities, Object.fromEntries([['__proto__', 2]]));
  assert.notEqual(response.body.rarities, rarities);
  assert.deepEqual(Object.entries(inventory.rarities), [['N', 0], ['과거 음수', -1], ['__proto__', 2]]);
});

test('HTTP 과거에 허용한 null·빈 레어도와 숫자 보관위치는 전체 경로에서 Storage 응답을 보존한다', { timeout: 30000 }, async () => {
  const records = new Map();
  const legacyStorage = { bucket: () => ({ file: (filePath, pinned = {}) => ({
    async getMetadata() {
      if (!records.has(filePath)) throw Object.assign(new Error('합성 파일 없음'), { code: 404 });
      return [{ generation: records.get(filePath).generation }];
    },
    async download() {
      const record = records.get(filePath);
      assert.equal(pinned.generation, record?.generation);
      return [Buffer.from(record.body)];
    },
    async save(body, options) {
      const current = records.get(filePath);
      assert.equal(String(options.preconditionOpts.ifGenerationMatch), current?.generation || '0');
      records.set(filePath, { body, generation: String(Number(current?.generation || 0) + 1) });
    },
  }) }) };
  const actual = await harness(), legacy = await harness({ legacyStorage });
  const withoutTimes = value => {
    const clean = clone(value);
    delete clean.updatedAt;
    for (const card of Object.values(clean.cards || {})) delete card.cidCheckedAt;
    return clean;
  };
  const scenarios = [
    ['null-number', [{ name: 'addCards', body: { rows: [['합성 특수값', 'CARD-WEIRD', null, 2, 42, '1']] } }]],
    ['move-number', [{ name: 'moveCards', body: { moves: [{ cardNo: 'CARD-A', rarity: 'N', illustration: '1',
      currentLoc: '보관.#/[]$', targetLoc: 7, moveQty: 1 }] } }]],
    ['empty-rarity', [1, 2].map(() => ({ name: 'addCards',
      body: { rows: [['합성 빈 레어도', 'CARD-EMPTY', '', 1, '빈 레어도 위치', '1']] } }))],
  ];
  for (const [label, operations] of scenarios) {
    const uid = `http-unusual-${label}`;
    const seed = { rows: [...addBody('CARD-A', 3).rows, ...addBody('CARD-B', 2, '다른 위치').rows] };
    assert.deepEqual(await actual.ok('addCards', uid, seed), await legacy.ok('addCards', uid, seed));
    for (const { name, body } of operations) {
      actual.tracked.events.length = 0;
      const response = await actual.ok(name, uid, body);
      assert.deepEqual(response, await legacy.ok(name, uid, body));
      assert.equal(readsCard(actual.tracked.events, 'CARD-B'), true, '비정규 입력은 전체 호환 경로를 사용한다');
      assert.deepEqual(withoutTimes((await actual.facade.downloadInventory(uid)).data),
        withoutTimes((await legacy.facade.downloadInventory(uid)).data));
    }
    const actualUser = await actual.ok('getUserData', uid), legacyUser = await legacy.ok('getUserData', uid);
    for (const response of [actualUser, legacyUser]) { delete response.lastUpdated; delete response.debug; }
    assert.deepEqual(actualUser, legacyUser);
  }
  assert.deepEqual(legacy.tracked.events, [], 'Storage 비교 경로는 RTDB를 사용하지 않는다');
});

test('HTTP 인증·App Check 거부와 잘못된 요청은 인벤토리를 읽거나 변경하지 않는다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'http-denied-synthetic';
  await app.ok('addCards', uid, addBody());
  const before = await rawHead(uid), versions = await rawVersions(uid);
  for (const [route, body] of [
    ['addCards', addBody()], ['moveCards', { moves: [] }], ['discardCards', { discards: [] }],
    ['migrateFromData', { data: [] }], ['getUserData', {}], ['clearUserData', {}],
  ]) {
    for (const options of [
      { headers: { Authorization: '' }, expectedStatus: 401 },
      { headers: { Authorization: 'Bearer synthetic:unregistered' }, expectedStatus: 403 },
      { headers: { 'X-Firebase-AppCheck': 'invalid' }, expectedStatus: 401 },
    ]) {
      app.tracked.events.length = 0;
      await app.call(route, uid, body, options);
      assert.deepEqual(app.tracked.events, [], '인증 거부 이후 저장소에 접근하면 안 된다');
    }
  }
  app.tracked.events.length = 0;
  await app.call('addCards', uid, { rows: {} }, { expectedStatus: 400 });
  await app.call('migrateFromData', uid, { data: [{ name: '합성', no: 'A', qty: -1 }] }, { expectedStatus: 400 });
  assert.deepEqual(app.tracked.events, []);
  assert.deepEqual(await rawHead(uid), before);
  assert.deepEqual(await rawVersions(uid), versions);
});

test('HTTP 사용자 경계와 초기화는 다른 인벤토리·프로필을 보존한다', { timeout: 20000 }, async () => {
  const profiles = new Map([['http-user-a', { Nickname: '합성A', settings: { theme: 'dark' }, createdAt: 12345 }],
    ['http-user-b', { Nickname: '합성B', settings: { theme: 'light' } }]]);
  const app = await harness({ profiles }), beforeProfiles = clone([...profiles]);
  await app.ok('addCards', 'http-user-a', addBody('CARD-A', 2));
  await app.ok('addCards', 'http-user-b', addBody('CARD-B', 7));
  const userB = await rawHead('http-user-b');
  const a = await app.ok('getUserData', 'http-user-a');
  assert.equal(a.amount, 2);
  assert.equal(a.nickname, '합성A');
  assert.equal(a.createdAt, 12345);
  assert.equal(a.settings.theme, 'dark');
  await app.ok('clearUserData', 'http-user-a');
  assert.deepEqual(await rawHead('http-user-b'), userB);
  assert.deepEqual(clone([...profiles]), beforeProfiles);
  assert.equal((await app.ok('getUserData', 'http-user-b')).amount, 7);
});

test('HTTP 빈 조회·변경 없는 조회·실패 행은 새 revision과 카드 버전을 만들지 않는다', { timeout: 20000 }, async () => {
  const app = await harness(), uid = 'http-noop-synthetic';
  assert.equal((await app.ok('getUserData', uid)).amount, 0);
  assert.equal(await rawHead(uid), null);
  await app.ok('addCards', uid, addBody('CARD-A', 2));
  const before = await rawHead(uid), versions = await rawVersions(uid);
  await app.ok('getUserData', uid);
  const moved = await app.ok('moveCards', uid, { moves: [
    { cardNo: 'CARD-A', rarity: 'N', illustration: '1', currentLoc: '보관.#/[]$', targetLoc: '보관.#/[]$', moveQty: 1 },
    { cardNo: 'CARD-A', rarity: 'N', illustration: '1', currentLoc: '보관.#/[]$', targetLoc: '새 위치', moveQty: 9 },
  ] });
  assert.deepEqual(moved.operationResults.map(row => row.failReason), ['same_loc', 'insufficient_qty']);
  const invalid = await app.ok('addCards', uid, addBody('CARD-A', -1));
  assert.equal(invalid.operationResults[0].failReason, 'invalid_qty');
  assert.deepEqual(await rawHead(uid), before);
  assert.deepEqual(await rawVersions(uid), versions);
});

test('HTTP 구형 인벤토리는 전체 호환 처리 후 부분 변경을 제공하고 미지의 메타정보를 보존한다', { timeout: 20000 }, async () => {
  const uid = 'http-legacy-synthetic', generic = createRecordStore({ database: main.database, path: 'inventories' });
  await generic.compareAndSet(uid, 0, { version: 1, updatedAt: '과거 합성', amount: 3,
    locations: { '과거 위치': ['CARD-A'], '다른 위치': ['CARD-B'] }, rarities: { N: 3 },
    extra: { text: '원문 보존', empty: [] }, cards: {
      'CARD-A': { name: '푸른眼 Dragon', items: [{ rarity: 'N', qty: 1, loc: '과거 위치', another: '기본' }] },
      'CARD-B': { name: '합성 CARD-B', cid: null, cidCheckedAt: Date.now(),
        items: [{ rarity: 'N', qty: 2, loc: '다른 위치', illustration: '1' }] },
    } });
  const app = await harness();
  const result = await app.ok('addCards', uid, addBody('CARD-A', 2, '과거 위치'));
  assert.equal(result.amount, 5);
  assert.equal(result.inventoryVersion, 3);
  assert.equal(result.inventoryMigration.unresolvedCount, 1);
  assert.equal((await rawHead(uid)).payload.type, 'inventory-parts');
  assert.deepEqual((await app.repository.downloadInventory(uid)).data.extra, { text: '원문 보존', empty: [] });
  app.tracked.events.length = 0;
  await app.ok('addCards', uid, addBody('CARD-A', 1, '과거 위치'));
  assert.equal(readsCard(app.tracked.events, 'CARD-B'), false);
});

test('HTTP CID 조회 실패의 미완료·재시도 상태를 보존하고 전체 조회가 기존 행을 반환한다', { timeout: 20000 }, async () => {
  const uid = 'http-cid-retry-synthetic';
  await createRecordStore({ database: main.database, path: 'inventories' }).compareAndSet(uid, 0, {
    version: 1, amount: 1, locations: { 상자: ['FAIL-CID'] }, rarities: { N: 1 },
    cards: { 'FAIL-CID': { name: '합성 미확정', items: [{ rarity: 'N', qty: 1, loc: '상자', illustration: '1' }] } },
  });
  const app = await harness({ resolveCid: async () => { throw Object.assign(new Error('합성 조회 장애'), { code: 'SYNTHETIC_LOOKUP_FAILURE' }); } });
  const response = await app.ok('getUserData', uid);
  assert.equal(response.inventoryVersion, 1);
  assert.equal(response.inventoryMigration.status, 'retryableError');
  assert.equal(response.inventoryMigration.pendingCount, 1);
  assert.equal(response.inventoryMigration.unresolvedCount, 1);
  assert.ok(response.inventoryMigration.retryAt > Date.now());
  assert.deepEqual(response.allCards, [['합성 미확정', 'FAIL-CID', 'N', 1, '상자', '1', null]]);
  assert.equal((await app.repository.downloadInventory(uid)).data.cards['FAIL-CID'].cid, undefined);
  const beforeRetry = await rawHead(uid), versions = await rawVersions(uid);
  const attempts = app.lookupCalls.length;
  const cooldown = await app.ok('getUserData', uid);
  assert.deepEqual(cooldown.inventoryMigration, response.inventoryMigration);
  assert.equal(app.lookupCalls.length, attempts, 'CID 재시도 유예 중 외부 조회를 반복하면 안 된다');
  assert.deepEqual(await rawHead(uid), beforeRetry, '유예 중 조회는 revision·updatedAt을 바꾸면 안 된다');
  assert.deepEqual(await rawVersions(uid), versions);
});

test('HTTP 미선택 카드의 CID 재조회 기한이 지나면 전체 준비로 전환해 전역 상태를 갱신한다', { timeout: 20000 }, async () => {
  const uid = 'http-expired-cid-synthetic';
  let resolvePreviouslyMissing = false;
  const app = await harness({ resolveCid: async number => number === 'CARD-A' ? 'cid-A'
    : resolvePreviouslyMissing ? 'cid-B' : null });
  await app.ok('addCards', uid, { rows: [
    ...addBody('CARD-A', 2).rows, ...addBody('CARD-B', 5, '다른 위치').rows,
  ] });
  await app.inventory.update(uid, inventory => {
    inventory.cards['CARD-B'].cidCheckedAt = Date.now() - 24 * 60 * 60 * 1000 - 1000;
  });
  resolvePreviouslyMissing = true;
  app.lookupCalls.length = 0;
  app.tracked.events.length = 0;
  const result = await app.ok('addCards', uid, addBody('CARD-A', 1));
  assert.equal(result.amount, 8);
  assert.equal(result.inventoryVersion, 3);
  assert.deepEqual(result.inventoryMigration, { status: 'complete', pendingCount: 0, unresolvedCount: 0, retryAt: 0 });
  assert.ok(app.lookupCalls.includes('CARD-B'), '선택하지 않은 만료 CID도 전체 준비에서 다시 확인해야 한다');
  assert.equal(readsCard(app.tracked.events, 'CARD-B'), true);
  const current = (await app.repository.downloadInventory(uid)).data;
  assert.equal(current.cards['CARD-B'].cid, 'cid-B');
  assert.equal(current.cards['CARD-B'].items[0].qty, 5);
});

test('HTTP 미래 인벤토리 버전은 변경 없이 실패하고 기존 Storage로 우회하지 않는다', { timeout: 20000 }, async () => {
  const uid = 'http-future-synthetic';
  await createRecordStore({ database: main.database, path: 'inventories' }).compareAndSet(uid, 0, {
    version: 99, amount: 1, locations: {}, rarities: {}, cards: {}, preserved: '미래 원문',
  });
  const before = await rawHead(uid), app = await harness();
  await app.call('addCards', uid, addBody(), { expectedStatus: 500 });
  await app.call('getUserData', uid, {}, { expectedStatus: 500 });
  assert.deepEqual(await rawHead(uid), before);
  assert.equal(await rawVersions(uid), null);
});

test('동시에 도착한 HTTP 추가 두 건은 RTDB 충돌 재시도 후 수량을 한 번씩 반영한다', { timeout: 30000 }, async () => {
  const uid = 'http-concurrent-synthetic', gate = deferred();
  let enabled = false, entered = 0;
  const hook = async (event, invoke) => {
    if (enabled && isStage(event, uid) && ++entered <= 2) {
      if (entered === 2) gate.resolve();
      await gate.promise;
    }
    return invoke();
  };
  const first = await harness({ hook }), second = await harness({ hook });
  await first.ok('addCards', uid, addBody('CARD-A', 1));
  const revision = (await rawHead(uid)).revision;
  enabled = true;
  const replies = await Promise.all([
    first.ok('addCards', uid, addBody('CARD-A', 2)),
    second.ok('addCards', uid, addBody('CARD-A', 3)),
  ]);
  assert.ok(entered >= 3, '동일 revision 경쟁의 충돌 재시도가 있어야 한다');
  // 두 업무 확정과 충돌 시도의 취소 fence가 각각 revision을 전진시킨다.
  assert.equal((await rawHead(uid)).revision, revision + 3);
  const final = await first.ok('getUserData', uid);
  assert.equal(final.amount, 6);
  assert.equal(final.allCards[0][3], 6);
  assert.deepEqual(replies.map(reply => reply.operationResults[0].qty).sort(), [2, 3]);
});

test('HTTP 초기화 전에 시작한 추가는 초기화 뒤 과거 인벤토리를 되살리지 않는다', { timeout: 30000 }, async () => {
  const uid = 'http-clear-race-synthetic', staged = deferred(), resume = deferred();
  let enabled = false, paused = false;
  const first = await harness({ hook: async (event, invoke) => {
    if (enabled && !paused && isStage(event, uid)) {
      paused = true; staged.resolve(); await resume.promise;
    }
    return invoke();
  } });
  const second = await harness();
  await first.ok('addCards', uid, addBody('CARD-A', 4));
  enabled = true;
  const pending = first.call('addCards', uid, addBody('CARD-A', 2), { expectedStatus: 500 });
  await staged.promise;
  try { await second.ok('clearUserData', uid); }
  finally { resume.resolve(); }
  const rejected = await pending;
  assert.equal(rejected.body.success, false);
  const head = await rawHead(uid);
  assert.equal(head.tombstone, true);
  assert.equal(head.generation, 1);
  assert.equal((await second.ok('getUserData', uid)).amount, 0);
});
