'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { encodeKey } = require('../services/user-storage/codec');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const id = () => randomBytes(16).toString('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup() {
  const f = await fixture();
  await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  const route = await f.binding.transition.route();
  await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
  f.claims = f.load('functions/services/membershipClaims.js'); f.user = f.load('functions/routes/user.js');
  f.storage = f.binding.claimsStorage; f.auth = f.connection.auth;
  assert.equal((await call(f.user.getUserData, { method: 'GET' })).body.membershipClaims.status, 'synced');
  return f;
}
async function complete(f, provider = 'youtube') {
  const time = Date.now(), nonceHash = createHash('sha256').update(id()).digest('hex');
  const profile = f.connection.targetDatabase.ref(`users/${encodeKey(f.uid)}/profile`), before = (await profile.get()).val();
  await f.binding.membership.start(f.uid, provider, { nonceHash, startedAt: time, expiresAt: time + 300000,
    consumed: false, localOnly: false, ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}) });
  await f.binding.membership.withVerification(f.uid, provider, async () => {
    await f.binding.membership.consume(f.uid, provider, nonceHash);
    await f.binding.membership.complete(f.uid, provider, nonceHash, { status: 'active', type: provider === 'youtube' ? 'csv' : 'discord',
      levelName: '합성 회원', ...(provider === 'youtube' ? { userChannelId: 'UC' + 'x'.repeat(22) } : { discordId: '123456789012345678' }),
      verificationVersion: 2, verificationProvider: provider, lastChecked: time });
  });
  return { instance: f.config.instanceId, location: f.config.location, params: { userKey: encodeKey(f.uid) },
    data: { before: { val: () => before } }, profile };
}
async function eventFor(f, provider) {
  const event = await complete(f, provider), after = (await event.profile.get()).val();
  event.data.after = { val: () => after }; return event;
}
function worker(f, auth = f.auth) {
  return createMembershipClaimsFollowup({ select: () => ({ storage: f.storage, config: f.config }),
    sync: uid => f.claims.syncMembershipClaims(uid, { auth }), wait: async () => {}, emit() {} });
}
const read = f => call(f.user.getUserData, { body: { membershipClaimsReadOnly: true } });

for (const provider of ['youtube', 'discord']) test(`${provider} worker 저장 중 전체 조회는 Auth/잠금을 쓰지 않고 전체 인벤토리와 pending을 반환한다`, async () => {
  const f = await setup(), entered = deferred(), release = deferred(); let running, acquire, writes = 0;
  try {
    const event = await eventFor(f, provider);
    const auth = { getUser: (...args) => f.auth.getUser(...args), setCustomUserClaims: async (...args) => {
      writes++; entered.resolve(); await release.promise; return f.auth.setCustomUserClaims(...args);
    } };
    running = worker(f, auth)(event);
    await Promise.race([entered.promise, running.then(() => assert.fail('worker가 저장 지점에 도달하지 않음'))]);
    const before = await f.binding.transition.inspect(), lock = await f.storage.customClaims.inspect(f.uid);
    acquire = f.storage.customClaims.acquire;
    f.storage.customClaims.acquire = () => assert.fail('조회에서 claims 잠금 획득 금지');
    const response = await read(f);
    assert.equal(response.statusCode, 200); assert(Array.isArray(response.body.allCards));
    assert.equal(response.body.settings.membership.status, 'active');
    assert.deepEqual(response.body.membershipClaims, { status: 'pending' });
    assert.deepEqual(await f.storage.customClaims.inspect(f.uid), lock);
    assert.deepEqual(await f.binding.transition.inspect(), before); assert.equal(writes, 1);
    f.storage.customClaims.acquire = acquire; acquire = undefined;
    release.resolve(); await running;
    const settled = await read(f); assert.equal(settled.body.membershipClaims.status, 'synced');
    assert.equal(writes, 1); assert.equal((await f.binding.transition.inspect()).externalUnresolved, 0);
  } finally {
    if (acquire) f.storage.customClaims.acquire = acquire;
    release.resolve(); if (running) await running.catch(() => {}); await f.close();
  }
});

test('worker 지연·미도착에는 읽기만 하고 일반 전체 조회의 기존 복구는 유지한다', async () => {
  const f = await setup();
  try {
    await complete(f);
    const before = await f.binding.transition.inspect(), old = (await f.auth.getUser(f.uid)).customClaims;
    for (let i = 0; i < 2; i++) assert.equal((await read(f)).body.membershipClaims.status, 'pending');
    assert.deepEqual((await f.auth.getUser(f.uid)).customClaims, old);
    assert.deepEqual(await f.binding.transition.inspect(), before);
    const repaired = await call(f.user.getUserData, { method: 'GET' });
    assert.equal(repaired.body.membershipClaims.status, 'synced');
    assert.equal((await read(f)).body.membershipClaims.status, 'synced');
  } finally { await f.close(); }
});

test('worker 미도착 조건 비교에서 재인증 조회의 중복 claims 획득·Auth 저장을 제거한다', async () => {
  const samples = [];
  for (const readOnly of [false, true]) {
    const f = await setup();
    try {
      await complete(f);
      const acquire = f.storage.customClaims.acquire, write = f.auth.setCustomUserClaims;
      let locks = 0, writes = 0;
      f.storage.customClaims.acquire = async (...args) => { locks++; return acquire(...args); };
      f.auth.setCustomUserClaims = async (...args) => {
        writes++; await new Promise(resolve => setTimeout(resolve, 150)); return write.apply(f.auth, args);
      };
      const started = performance.now();
      const response = await call(f.user.getUserData, { body: readOnly ? { membershipClaimsReadOnly: true } : {} });
      samples.push({ readOnly, totalMs: Math.round((performance.now() - started) * 1000) / 1000,
        claimsAcquires: locks, authWrites: writes, status: response.body.membershipClaims.status });
      assert.equal(response.statusCode, 200); assert(Array.isArray(response.body.allCards));
      assert.equal(locks, readOnly ? 0 : 1); assert.equal(writes, readOnly ? 0 : 1);
      assert.equal(response.body.membershipClaims.status, readOnly ? 'pending' : 'synced');
    } finally { await f.close(); }
  }
  console.log(JSON.stringify({ event: 'synthetic_membership_read_only_comparison', simulatedAuthWriteDelayMs: 150,
    actualOAuth: false, productionLatency: false, samples }));
});

