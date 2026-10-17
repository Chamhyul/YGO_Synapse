'use strict';

// 동일 파일을 기준/후보 이미지에 읽기 전용으로 연결하는 비교 검사다.
// 실제 demo SDK와 공통 writer를 쓰되 인증 토큰·App Check는 명시적 합성 경계다.
// GET 수 감소나 인벤토리 재저장 제거를 사전 단정하지 않고 관측값으로 출력한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { encodeKey } = require('../services/user-storage/codec');

const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stock = () => ({ version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: 1,
  locations: { '합성 보관함': ['SYN-001'] }, rarities: { SR: 1 },
  cards: { 'SYN-001': { name: '합성 카드', cid: '123',
    items: [{ rarity: 'SR', qty: 1, loc: '합성 보관함', illustration: '1' }] } } });

function responseContract(body) {
  const value = clone(body);
  // 실제 시각·처리 시간은 fixture 간 응답 비교에서만 제외한다. 필드는 유지한다.
  if (Object.hasOwn(value, 'lastUpdated')) value.lastUpdated = typeof value.lastUpdated;
  if (Object.hasOwn(value, 'createdAt')) value.createdAt = value.createdAt === null ? null : typeof value.createdAt;
  if (value.debug && Object.hasOwn(value.debug, 'serverTime')) value.debug.serverTime = typeof value.debug.serverTime;
  if (value.settings && Object.hasOwn(value.settings, 'updatedAt')) value.settings.updatedAt = typeof value.settings.updatedAt;
  return value;
}

function inventoryContract(value) {
  const result = clone(value);
  delete result.updatedAt;
  // 기존 GET은0 집계를 저장에서도 제거한다. 후보 GET은 원본을 보존할 수 있다.
  // 두 방식 모두 실제 카드·수량·위치·양수 집계는 동일해야 한다.
  for (const key of Object.keys(result.rarities || {})) if (result.rarities[key] <= 0) delete result.rarities[key];
  return result;
}

function observe(f, delayMs) {
  const database = f.connection.targetDatabase, originalRef = database.ref;
  const counts = { get: 0, routeGet: 0, transaction: 0, listener: 0, once: 0,
    set: 0, update: 0, remove: 0, authGet: 0, authSetClaims: 0, inventoryCommit: 0 };
  const wrap = (ref, refPath) => new Proxy(ref, {
    get(target, key) {
      if (key === 'child') return child => wrap(target.child(child), [refPath, child].filter(Boolean).join('/'));
      const method = Reflect.get(target, key, target);
      if (typeof method !== 'function') return method;
      if (!['get', 'transaction', 'on', 'once', 'set', 'update', 'remove'].includes(key)) return method.bind(target);
      return (...args) => {
        counts[key === 'on' ? 'listener' : key]++;
        if (key === 'get' && refPath.startsWith('profileWriterTransitions/') && refPath.endsWith('/head')) counts.routeGet++;
        if (key === 'get' && delayMs) return new Promise(resolve => setTimeout(resolve, delayMs)).then(() => method.apply(target, args));
        return method.apply(target, args);
      };
    },
  });
  database.ref = name => wrap(originalRef(name), name || '');
  const auth = f.connection.auth, getUser = auth.getUser, setClaims = auth.setCustomUserClaims;
  auth.getUser = function (...args) { counts.authGet++; return getUser.apply(this, args); };
  auth.setCustomUserClaims = function (...args) { counts.authSetClaims++; return setClaims.apply(this, args); };
  const adapter = f.binding.inventories.rtdb, commit = adapter.commit;
  adapter.commit = function (...args) { counts.inventoryCommit++; return commit.apply(this, args); };
  return { counts, restore() {
    database.ref = originalRef; auth.getUser = getUser; auth.setCustomUserClaims = setClaims; adapter.commit = commit;
  } };
}

async function flip(f) {
  const writer = await f.binding.transition.route();
  await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
}

