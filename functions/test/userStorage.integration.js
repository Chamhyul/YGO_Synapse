'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { getApps } = require('firebase-admin/app');
const { Timestamp } = require('firebase-admin/firestore');
const { createUserStorageConnection } = require('../config/userStorage');
const { createEmulatorUserStorage } = require('../services/user-storage');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createInventoryStore } = require('../services/user-storage/inventoryStore');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { encodeKey } = require('../services/user-storage/codec');

const opened = [];
const open = () => { const connection = createUserStorageConnection(); opened.push(connection); return connection; };
const main = open();
const inventory = connection => createInventoryStore({ database: connection.database });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
after(async () => { await Promise.all(opened.map(connection => connection.close())); });

// 실제 mutator/라우트 소스를 같은 JS realm에서 사용한다. 인증·카드 조회·기존
// Storage 의존성만 합성 주입하며 기본 Firebase 앱이나 외부 연결을 만들지 않는다.
function loadLegacy(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = name => {
    // 고정 계측 모듈은 SDK·운영 연결 없이 실제 구현을 사용한다.
    if (name === '../services/inventoryRequestTiming') return require('../services/inventoryRequestTiming');
    assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${name}`);
    return mocks[name];
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
const legacyMigration = loadLegacy('services/inventoryMigrationService.js', {
  './inventoryCardLookup': {}, '../utils/common': {}, 'node:timers': require('node:timers'),
});
const mutators = loadLegacy('utils/inventoryStorage.js', {
  '../config/firebase': { admin: { storage() { assert.fail('기존 Storage 접근 금지'); } } },
  '../services/inventoryMigrationService': legacyMigration,
});
const rawInventory = async uid => (await main.database.ref(`inventories/${encodeKey(uid)}`).get()).val();
const groups = (number, loc, qty = 1) => ({ [number]: { name: `합성 ${number}`, cid: null,
  items: [{ rarity: 'N', qty, loc, illustration: '1' }] } });
const plain = value => JSON.parse(JSON.stringify(value));

function legacyRoutes(store, uid, { profileValue, membershipClaims = { status: 'pending' } } = {}) {
  const storage = { ...mutators,
    updateInventoryWithRetry: async (id, change) => (await store.update(id, change)).record.value,
    downloadInventory: async id => ({ data: (await store.read(id)).value }),
    deleteInventory: id => store.clear(id),
  };
  const migration = { ...legacyMigration,
    resolveGroupCids: async value => { for (const entry of Object.values(value)) entry.cid = null; },
    ensureInventoryV2: async id => (await store.read(id)).value,
  };
  const auth = { setCors() {}, verifyRegisteredUser: async () => uid,
    getVerifiedAccountRole: async () => 'none', verifyAppCheck: async () => true };
  const common = {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../utils/auth': auth, '../utils/inventoryStorage': storage,
    '../services/inventoryMigrationService': migration,
    '../services/inventoryCardLookup': { resolveCardNumber: async number => number,
      findCard() { assert.fail('운영 카드 조회 금지'); } },
  };
  const routes = loadLegacy('routes/inventory.js', common);
  const imports = loadLegacy('routes/migration.js', { ...common,
    '../services/migrationService': loadLegacy('services/migrationService.js', {
      '../integrations/googleSheets': {}, 'node:crypto': require('node:crypto'),
    }),
    '../integrations/googleSheets': { sheetsIsValidSpreadsheetId: () => false },
    '../utils/safeError': require('../utils/safeError'),
  });
  const user = loadLegacy('routes/user.js', { ...common,
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/membershipClaims': { syncMembershipClaims: async () => membershipClaims },
    '../services/user-storage/membershipStore': require('../services/user-storage/membershipStore'),
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    '../services/userProfileRepository': { getUserProfileRepository: () =>
      require('../services/userProfileRepository').createFirestoreUserProfileRepository({
        db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: !!profileValue, data: () => profileValue }) }) }) },
      }) },
  });
  const handlers = { ...routes, ...imports, getUserData: user.getUserData };
  return async (name, body = {}) => {
    const res = { code: 200, status(value) { this.code = value; return this; },
      json(value) { this.body = value; return this; } };
    await handlers[name]({ method: 'POST', headers: {}, query: {}, body }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    return res.body;
  };
}

test('실제 RTDB 왕복에서 특수 키·빈 값·null·Timestamp 나노초를 보존한다', { timeout: 15000 }, async () => {
  const store = createRecordStore({ database: main.database, path: 'fixtures' });
  const input = {
    '수록.#$/[]': { cid: null, rarities: {}, locations: [], unknown: '원문 유지' },
    timestamp: new Timestamp(1700000000, 123456789), date: new Date('2020-01-01T00:00:00Z'),
    sparse: [, null, {}], empty: '', negativeZero: -0,
  };
  const saved = await store.compareAndSet('합성.user/#', 0, input);
  assert.equal(saved.revision, 1);
  const separate = createRecordStore({ database: open().database, path: 'fixtures' });
  assert.deepEqual((await separate.read('합성.user/#')).value, input);
});

test('프로필 세부 설정 수정이 멤버십·동의와 다른 설정을 보존한다', { timeout: 15000 }, async () => {
  const storage = createEmulatorUserStorage(); opened.push(storage);
  await storage.profile.update('profile-synthetic', {
    membership: { level: 2, expiresAt: null }, consent: { terms: true },
    settings: { theme: 'dark', search: { mode: 'name', language: 'ko' } },
  });
  const updated = await storage.profile.update('profile-synthetic', { settings: { search: { mode: 'cid' } } });
  assert.deepEqual(updated.value.membership, { level: 2, expiresAt: null });
  assert.deepEqual(updated.value.consent, { terms: true });
  assert.deepEqual(updated.value.settings, { theme: 'dark', search: { mode: 'cid', language: 'ko' } });
  await storage.close();
  await assert.rejects(storage.inventory.read('profile-synthetic'), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
});

test('사용자 응답의 원본과 동기화한 claims 버전이 같을 때만 synced를 반환한다', { timeout: 15000 }, async () => {
  const uid = 'membership-version-response-synthetic', store = inventory(main);
  await store.update(uid, value => { mutators.processAddCards(value, groups('CLAIM-VERSION', '합성 위치')); });
  const membership = { status: 'active', type: 'discord', levelName: '대원', discordId: '123456789012345678',
    verificationVersion: 2, verificationProvider: 'discord', lastChecked: 12345678 };
  const version = require('../services/user-storage/membershipStore').membershipPermissionVersion(membership);
  const profileValue = { Nickname: '합성 이름', settings: { theme: 'dark', membership } };
  for (const claimVersion of [version, 'different-source-version']) {
    const call = legacyRoutes(store, uid, { profileValue, membershipClaims: { status: 'synced', version: claimVersion } });
    const response = await call('getUserData');
    assert.deepEqual(response.membershipClaims, claimVersion === version ? { status: 'synced', version } : { status: 'pending' });
    assert.deepEqual(response.sourceMembership, membership); assert.equal(response.settings.membership.levelName, '대원');
    assert.equal(response.settings.theme, 'dark'); assert.equal(response.nickname, '합성 이름'); assert.equal(response.amount, 1);
  }
});

for (const shared of [false, true]) test(`${shared ? '같은' : '독립'} SDK 연결의 동시 추가가 최신 수량을 다시 계산해 모두 반영된다`, { timeout: 20000 }, async () => {
  const firstConnection = open();
  const stores = [inventory(firstConnection), inventory(shared ? firstConnection : open())];
  const uid = shared ? 'concurrent-shared-synthetic' : 'concurrent-synthetic';
  const gate = deferred();
  let entered = 0;
  await Promise.all(stores.map(store => store.update(uid, async (value, meta) => {
    if (meta.attempt === 0) { if (++entered === 2) gate.resolve(); await gate.promise; }
    mutators.processAddCards(value, groups('합성.#카드', '합성 위치'));
    value.cards['합성.#카드'].unknown = '그대로';
    return value.amount;
  })));
  const result = await inventory(main).read(uid);
  assert.equal(result.value.amount, 2);
  assert.equal(result.value.cards['합성.#카드'].cid, null);
  assert.equal(result.revision, 2);
});

test('초기화 중 대기하던 비동기 추가가 과거 인벤토리를 복원하지 않는다', { timeout: 15000 }, async () => {
  const uid = 'clear-synthetic';
  const first = inventory(main), second = inventory(open());
  const storage = createEmulatorUserStorage(); opened.push(storage);
  await storage.profile.update(uid, { nickname: '합성 닉네임', consent: { terms: true } });
  await first.update(uid, value => { mutators.processAddCards(value, groups('CLEAR', '이전 위치', 7)); });
  const entered = deferred(), resume = deferred();
  const pending = second.update(uid, async value => {
    entered.resolve(); await resume.promise; mutators.processAddCards(value, groups('CLEAR', '이전 위치'));
  });
  // 거부 handler를 먼저 연결해 동시성 검사 중 unhandled rejection을 피한다.
  const rejected = assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
  await entered.promise;
  try {
    const cleared = await first.clear(uid);
    assert.equal(cleared.generation, 1);
  } finally { resume.resolve(); }
  await rejected;
  const result = await first.read(uid);
  assert.equal(result.exists, false);
  assert.equal(result.value.amount, 0);
  assert.equal(result.revision, 2);
  assert.equal((await storage.profile.read(uid)).value.nickname, '합성 닉네임');
  await first.update(uid, value => { mutators.processAddCards(value, groups('AFTER-CLEAR', '새 위치')); });
  assert.equal((await first.read(uid)).generation, 1);
  const payload = (await rawInventory(uid)).payload;
  assert.deepEqual(payload.locationNames, { l2: '새 위치' });
  assert.equal(payload.nextLocationId, 3);
});

test('기존 generic 인벤토리는 조회 시 보존하고 변경 시 위치 매핑으로 전환해 순서·중복·원문을 유지한다', { timeout: 15000 }, async () => {
  const uid = 'location-legacy-synthetic';
  const input = { version: 3, updatedAt: '합성 원문 시각', amount: 6,
    locations: { '상자.#/[]$': ['番号/#'], '棚😀': ['番号/#'], '': ['EMPTY'] },
    rarities: { N: 3, 'UR.$': 3 },
    cards: {
      '番号/#': { name: '푸른眼 Dragon', cid: null, cidCheckedAt: 1700000000000,
        items: [{ rarity: 'N', qty: 1, loc: '상자.#/[]$', illustration: '1' },
          { rarity: 'N', qty: 1, loc: '상자.#/[]$', illustration: '1' },
          { rarity: 'UR.$', qty: 3, loc: '棚😀', illustration: '미확인 그림.#/' }],
        unknown: { empty: [], nullable: null } },
      EMPTY: { name: '', cid: null, items: [{ rarity: 'N', qty: 1, loc: '', illustration: '' }] },
    }, extraMetadata: { empty: {}, text: '원문 그대로' } };
  const generic = createRecordStore({ database: main.database, path: 'inventories' });
  await generic.compareAndSet(uid, 0, input);
  const before = await rawInventory(uid);
  const store = createInventoryStore({ database: main.database, now: () => '합성 변경 시각' });
  assert.deepEqual((await store.read(uid)).value, input);
  assert.deepEqual(await rawInventory(uid), before, '조회만으로 기존 generic 레코드를 변환하면 안 된다');
  const outcome = await store.update(uid, () => {});
  assert.deepEqual(outcome.record.value, { ...input, updatedAt: '합성 변경 시각' });
  const payload = (await rawInventory(uid)).payload;
  assert.equal(payload.type, 'inventory');
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.locationNames, { l1: '상자.#/[]$', l2: '棚😀', l3: '' });
  assert.equal(payload.nextLocationId, 4);
  assert.equal(payload.cards.count, 2);
  assert.equal(payload.cards.c0.number, '番号/#');
  assert.equal(payload.cards.c0.cidNull, true);
  assert.equal(payload.cards.c0.items.count, 3);
  assert.deepEqual([payload.cards.c0.items.i0.loc, payload.cards.c0.items.i1.loc, payload.cards.c0.items.i2.loc], [1, 1, 2]);
  for (const field of ['amount', 'locations', 'rarities']) assert.equal(Object.hasOwn(payload, field), false);
  assert.deepEqual((await inventory(open()).read(uid)).value, outcome.record.value);
});

for (const layout of ['legacy', 'partitioned']) test(`기존 추가·이동·제거·가져오기와 사용자 응답이 RTDB 위치 ID를 노출하지 않는다 (${layout})`, { timeout: 20000 }, async () => {
  const uid = `location-api-${layout}-synthetic`;
  const store = layout === 'legacy' ? inventory(main) : createPartitionedInventoryStore({ database: main.database });
  const call = legacyRoutes(store, uid);
  const added = await call('addCards', { rows: [
    ['푸른眼 Dragon', 'CARD-A', 'N', 4, '보관.#/[]$', '1'],
    ['龍のカード', 'CARD-B', 'UR.$', 2, '棚😀', 'unknown'],
  ] });
  assert.deepEqual(Object.keys(added).sort(), ['success', 'updatedItems', 'operationResults', 'inventoryVersion',
    'inventoryMigration', 'amount', 'locations', 'rarities'].sort());
  assert.equal(added.amount, 6);
  assert.deepEqual(added.operationResults.map(row => [row.status, row.qty]), [['success', 4], ['success', 2]]);
  const moved = await call('moveCards', { moves: [{ cardNo: 'CARD-A', rarity: 'N', illustration: '1',
    currentLoc: '보관.#/[]$', targetLoc: '移動箱', moveQty: 1 }] });
  assert.equal(moved.amount, 6);
  assert.deepEqual(moved.updatedItems.map(row => [row.loc, row.qty]), [['보관.#/[]$', 3], ['移動箱', 1]]);
  const discarded = await call('discardCards', { discards: [{ cardNo: 'CARD-A', rarity: 'N', illustration: '1',
    loc: '보관.#/[]$', qty: 2 }] });
  assert.equal(discarded.amount, 4);
  assert.deepEqual(discarded.rarities, { N: 2, 'UR.$': 2 });
  const imported = await call('migrateFromData', { data: [
    { name: '푸른眼 Dragon', no: 'CARD-A', rare: 'N', qty: 2, loc: '보관.#/[]$', illust: '1' },
    { name: 'Import 合成', no: 'CARD-C', rare: '', qty: 1, loc: '', illust: '' },
  ] });
  assert.equal(imported.importedCount, 2);
  assert.equal(imported.importedQty, 3);
  assert.deepEqual(imported.importedItems.map(row => row.loc), ['보관.#/[]$', '미보관']);
  const user = await call('getUserData');
  assert.equal(user.amount, 7);
  assert.deepEqual(user.rarities, { N: 4, 'UR.$': 2, 기본: 1 });
  assert.deepEqual(user.locations, { '보관.#/[]$': ['CARD-A'], '移動箱': ['CARD-A'], '棚😀': ['CARD-B'], 미보관: ['CARD-C'] });
  assert.ok(user.allCards.every(row => row.length === 7 && typeof row[4] === 'string'));
  assert.deepEqual(user.allCards, [
    ['푸른眼 Dragon', 'CARD-A', 'N', 3, '보관.#/[]$', '1', null],
    ['푸른眼 Dragon', 'CARD-A', 'N', 1, '移動箱', '1', null],
    ['龍のカード', 'CARD-B', 'UR.$', 2, '棚😀', 'unknown', null],
    ['Import 合成', 'CARD-C', '기본', 1, '미보관', '1', null],
  ]);
  assert.equal(Object.hasOwn(user, 'locationNames'), false);
  assert.equal(Object.hasOwn(user, 'nextLocationId'), false);
  assert.equal(getApps().some(app => app.name === '[DEFAULT]'), false);
});

test('사용이 끝난 위치 ID의 빈자리를 유지하고 새 위치 및 전체 초기화 후에도 ID를 재사용하지 않는다', { timeout: 15000 }, async () => {
  const uid = 'location-gaps-synthetic', store = inventory(main);
  await store.update(uid, value => {
    for (const [number, loc] of [['A', '첫 위치'], ['B', '두 번째'], ['C', '세 번째']]) mutators.processAddCards(value, groups(number, loc));
  });
  await store.update(uid, value => mutators.processDiscardCards(value,
    [{ cardNo: 'A', rarity: 'N', illustration: '1', loc: '첫 위치', qty: 1 }]));
  let payload = (await rawInventory(uid)).payload;
  assert.deepEqual(payload.locationNames, { l2: '두 번째', l3: '세 번째' });
  assert.equal(payload.nextLocationId, 4);
  await store.update(uid, value => mutators.processAddCards(value, groups('D', '새 위치')));
  payload = (await rawInventory(uid)).payload;
  assert.deepEqual(payload.locationNames, { l2: '두 번째', l3: '세 번째', l4: '새 위치' });
  assert.equal(payload.nextLocationId, 5);
  await store.clear(uid);
  assert.equal((await store.read(uid)).exists, false);
  await store.update(uid, value => mutators.processAddCards(value, groups('E', '초기화 후')));
  payload = (await rawInventory(uid)).payload;
  assert.deepEqual(payload.locationNames, { l5: '초기화 후' });
  assert.equal(payload.nextLocationId, 6);
  assert.equal((await store.read(uid)).generation, 1);
});

test('서로 다른 SDK 연결의 동시 새 위치 추가는 충돌 후 다른 ID를 할당한다', { timeout: 20000 }, async () => {
  const uid = 'location-concurrent-synthetic', stores = [inventory(open()), inventory(open())];
  const gate = deferred(); let entered = 0;
  await Promise.all(stores.map((store, index) => store.update(uid, async (value, meta) => {
    if (meta.attempt === 0) { if (++entered === 2) gate.resolve(); await gate.promise; }
    return mutators.processAddCards(value, groups(`CARD-${index}`, ['한글.# 위치', '日本語/位置😀'][index]));
  })));
  const record = await inventory(main).read(uid), payload = (await rawInventory(uid)).payload;
  assert.equal(record.revision, 2);
  assert.equal(record.value.amount, 2);
  assert.deepEqual(Object.values(payload.locationNames).sort(), ['한글.# 위치', '日本語/位置😀'].sort());
  const ids = [payload.cards.c0.items.i0.loc, payload.cards.c1.items.i0.loc];
  assert.deepEqual(ids.slice().sort(), [1, 2]);
  assert.equal(payload.nextLocationId, 3);
  for (const [number, entry] of Object.entries(record.value.cards)) {
    assert.equal(entry.items[0].loc, number === 'CARD-0' ? '한글.# 위치' : '日本語/位置😀');
  }
});

test('저장된 위치 참조가 손상되면 조회·수정을 거부하고 원본과 revision을 보존한다', { timeout: 15000 }, async () => {
  const uid = 'location-broken-reference-synthetic', store = inventory(main);
  await store.update(uid, value => mutators.processAddCards(value, groups('A', '정상 위치')));
  const broken = plain(await rawInventory(uid));
  broken.payload.cards.c0.items.i0.loc = 999;
  const ref = main.database.ref(`inventories/${encodeKey(uid)}`);
  await ref.set(broken);
  await assert.rejects(store.read(uid), { code: 'user-storage/invalid-inventory-format' });
  let changed = false;
  await assert.rejects(store.update(uid, () => { changed = true; }), { code: 'user-storage/invalid-inventory-format' });
  assert.equal(changed, false);
  assert.deepEqual((await ref.get()).val(), broken);
});

test('새 SDK 연결에서도 기존 revision의 CAS를 처리하고 오래된 쓰기는 거부한다', { timeout: 15000 }, async () => {
  const store = createRecordStore({ database: main.database, path: 'freshConnection' });
  await store.compareAndSet('sample', 0, { amount: 1 });
  const fresh = createRecordStore({ database: open().database, path: 'freshConnection' });
  const result = await fresh.compareAndSet('sample', 1, { amount: 2 });
  assert.equal(result.revision, 2);
  await assert.rejects(store.compareAndSet('sample', 1, { amount: 99 }), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal((await fresh.read('sample')).value.amount, 2);
});

test('미래 인벤토리 버전·손상된 저장 형식을 읽기 오류로 알리고 보존한다', { timeout: 15000 }, async () => {
  const raw = createRecordStore({ database: main.database, path: 'inventories' });
  await raw.compareAndSet('future-synthetic', 0, { version: 4, cards: {} });
  await assert.rejects(inventory(main).update('future-synthetic', value => { value.amount = 0; }), {
    code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION',
  });
  assert.equal((await raw.read('future-synthetic')).revision, 1);
  const ref = main.database.ref(`inventories/${encodeKey('broken-synthetic')}`);
  await ref.set({ format: 999, original: '합성 원본' });
  await assert.rejects(inventory(main).read('broken-synthetic'), { code: 'USER_STORAGE_UNSUPPORTED_FORMAT' });
  assert.deepEqual((await ref.get()).val(), { format: 999, original: '합성 원본' });
});

test('실제 SDK의 최대 깊이·누적 경로 길이를 지키고 초과 값을 저장 전에 거부한다', { timeout: 15000 }, async () => {
  const store = createRecordStore({ database: main.database, path: 'limits' });
  let deepest = '합성';
  for (let i = 0; i < 28; i++) deepest = { a: deepest };
  assert.deepEqual((await store.compareAndSet('depth', 0, deepest)).value, deepest);
  await assert.rejects(store.compareAndSet('depth', 1, { a: deepest }), { code: 'user-storage/depth-exceeded' });
  const within = { ['a'.repeat(500)]: { cid: null } };
  assert.deepEqual((await store.compareAndSet('path', 0, within)).value, within);
  await assert.rejects(store.compareAndSet('path', 1, { ['a'.repeat(575)]: 1 }), { code: 'user-storage/path-too-long' });
  await assert.rejects(store.compareAndSet('path', 1, { ['a'.repeat(300)]: { ['b'.repeat(300)]: 1 } }), {
    code: 'user-storage/path-too-long',
  });
  assert.equal((await store.read('path')).revision, 1);
});

test('직접 클라이언트 REST 읽기·쓰기를 Rules가 거부한다', { timeout: 15000 }, async () => {
  const url = `http://${main.config.emulatorHost}/fixtures.json?ns=${main.config.namespace}`;
  for (const init of [{}, { method: 'PUT', body: JSON.stringify({ denied: true }) }]) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    assert.ok([401, 403].includes(response.status), `예상하지 않은 상태: ${response.status}`);
  }
});