test('재인증 읽기 확인도 Auth 비활성·원본 버전 변경·전환 epoch 변경을 synced로 인정하지 않는다', async () => {
  const f = await setup(), route = f.binding.transition.route, readWindow = f.binding.membership.withReadWindow;
  try {
    const before = await f.binding.transition.inspect();
    const disabled = { getUser: async uid => ({ ...await f.auth.getUser(uid), disabled: true }),
      setCustomUserClaims: () => assert.fail('읽기 확인에서 Auth 저장 금지') };
    assert.equal((await f.claims.readMembershipClaimsAfterVerification(f.uid, { auth: disabled })).status, 'pending');
    f.binding.membership.withReadWindow = (uid, action) => readWindow(uid, scope => action({ ...scope,
      read: async () => ({ ...await scope.read(), membership: { status: 'none', type: 'csv' }, version: 'different-source' }) }));
    assert.equal((await f.claims.readMembershipClaimsAfterVerification(f.uid)).status, 'pending');
    f.binding.membership.withReadWindow = readWindow;
    let routes = 0;
    f.binding.transition.route = async () => { const value = await route(); return ++routes === 2 ? { ...value, epoch: value.epoch + 1 } : value; };
    assert.equal((await f.claims.readMembershipClaimsAfterVerification(f.uid)).status, 'pending');
    f.binding.transition.route = route;
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { f.binding.transition.route = route; f.binding.membership.withReadWindow = readWindow; await f.close(); }
});

test('worker Auth ACK 유실의 uncertain을 조회가 해제하지 않고 명시 복구 계약을 유지한다', async () => {
  const f = await setup();
  try {
    await complete(f);
    const auth = { getUser: (...args) => f.auth.getUser(...args), setCustomUserClaims: async (...args) => {
      await f.auth.setCustomUserClaims(...args); throw Error('synthetic ACK loss');
    } };
    assert.equal((await f.claims.syncMembershipClaims(f.uid, { auth })).status, 'pending');
    const lock = await f.storage.customClaims.inspect(f.uid), before = await f.binding.transition.inspect();
    assert.equal(lock.state, 'uncertain'); assert.equal((await read(f)).body.membershipClaims.status, 'pending');
    assert.deepEqual(await f.storage.customClaims.inspect(f.uid), lock);
    assert.deepEqual(await f.binding.transition.inspect(), before);
    const route = await f.binding.transition.route(); await f.binding.transition.drain(route);
    assert.equal((await f.claims.recoverMembershipClaims(f.uid, lock.operationId, { writersDrained: true })).status, 'synced');
    await f.binding.transition.resume(route, { id: id(), writersDrained: true });
    assert.equal((await read(f)).body.membershipClaims.status, 'synced');
  } finally { await f.close(); }
});

test('RTDB 읽기 실패는 pending으로 남기고 Auth 쓰기로 대체하지 않는다', async () => {
  const f = await setup(), window = f.binding.membership.withReadWindow;
  try {
    const before = await f.binding.transition.inspect();
    f.binding.membership.withReadWindow = async () => { throw Error('synthetic unavailable'); };
    const response = await read(f); assert.equal(response.statusCode, 200); assert.equal(response.body.membershipClaims.status, 'pending');
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { f.binding.membership.withReadWindow = window; await f.close(); }
});

test('역전환 후 명시 조회도 legacy 동기 복구를 유지하고 이후 RTDB 전환이 가능하다', async () => {
  const f = await setup();
  try {
    await complete(f);
    let route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    assert.equal((await f.binding.transition.route()).backend, 'legacy');
    assert.equal((await read(f)).body.membershipClaims.status, 'synced');
    route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    assert.equal((await read(f)).body.membershipClaims.status, 'synced');
    assert.equal((await f.binding.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

test('legacy 복구 선택 직후 RTDB로 바뀌면 조회가 Auth 쓰기로 넘어가지 않는다', async () => {
  const f = await setup(), readWindow = f.binding.membership.withReadWindow;
  try {
    await complete(f);
    let route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    const before = (await f.auth.getUser(f.uid)).customClaims;
    let switched = false;
    f.binding.membership.withReadWindow = async (...args) => {
      const value = await readWindow(...args);
      if (!switched) {
        switched = true; route = await f.binding.transition.route();
        await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
      }
      return value;
    };
    assert.equal((await f.claims.readMembershipClaimsAfterVerification(f.uid)).status, 'pending');
    assert.equal((await f.binding.transition.route()).backend, 'rtdb');
    assert.deepEqual((await f.auth.getUser(f.uid)).customClaims, before);
    assert.equal((await f.binding.transition.inspect()).externalUnresolved, 0);
    f.binding.membership.withReadWindow = readWindow;
    assert.equal((await call(f.user.getUserData, { method: 'GET' })).body.membershipClaims.status, 'synced');
  } finally { f.binding.membership.withReadWindow = readWindow; await f.close(); }
});
