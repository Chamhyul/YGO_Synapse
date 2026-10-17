'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { encodeKey } = require('../services/user-storage/codec');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { cardHash } = require('../services/user-storage/inventoryManifest');
const id = () => randomBytes(16).toString('hex');
const fixture = () => ({ version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: 3,
  locations: { '보관함': ['A', 'B'] }, rarities: { SR: 1, N: 2 }, custom: { null: null, empty: [], extra: '유지' },
  cards: {
    A: { name: 'A', cid: "100", items: [{ rarity: 'SR', qty: 1, loc: '보관함', illustration: '1' }] },
    B: { name: 'B', cid: "200", items: [{ rarity: 'N', qty: 2, loc: '보관함', illustration: '1' }] },
  } });
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete', pendingCount: 0, unresolvedCount: 0, retryAt: 0 }) };
const sdkLoadedMemory = { rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS };
async function setup(options = {}, runId = id()) {
  const connection = open(runId);
  const binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, migration, ...options });
  await binding.initialize(); return { ...binding, connection, runId, close: () => connection.close() };
}
async function switchTo(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
test('native 인벤토리 전체·부분 수정·초기화와 프로필은 같은 epoch에서 양방향 전환된다', async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    const initial = (await f.inventoryRepository.downloadInventory('u')).data;
    assert.deepEqual(initial, fixture());
    assert.equal(await f.repository.isRegistered('u'), true);
    await f.repository.completeRegistration('u', { terms: 't', privacy: 'p' });
    assert.equal((await f.repository.read('u')).exists, false);
    await f.inventoryRepository.updateInventoryWithRetry('u', value => { value.custom.extra = '전체 수정'; });
    assert.equal((await switchTo(f)).backend, 'rtdb');
    assert.equal((await f.inventoryRepository.downloadInventory('u')).data.custom.extra, '전체 수정');
    const saved = await f.inventoryRepository.updateInventoryWithRetry('u', value => {
      value.cards.A.name = '부분 수정';
    }, 3, { cardNumbers: ['A'] });
    assert.equal(saved.cards.A.name, '부분 수정'); assert.equal(saved.cards.B, undefined);
    const full = (await f.inventoryRepository.downloadInventory('u')).data;
    assert.equal(full.cards.B.items[0].qty, 2); assert.equal(full.custom.extra, '전체 수정');
    assert.equal((await switchTo(f)).backend, 'legacy');
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, full);
    await f.inventoryRepository.deleteInventory('u');
    assert.equal(await f.repository.isRegistered('u'), false);
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data.cards, {});
    await f.repository.completeRegistration('u', { terms: 't', privacy: 'p' });
    assert.equal((await f.repository.read('u')).value.registration.completed, true);
    await switchTo(f); assert.equal(await f.repository.isRegistered('u'), true);
    assert.equal((await createPartitionedInventoryStore({ database: f.connection.targetDatabase }).readMetadata('u')).exists, false);
  } finally { await f.close(); }
});
test('RTDB 부분 수정은 선택하지 않은 카드 본문을 읽거나 교체하지 않는다', async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    await switchTo(f);
    const untouched = (await f.connection.targetDatabase.ref(`inventories/${encodeKey('u')}/payload/cards/${cardHash('B')}`).get()).val();
    const paths = [], original = f.connection.targetDatabase.ref;
    f.connection.targetDatabase.ref = path => {
      const ref = original(path);
      const get = ref.get.bind(ref); ref.get = () => { paths.push(path); return get(); }; return ref;
    };
    await f.inventoryRepository.updateInventoryWithRetry('u', value => { value.cards.A.name = '선택'; }, 3, { cardNumbers: ['A'] });
    f.connection.targetDatabase.ref = original;
    assert.equal(paths.some(path => path.startsWith('inventoryCardVersions/') && path.includes(cardHash('B'))), false);
    assert.deepEqual((await original(`inventories/${encodeKey('u')}/payload/cards/${cardHash('B')}`).get()).val(), untouched);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 초기화·재생성 뒤 늦은 수정은 인벤토리를 되살리지 않는다`, async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (backend === 'rtdb') await switchTo(f);
    let release, entered; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const pending = f.inventoryRepository.updateInventoryWithRetry('u', async value => { entered(); await gate; value.cards.A.name = '늦은 저장'; });
    await Promise.race([ready, pending.then(() => assert.fail('지연 경계 전에 완료됨'))]); await f.inventoryRepository.deleteInventory('u');
    await f.inventoryRepository.updateInventoryWithRetry('u', value => { Object.assign(value, fixture()); });
    release(); await assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
    assert.equal((await f.inventoryRepository.downloadInventory('u')).data.cards.A.name, 'A');
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 응답 유실은 durable receipt로 포착하며 수량 변경을 재실행하지 않는다`, async () => {
  let lost = true, operationId;
  const f = await setup({ onCheckpoint: async (stage, id) => { if (stage === 'businessCommitted' && lost) { lost = false; operationId = id; throw new Error('합성 ACK 유실'); } } });
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (backend === 'rtdb') await switchTo(f);
    await assert.rejects(f.inventoryRepository.updateInventoryWithRetry('u', value => { value.custom.extra = '한 번'; }), /ACK/);
    assert.equal((await f.transition.inspect()).unresolved, 1);
    await assert.rejects(f.transition.activate(await f.transition.route()), { code: 'WRITER_NOT_DRAINED' });
    await f.transition.recover(operationId);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.equal((await f.inventoryRepository.downloadInventory('u')).data.custom.extra, '한 번');
    await switchTo(f);
  } finally { await f.close(); }
});
test('가입 의존성을 읽은 뒤 인벤토리가 생겨도 같은 UID 자원 확보 후 동의를 꾸며내지 않는다', async () => {
  const f = await setup();
  try {
    const original = f.inventories.legacy.exists; let injected = false;
    f.inventories.legacy.exists = async key => {
      const record = await original(key);
      if (!injected && key === 'u') { injected = true; await f.inventoryRepository.updateInventoryWithRetry('u', value => Object.assign(value, fixture())); }
      return record;
    };
    await f.repository.completeRegistration('u', { terms: 't', privacy: 'p' });
    assert.equal((await f.repository.read('u')).exists, false);
    assert.equal(await f.repository.isRegistered('u'), true);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 제출 중 영구 fence는 이후 commit을 막는다`, async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (backend === 'rtdb') await switchTo(f);
    const current = await f.inventories[backend].read('inventory/u'), writer = await f.transition.route(), operationId = id();
    const op = await f.transition.prepare(writer, operationId, [current], null, { details: { kind: 'inventory', blobs: [] }, resources: ['fs/users/u'] });
    let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const commit = f.stores[backend].commit;
    f.stores[backend].commit = async operation => { entered(); await gate; return commit(operation); };
    const pending = f.transition.execute(writer, operationId); await ready;
    assert.equal((await f.transition.fenceUncommitted(operationId)).status, 'cancelled'); release();
    await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, fixture());
    assert.equal((await f.transition.inspect()).captured, 0);
    await f.inventories[backend].commit(op); // 뒤늦은 중복 제출도 영구 취소 proof를 확인한다.
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, fixture());
  } finally { await f.close(); }
});

test('실제 인벤토리 HTTP 추가·이동·폐기·조회·초기화는 native 전환 전후 응답 계약을 유지한다', async () => {
  const f = await setup(); let server;
  try {
    const Module = require('node:module'), path = require('node:path'), fs = require('node:fs');
    const load = (relative, mocks) => {
      const filename = path.join(__dirname, '..', relative), mod = new Module(filename, module); mod.filename = filename;
      mod.require = name => { if (name === '../services/inventoryRequestTiming') return require('../services/inventoryRequestTiming'); assert.ok(Object.hasOwn(mocks, name), `예상하지 않은 의존성: ${name}`); return mocks[name]; };
      mod._compile(`const process={env:{}};\n${fs.readFileSync(filename, 'utf8')}`, filename); return mod.exports;
    };
    // 업무 라우트/mutator/native DB는 실제 구현, Auth/App Check/카드 검색/claims는 합성 경계다.
    const functions = { onRequest: (_options, handler) => handler };
    const auth = { setCors() {}, verifyUser: async req => req.get('x-synthetic-uid'), getVerifiedAccountRole: async () => 'none', verifyAppCheck: async () => true,
      async verifyRegisteredUser(req, res) { const uid = req.get('x-synthetic-uid');
        if (!await f.repository.isRegistered(uid)) { res.status(403).json({ success: false, code: 'REGISTRATION_REQUIRED' }); return null; } return uid; } };
    const helpers = require('../utils/inventoryStorage');
    const inventory = { ...helpers, ...f.inventoryRepository };
    const api = load('routes/inventory.js', { 'firebase-functions/v2/https': functions,
      '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
      '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler }, '../utils/auth': auth,
      '../utils/inventoryStorage': inventory, '../services/inventoryCardLookup': { resolveCardNumber: async number => number },
      '../services/inventoryMigrationService': { ...migration, resolveGroupCids: async groups => { for (const group of Object.values(groups)) group.cid = '100'; } },
    });
    const user = load('routes/user.js', { 'firebase-functions/v2/https': functions,
      '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
      '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler }, '../utils/auth': auth,
      '../services/userProfileRepository': { getUserProfileRepository: () => f.repository },
      '../services/membershipPolicy': require('../services/membershipPolicy'), '../utils/inventoryStorage': inventory,
      '../services/inventoryMigrationService': { ...migration, ensureInventoryV2: uid => f.inventoryRepository.updateInventoryWithRetry(uid, () => {}) },
      '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
    });
    const express = require('express'), app = express(); app.use(express.json());
    for (const [name, handler] of Object.entries({ ...api, getUserData: user.getUserData, clearUserData: user.clearUserData })) app.all(`/${name}`, (req, res, next) => Promise.resolve(handler(req, res)).catch(next));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    async function call(name, body, method = 'POST') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${name}`, { method,
        headers: { 'content-type': 'application/json', 'x-synthetic-uid': 'http' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    }
    await f.repository.completeRegistration('http', { terms: 't', privacy: 'p' });
    for (const backend of ['legacy', 'rtdb']) {
      if (backend === 'rtdb') await switchTo(f);
      const add = await call('addCards', { rows: [['A', 'A', 'SR', 2, '원래', '1'], ['A', 'A', 'SR', -1, '원래', '1']] });
      assert.equal(add.status, 200); assert.equal(add.body.success, true); assert.equal(add.body.amount, 2);
      assert.deepEqual(add.body.operationResults.map(result => result.status), ['fail', 'success']);
      const move = await call('moveCards', { moves: [{ cardNo: 'A', rarity: 'SR', proc: '1', currentLoc: '원래', targetLoc: '새 위치', moveQty: 1 }] });
      assert.equal(move.status, 200); assert.equal(move.body.amount, 2);
      const discard = await call('discardCards', { discards: [{ cardNo: 'A', rarity: 'SR', proc: '1', loc: '새 위치', qty: 1 }] });
      assert.equal(discard.status, 200); assert.equal(discard.body.amount, 1);
      const read = await call('getUserData', {}, 'GET'); assert.equal(read.status, 200); assert.equal(read.body.amount, 1);
      assert.equal(Array.isArray(read.body.allCards), true); assert.equal(read.body.allCards[0].length, 7);
      const clear = await call('clearUserData', {}); assert.equal(clear.status, 200); assert.equal(clear.body.success, true);
      assert.equal(await f.repository.isRegistered('http'), true); assert.deepEqual((await f.inventoryRepository.downloadInventory('http')).data.cards, {});
    }
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); await f.close();
  }
});