test('연결 해제로 조회가 지연되면 쓰기를 시작하지 않는다', { timeout: 15000 }, async () => {
  const connection = open();
  connection.database.goOffline();
  const store = createRecordStore({ database: connection.database, path: 'unreachable', timeoutMs: 100 });
  await assert.rejects(store.compareAndSet('sample', 0, {}), { code: 'USER_STORAGE_READ_TIMEOUT' });
  await connection.close();
});

test('쓰기 직전 연결을 끊으면 서버 승인 없이 성공하지 않고 연결을 재사용하지 않는다', { timeout: 15000 }, async () => {
  const connection = open();
  let ambiguous = 0;
  // 실제 SDK의 사전 조회 이후, transaction 제출 시점에만 연결 장애를 주입한다.
  const cutConnection = { ref(path) {
    const ref = connection.database.ref(path);
    return {
      get: () => ref.get(), on: (...args) => ref.on(...args), off: (...args) => ref.off(...args),
      transaction: (...args) => { connection.database.goOffline(); return ref.transaction(...args); },
    };
  } };
  const seed = createRecordStore({ database: main.database, path: 'offline' });
  await seed.compareAndSet('sample', 0, { amount: 1 });
  const store = createRecordStore({ database: cutConnection, path: 'offline', timeoutMs: 200,
    onAmbiguousWrite: () => { ambiguous += 1; return connection.close(); } });
  await assert.rejects(store.compareAndSet('sample', 1, { amount: 2 }), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(ambiguous, 1);
  await assert.rejects(store.read('sample'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(getApps().some(app => app.name === '[DEFAULT]'), false);
});