async function setup() {
  // commonWriterFixture는 실제 production selector에 demo SDK를 명시 주입한다.
  // 이 selector의 initializeMissing:false 경로를 사용하며 자동 초기화하지 않는다.
  const f = await fixture();
  try {
    await assert.rejects(f.binding.initialize(), { code: 'WRITER_NOT_INITIALIZED' });
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic-terms', privacy: 'synthetic-privacy' });
    await f.binding.repository.updateSettings(f.uid, { theme: 'dark' });
    await f.binding.repository.updateNickname('synthetic-protected', '합성 보호 자료');
    await f.connection.bucket.file(`users/${f.uid}/inventory.json`).save(JSON.stringify(stock()), { resumable: false });
    await f.connection.auth.setCustomUserClaims(f.uid, { unrelated: 'preserved' });
    await flip(f);
    f.user = f.load('functions/routes/user.js');
    f.inventory = f.load('functions/routes/inventory.js');
    f.registration = f.load('functions/routes/registration.js');
    const primed = await call(f.user.getUserData, { method: 'GET' });
    assert.equal(primed.statusCode, 200); assert.equal(primed.body.membershipClaims.status, 'synced');
    f.cleanResponse = responseContract(primed.body);
    f.profileBefore = await f.binding.repository.read(f.uid);
    f.protectedBefore = await f.binding.repository.read('synthetic-protected');
    f.legacyProfileBefore = (await f.connection.db.collection('users').doc(f.uid).get()).data();
    f.legacyInventoryBefore = (await f.connection.bucket.file(`users/${f.uid}/inventory.json`).download())[0].toString('utf8');
    return f;
  } catch (error) { await f.close(); throw error; }
}