test('실제 시험 selector는 인벤토리 유틸과 가입 의존성까지 연결하고 기본 Firebase app을 열지 않는다', async () => {
  const { spawn } = require('node:child_process');
  const source = `
    const assert=require('node:assert/strict');const load=require('node:module').createRequire(require('node:path').resolve('functions/package.json'));
    const inventory=require('./functions/utils/inventoryStorage');
    const profile=require('./functions/services/userProfileRepository').getUserProfileRepository();
    const runtime=require('./functions/services/userProfileWriterRuntime');
    (async()=>{try{
      assert.equal(load('firebase-admin/app').getApps().some(app=>app.name==='[DEFAULT]'),false);
      await inventory.updateInventoryWithRetry('runtime',value=>Object.assign(value,${JSON.stringify(fixture())}));
      assert.equal(await profile.isRegistered('runtime'),true);
      const f=runtime.getProfileWriterBinding(),writer=await f.transition.route();
      await f.transition.copy(writer);await f.transition.drain(writer);await f.transition.activate(writer);
      await inventory.updateInventoryWithRetry('runtime',value=>{value.cards.A.name='부분';},3,{cardNumbers:['A']});
      assert.equal((await inventory.downloadInventory('runtime')).data.cards.A.name,'부분');
      await inventory.deleteInventory('runtime');assert.equal(await profile.isRegistered('runtime'),false);
      assert.equal(load('firebase-admin/app').getApps().some(app=>app.name==='[DEFAULT]'),false);
      console.log('verified');
    }finally{await runtime.closeProfileWriterRuntime();}})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { cwd: require('node:path').resolve(__dirname, '../..'),
      env: { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: id() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), 'verified');
});

for (const backend of ['legacy', 'rtdb']) test(`${backend} 두 SDK의 인벤토리 공개 중 가입은 같은 UID 자원을 기다린다`, async () => {
  let entered, release, pause = false;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'executing' && pause) { pause = false; entered(); await gate; } } });
  const second = await setup({}, f.runId);
  try {
    if (backend === 'rtdb') await switchTo(f);
    pause = true;
    const inventory = f.inventoryRepository.updateInventoryWithRetry('joined', value => Object.assign(value, fixture()));
    await Promise.race([ready, inventory.then(() => assert.fail('지연 경계 전에 완료됨'))]);
    let finished = false;
    const registration = second.repository.completeRegistration('joined', { terms: 't', privacy: 'p' }).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(finished, false);
    release(); await Promise.all([inventory, registration]);
    assert.equal((await second.repository.read('joined')).exists, false); assert.equal(await second.repository.isRegistered('joined'), true);
  } finally { release(); await Promise.all([f.close(), second.close()]); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 준비 이전의 지연 mutator는 전환 후 다른 epoch로 자동 재전송되지 않는다`, async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (backend === 'rtdb') await switchTo(f);
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const pending = f.inventoryRepository.updateInventoryWithRetry('u', async value => { entered(); await gate; value.cards.A.name = '이전 epoch'; });
    await Promise.race([ready, pending.then(() => assert.fail('지연 경계 전에 완료됨'))]); await switchTo(f); release();
    await assert.rejects(pending, { code: 'WRITER_FENCED' });
    assert.equal((await f.inventoryRepository.downloadInventory('u')).data.cards.A.name, 'A');
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 최초 저장 전 fence는 가입 자료를 만들지 않고 복사·역전환에서도 부재를 보존한다`, async () => {
  const f = await setup();
  try {
    if (backend === 'rtdb') await switchTo(f);
    const { splitStable } = require('../services/userInventoryWriterAdapters');
    const candidate = splitStable(fixture()), operationId = id(), writer = await f.transition.route();
    const op = await f.transition.prepare(writer, operationId, [{ key: 'inventory/empty', exists: true, token: '0',
      value: { exists: true, manifest: candidate.manifest } }], null, { details: { kind: 'inventory', blobs: candidate.blobs.map(({ hash, token, value }) => ({ hash, token, value })) } });
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const commit = f.stores[backend].commit;
    f.stores[backend].commit = async operation => { entered(); await gate; return commit(operation); };
    const pending = f.transition.execute(writer, operationId); await ready;
    await f.transition.fenceUncommitted(operationId); release(); await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
    assert.equal(await f.repository.isRegistered('empty'), false);
    await f.inventories[backend].commit(op);
    await switchTo(f); assert.equal(await f.repository.isRegistered('empty'), false);
    await switchTo(f); assert.equal(await f.repository.isRegistered('empty'), false);
  } finally { await f.close(); }
});

for (const backend of ['legacy', 'rtdb']) test(`${backend} 실제 native CAS 직전 늦은 RPC와 다른 SDK의 fence 중 하나만 반영된다`, async () => {
  const f = await setup(), second = await setup({}, f.runId);
  let release;
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (backend === 'rtdb') await switchTo(f);
    let entered, once = true;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    if (backend === 'legacy') {
      const runTransaction = f.connection.db.runTransaction;
      f.connection.db.runTransaction = callback => runTransaction(async tx => {
        const get = tx.get.bind(tx);
        tx.get = async ref => {
          if (once && ref.path.includes('/inventoryWriterReceipts/')) { once = false; entered(); await gate; }
          return get(ref);
        };
        return callback(tx);
      });
    } else {
      const reference = f.connection.targetDatabase.ref;
      f.connection.targetDatabase.ref = path => {
        const ref = reference(path), transaction = ref.transaction.bind(ref);
        if (path === `inventories/${encodeKey('u')}`) ref.transaction = async (...input) => {
          if (once) { once = false; entered(); await gate; } return transaction(...input);
        }; return ref;
      };
    }
    const pending = f.inventoryRepository.updateInventoryWithRetry('u', value => { value.cards.A.name = '차단할 저장'; });
    await Promise.race([ready, pending.then(() => assert.fail('지연 경계 전에 완료됨'))]);
    const state = (await createWriterJournalStore({ database: second.connection.targetDatabase }).read(f.runId)).value;
    const operation = Object.values(state.operations).find(op => op.status === 'executing'); assert.ok(operation);
    await second.transition.fenceUncommitted(operation.id); release();
    await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
    assert.equal((await second.inventoryRepository.downloadInventory('u')).data.cards.A.name, 'A');
    assert.equal(await second.inventories[backend].cancellationReason(operation), 'fenced');
    await switchTo(second);
  } finally { if (release) release(); await Promise.all([f.close(), second.close()]); }
});
for (const destination of ['rtdb', 'legacy']) test(`${destination} head가 같아도 참조 카드 버전 변조가 있으면 활성화를 거부한다`, async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/u/inventory.json').save(JSON.stringify(fixture()), { resumable: false });
    if (destination === 'legacy') await switchTo(f);
    const writer = await f.transition.route(); await f.transition.copy(writer);
    const target = await f.inventories[destination].read('inventory/u');
    const hash = cardHash('A'), token = target.value.manifest.cards[hash].v;
    const { cardBlobPath } = require('../services/user-storage/inventoryManifest');
    if (destination === 'rtdb') await f.connection.targetDatabase.ref(`${cardBlobPath('u', hash, token)}/name`).set('합성 변조');
    else {
      const file = f.connection.bucket.file(`${cardBlobPath('u', hash, token, { partsPath: 'inventoryWriter/cards' })}.json`);
      const body = JSON.parse((await file.download())[0].toString()); body.name = '합성 변조'; await file.save(JSON.stringify(body), { resumable: false });
    }
    await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'INVENTORY_WRITER_CARD_VERSION_MISMATCH' });
    assert.equal((await f.transition.route()).backend, writer.backend);
  } finally { await f.close(); }
});

// 운영 자료를 사용하지 않는다. 실제 어댑터/SDK를 유지한 채 원본 다운로드와
// 전체 변환 경계만 계측하여 카드별 재다운로드·재변환 회귀를 빠르게 차단한다.
function instrumentedInventoryBinding(options, counts) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  function load(relative, overrides) {
    const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const nativeRequire = loaded.require.bind(loaded);
    loaded.require = name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    return loaded.exports;
  }
  const manifest = require('../services/user-storage/inventoryManifest');
  const adapters = load('../services/userInventoryWriterAdapters.js', {
    './user-storage/inventoryManifest': { ...manifest, splitInventory(...args) {
      counts.split++; assert.ok(counts.split <= 1, '같은 최초 조회에서 원본을 반복 분할하면 안 된다');
      return manifest.splitInventory(...args);
    } },
  });
  const repository = load('../services/userInventoryWriterRepository.js', { './userInventoryWriterAdapters': adapters });
  return repository.createUserInventoryWriterBinding(options);
}

function manyCards(count) {
  const cards = {}, numbers = [];
  for (let index = 0; index < count; index++) {
    const number = `SYNTHETIC-${index}`; numbers.push(number);
    cards[number] = { name: `합성 카드 ${index}`, cid: String(index + 1),
      items: [{ rarity: 'N', qty: 1, loc: '합성 보관함', illustration: '1' }] };
  }
  return { version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: count,
    locations: { '합성 보관함': numbers }, rarities: { N: count }, cards };
}

test('미분할 legacy 최초 조회와 무변경 수정은 1·100·1000카드에서 원본 읽기·분할을 한 번만 수행한다', async t => {
  t.diagnostic(JSON.stringify({ stage: 'cold-sdk-module-load', ...sdkLoadedMemory }));
  for (const count of [1, 100, 1000]) {
    const runId = id(), connection = open(runId);
    const counts = { metadata: 0, download: 0, blobDownload: 0, split: 0, writes: 0 };
    try {
      const expected = manyCards(count), source = 'users/scale/inventory.json';
      await connection.bucket.file(source).save(JSON.stringify(expected), { resumable: false });
      const originalFile = connection.bucket.file.bind(connection.bucket);
      connection.bucket.file = (...args) => {
        const file = originalFile(...args), metadata = file.getMetadata.bind(file), download = file.download.bind(file), save = file.save.bind(file);
        file.getMetadata = (...input) => {
          if (file.name === source) { counts.metadata++; assert.ok(counts.metadata <= 1, '원본 metadata 반복 조회 금지'); }
          return metadata(...input);
        };
        file.download = (...input) => {
          if (file.name === source) { counts.download++; assert.ok(counts.download <= 1, '원본 전체 반복 다운로드 금지'); }
          else if (file.name.startsWith('inventoryWriter/cards/')) counts.blobDownload++;
          return download(...input);
        };
        file.save = (...input) => { counts.writes++; return save(...input); };
        return file;
      };
      const binding = instrumentedInventoryBinding({ db: connection.db, database: connection.targetDatabase,
        bucket: connection.bucket, FieldValue, runId, migration }, counts);
      await binding.initialize();
      const journal = createWriterJournalStore({ database: connection.targetDatabase });
      const before = await journal.read(runId), started = performance.now();
      const read = await binding.inventoryRepository.downloadInventory('scale');
      assert.deepEqual(read.data, expected);
      assert.deepEqual(counts, { metadata: 1, download: 1, blobDownload: 0, split: 1, writes: 0 });
      for (const name of Object.keys(counts)) counts[name] = 0;
      const unchanged = await binding.inventoryRepository.updateInventoryWithRetry('scale', () => {});
      assert.deepEqual(unchanged, expected);
      assert.deepEqual(counts, { metadata: 1, download: 1, blobDownload: 0, split: 1, writes: 0 });
      assert.deepEqual(await journal.read(runId), before);
      assert.equal((await connection.db.collection('inventoryWriterHeads').doc('scale').get()).exists, false);
      t.diagnostic(JSON.stringify({ stage: 'legacy-first-read-and-noop', cards: count,
        originalBytes: Buffer.byteLength(JSON.stringify(expected)), perRequest: counts,
        elapsedMs: Math.round(performance.now() - started), rssBytes: process.memoryUsage().rss,
        maxRssKiB: process.resourceUsage().maxRSS }));
    } finally { await connection.close(); }
  }
});

test('최초 legacy 원본은 요청 사이에 공유되지 않고 generation 경합은 기록·fence·양방향 전환을 보존한다', async () => {
  const f = await setup();
  try {
    const file = f.connection.bucket.file('users/u/inventory.json'), original = fixture();
    await file.save(JSON.stringify(original), { resumable: false });
    const first = await f.inventoryRepository.downloadInventory('u');
    first.data.cards.A.name = '호출자만 바꾼 값';
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, original);
    const newer = fixture(); newer.cards.A.name = '새 generation 원본';
    await assert.rejects(f.inventoryRepository.updateInventoryWithRetry('u', async inventory => {
      await file.save(JSON.stringify(newer), { resumable: false });
      inventory.cards.A.name = '이전 generation에서 시작한 변경';
    }), { code: 'INVENTORY_WRITER_UNTRACKED_WRITE' });
    assert.deepEqual(JSON.parse((await file.download())[0].toString()), newer);
    assert.equal((await f.connection.db.collection('inventoryWriterHeads').doc('u').get()).exists, false);
    assert.equal((await f.transition.inspect()).unresolved, 1);
    const state = (await createWriterJournalStore({ database: f.connection.targetDatabase }).read(f.runId)).value;
    const pending = Object.values(state.operations).filter(operation => operation.status === 'executing');
    assert.equal(pending.length, 1);
    await f.transition.fenceUncommitted(pending[0].id);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, newer);
    assert.equal((await switchTo(f)).backend, 'rtdb');
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, newer);
    assert.equal((await switchTo(f)).backend, 'legacy');
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, newer);
  } finally { await f.close(); }
});

test('1000카드 미분할 legacy의 최초 카드 등록은 원본을 유지하고 영수증과 head를 거쳐 재조회된다', { timeout: 180000 }, async t => {
  const f = await setup();
  try {
    const source = f.connection.bucket.file('users/first-write/inventory.json'), original = manyCards(1000);
    const originalText = JSON.stringify(original);
    await source.save(originalText, { resumable: false });
    const requests = { originalDownloads: 0, cardBlobDownloads: 0, cardBlobWrites: 0, rtdbBlobReads: 0 };
    const originalFile = f.connection.bucket.file.bind(f.connection.bucket);
    f.connection.bucket.file = (...args) => {
      const file = originalFile(...args), download = file.download.bind(file), save = file.save.bind(file);
      file.download = (...input) => {
        if (file.name === source.name) requests.originalDownloads++;
        else if (file.name.startsWith('inventoryWriter/cards/')) requests.cardBlobDownloads++;
        return download(...input);
      };
      file.save = (...input) => {
        if (file.name.startsWith('inventoryWriter/cards/')) requests.cardBlobWrites++;
        return save(...input);
      };
      return file;
    };
    const reference = f.connection.targetDatabase.ref;
    f.connection.targetDatabase.ref = path => {
      const ref = reference(path), get = ref.get.bind(ref);
      ref.get = (...args) => { if (path.startsWith('inventoryCardVersions/')) requests.rtdbBlobReads++; return get(...args); };
      return ref;
    };
    const start = performance.now();
    const { processAddCards } = require('../utils/inventoryStorage');
    const changed = await f.inventoryRepository.updateInventoryWithRetry('first-write', inventory => {
      processAddCards(inventory, { 'SYNTHETIC-NEW': { name: '합성 추가 카드', cid: '2001',
        items: [{ rarity: 'N', qty: 1, loc: '합성 보관함', illustration: '1', requestIndex: 0 }] } });
    });
    const updateMs = Math.round(performance.now() - start);
    const updateRequests = { ...requests };
    assert.deepEqual(updateRequests, { originalDownloads: 2, cardBlobDownloads: 1001, cardBlobWrites: 1001, rtdbBlobReads: 0 });
    assert.equal(changed.amount, 1001); assert.equal(Object.keys(changed.cards).length, 1001);
    assert.equal((await source.download())[0].toString(), originalText);
    assert.equal((await f.connection.db.collection('inventoryWriterHeads').doc('first-write').get()).exists, true);
    const state = await f.transition.inspect(); assert.equal(state.unresolved, 0);
    const receipts = await f.connection.db.collection('inventoryWriterReceipts').get();
    assert.equal(receipts.size, 1);
    const readStart = performance.now();
    assert.deepEqual((await f.inventoryRepository.downloadInventory('first-write')).data, changed);
    t.diagnostic(JSON.stringify({ stage: 'legacy-first-register-and-reread', originalCards: 1000,
      resultCards: 1001, updateMs, readMs: Math.round(performance.now() - readStart),
      updateRequests,
      rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS,
      productionRequestBudgetMs: 60000, updateWithinProductionTimeBudget: updateMs < 60000 }));
  } finally { await f.close(); }
});

test('첫 legacy 저장에서 원본과 같은 token의 다른 본문을 재공급하면 재사용하지 않고 거부한다', async () => {
  const f = await setup();
  try {
    const original = fixture(), file = f.connection.bucket.file('users/u/inventory.json');
    await file.save(JSON.stringify(original), { resumable: false });
    const current = await f.inventories.legacy.read('inventory/u');
    const { splitStable } = require('../services/userInventoryWriterAdapters');
    const { fingerprint } = require('../services/userMigrationRehearsal');
    const candidate = splitStable(original), changed = candidate.blobs.map(blob => ({ ...blob }));
    changed[0].value = { ...changed[0].value, name: '같은 버전으로 위장한 합성 본문' };
    const operation = { id: id(), digest: fingerprint({ test: 'conflicting-source-blob' }), result: null,
      changes: [{ key: 'inventory/u', exists: true, token: current.token,
        value: { exists: true, manifest: candidate.manifest } }],
      details: { kind: 'inventory', blobs: changed } };
    await assert.rejects(f.inventories.legacy.commit(operation), { code: 'INVENTORY_WRITER_CARD_VERSION_MISMATCH' });
    assert.equal((await f.connection.db.collection('inventoryWriterHeads').doc('u').get()).exists, false);
    assert.deepEqual(JSON.parse((await file.download())[0].toString()), original);
    assert.deepEqual((await f.inventoryRepository.downloadInventory('u')).data, original);
  } finally { await f.close(); }
});