test('동일 합성 SDK 조건에서 사용자 조회·가입·route와 삭제 후 GET을 비교한다', { timeout: 240000 }, async t => {
  const label = /^[a-z0-9_-]{1,40}$/i.test(process.env.USER_QUERY_BENCH_LABEL || '') ? process.env.USER_QUERY_BENCH_LABEL : 'unspecified';
  const samples = [], contracts = new Map();
  for (const delayMs of [0, 20]) for (let round = 0; round < 3; round++) {
    const f = await setup();
    try {
      async function measured(action, invoke, verify) {
        const meter = observe(f, delayMs), start = performance.now();
        let value, elapsedMs;
        try { value = await invoke(); elapsedMs = performance.now() - start; }
        finally { meter.restore(); }
        await verify(value);
        const sample = { delayPerGetMs: delayMs, round, action,
          elapsedMs: Math.round(elapsedMs * 1000) / 1000, ...meter.counts };
        if (value?.body) {
          const contract = responseContract(value.body);
          if (contracts.has(action)) assert.deepEqual(contract, contracts.get(action));
          else contracts.set(action, contract);
          sample.responseDigest = digest(contract);
        }
        samples.push(sample);
        return { value, sample };
      }
      await measured('profile-isRegistered', () => f.binding.repository.isRegistered(f.uid), value => assert.equal(value, true));
      await measured('profile-read', () => f.binding.repository.read(f.uid), value => assert.deepEqual(value, f.profileBefore));
      const membership = await f.binding.membership.read(f.uid);
      await measured('membership-read', () => f.binding.membership.read(f.uid), value => assert.deepEqual(value, membership));
      await measured('claims-acquire-finish', async () => {
        const operation = await f.binding.claimsStorage.customClaims.acquire(f.uid);
        await f.binding.claimsStorage.customClaims.finish(f.uid, operation);
      }, async () => assert.equal((await f.binding.claimsStorage.customClaims.inspect(f.uid)).state, 'idle'));

      const cleanBefore = await f.binding.inventories.rtdb.read(`inventory/${f.uid}`);
      await measured('getUserData-clean', () => call(f.user.getUserData, { method: 'GET' }), value => {
        assert.equal(value.statusCode, 200); assert.deepEqual(responseContract(value.body), f.cleanResponse);
      });
      assert.deepEqual(await f.binding.inventories.rtdb.read(`inventory/${f.uid}`), cleanBefore);

      // 기존 삭제 POST가0 집계를 돌려주는 계약을 그대로 확인한다.
      const discarded = await call(f.inventory.discardCards, { body: { discards: [{ cardNo: 'SYN-001', rarity: 'SR',
        proc: '1', loc: '합성 보관함', qty: 1 }] } });
      assert.equal(discarded.statusCode, 200); assert.equal(discarded.body.amount, 0); assert.deepEqual(discarded.body.rarities, { SR: 0 });
      const emptyBefore = await f.binding.inventoryRepository.downloadInventory(f.uid);
      assert.equal(emptyBefore.data.rarities.SR, 0);
      const headPath = `inventories/${encodeKey(f.uid)}`;
      const headBefore = (await f.connection.targetDatabase.ref(headPath).get()).val();
      const zero = await measured('getUserData-after-last-discard', () => call(f.user.getUserData, { method: 'GET' }), value => {
        assert.equal(value.statusCode, 200); assert.equal(value.body.amount, 0);
        assert.deepEqual(value.body.allCards, []); assert.deepEqual(value.body.rarities, {});
        assert.equal(value.body.settings.theme, 'dark'); assert.equal(value.body.membershipClaims.status, 'synced');
      });
      const emptyAfter = await f.binding.inventoryRepository.downloadInventory(f.uid);
      assert.deepEqual(inventoryContract(emptyAfter.data), inventoryContract(emptyBefore.data));
      const headAfter = (await f.connection.targetDatabase.ref(headPath).get()).val();
      zero.sample.inventoryHeadChanged = digest(headAfter) !== digest(headBefore);
      zero.sample.zeroRarityRetainedInStorage = Object.hasOwn(emptyAfter.data.rarities, 'SR');

      const registrationStatus = await call(f.registration.getRegistrationStatus, { method: 'GET', token: 'owner' });
      assert.equal(registrationStatus.statusCode, 200); assert.equal(registrationStatus.body.registered, false);
      await measured('completeRegistration', () => call(f.registration.completeRegistration, { token: 'owner', body: {
        agreements: { terms: true, privacy: true }, consentVersions: registrationStatus.body.consentVersions,
      } }), value => { assert.equal(value.statusCode, 200); assert.equal(value.body.registered, true); });

      assert.deepEqual(await f.binding.repository.read(f.uid), f.profileBefore);
      assert.deepEqual(await f.binding.repository.read('synthetic-protected'), f.protectedBefore);
      assert.deepEqual((await f.connection.db.collection('users').doc(f.uid).get()).data(), f.legacyProfileBefore);
      assert.equal((await f.connection.bucket.file(`users/${f.uid}/inventory.json`).download())[0].toString('utf8'), f.legacyInventoryBefore);
      assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.unrelated, 'preserved');
      const state = await f.binding.transition.inspect();
      assert.equal(state.backend, 'rtdb'); assert.equal(state.unresolved, 0); assert.equal(state.externalUnresolved, 0);
      t.diagnostic(JSON.stringify({ label, delayPerGetMs: delayMs, round, samples: samples.filter(sample => sample.delayPerGetMs === delayMs && sample.round === round),
        maxRssKiB: process.resourceUsage().maxRSS }));
    } finally { await f.close(); }
  }
  const summary = [];
  for (const delayPerGetMs of [0, 20]) for (const action of [...new Set(samples.map(sample => sample.action))]) {
    const rows = samples.filter(sample => sample.delayPerGetMs === delayPerGetMs && sample.action === action);
    summary.push({ delayPerGetMs, action, samples: rows.length,
      meanMs: Math.round(rows.reduce((total, row) => total + row.elapsedMs, 0) / rows.length * 1000) / 1000,
      minMs: Math.min(...rows.map(row => row.elapsedMs)), maxMs: Math.max(...rows.map(row => row.elapsedMs)),
      getCounts: rows.map(row => row.get), routeGetCounts: rows.map(row => row.routeGet),
      transactionCounts: rows.map(row => row.transaction), listenerCounts: rows.map(row => row.listener),
      inventoryCommitCounts: rows.map(row => row.inventoryCommit),
    });
  }
  t.diagnostic(JSON.stringify({ label, summary, limitations: [
    '실제 demo SDK·공통 운영 선택 경로이며 인증 검증/App Check는 합성이다. 운영 계정·DB에 접근하지 않는다.',
    '20ms는 SDK get 호출 앞에만 추가한 지연이다. transaction/listener/Auth는 호출수만 관측하며 실제 순차 네트워크 RTT로 환산하지 않는다.',
    '같은0/20ms 조건마다 독립 fixture3개와 같은 action 순서를 사용한다. 시작·전체 이전·claims 준비는 측정 밖이다.',
    '정상 조회와 삭제 후 조회의 responseDigest는 실제 시각·debug 시간만 정규화한다. 기준/후보 비교에서 같은 action끼리 대조한다.',
    '처리 시간은 함수 핸들러 또는 저장 메서드 범위다. 운영 HTTP·IAM·리전·콜드 스타트·사용자 렌더링 시간을 포함하지 않는다.',
  ] }));
});
