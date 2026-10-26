'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { syncMembershipClaims, syncMembershipClaimsForProfileEvent, membershipClaim, recoverMembershipClaims } = require('../services/membershipClaims');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { withMembershipWorkerTiming, prepareMembershipWorkerStartup } = require('../services/membershipWorkerTiming');
const { withMembershipWorkerPreparation, TYPE, SOURCE } = require('../services/membershipWorkerPreparation');
const startupEnv = { K_SERVICE: 'synthetic', K_REVISION: 'synthetic', FUNCTION_TARGET: 'syncMembershipClaimsAfterProfile' };
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
async function setup() {
  const runId = id(), connection = open(runId), uid = 'synthetic-' + runId;
  const binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config,
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } });
  await binding.initialize(); const w = await binding.transition.route();
  await binding.transition.copy(w); await binding.transition.drain(w); await binding.transition.activate(w);
  await connection.auth.createUser({ uid }); await connection.auth.setCustomUserClaims(uid, { role: 'owner', admin: true, preserved: true });
  return { ...binding, connection, uid, close: () => connection.close() };
}
async function complete(f, active, increment = 0) {
  const time = Date.now() + increment, nonceHash = createHash('sha256').update(id()).digest('hex');
  await f.membership.start(f.uid, 'discord', { nonceHash, startedAt: time, expiresAt: time + 300000,
    consumed: false, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' });
  return f.membership.withVerification(f.uid, 'discord', async () => {
    await f.membership.consume(f.uid, 'discord', nonceHash);
    return f.membership.complete(f.uid, 'discord', nonceHash, { status: active ? 'active' : 'none', type: 'discord',
      levelName: active ? '대원' : '일반', discordId: '123456789012345678', verificationVersion: 2,
      verificationProvider: 'discord', lastChecked: time });
  });
}
test('실제 RTDB 저장 응답 뒤 별도 실행이 claims를 완료하며 중복·역순 이벤트가 새 자격을 덮지 않는다', async () => {
  const f = await setup();
  try {
    const key = encodeKey(f.uid), ref = f.connection.targetDatabase.ref(`users/${key}/profile`);
    const first = await complete(f, true), firstRaw = (await ref.get()).val();
    assert.equal(first.stored, true); assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.ygoMembership, undefined);
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
    const runtime = { storage: f.claimsStorage, config: { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' } };
    prepareMembershipWorkerStartup(() => runtime, { env: startupEnv, emit() {} });
    const logs = [];
    const handler = withMembershipWorkerTiming(createMembershipClaimsFollowup({ select: () => runtime, emit() {}, wait: async () => {},
      sync: (uid, _runtime, evidence) => syncMembershipClaimsForProfileEvent(uid, { auth: f.connection.auth, storage: f.claimsStorage,
        allowEmulator: true, permissionChanged: evidence.permissionChanged }) }),
    { emit: v => logs.push(v) });
    const event = (before, after) => ({ instance: 'synthetic', location: 'asia-southeast1', params: { userKey: key },
      data: { before: { val: () => before }, after: { val: () => after } } });
    const worker = withMembershipWorkerPreparation(handler, { env: startupEnv, select: () => runtime, emit() {} });
    const before = await f.transition.inspect();
    const claimsBefore = (await f.connection.auth.getUser(f.uid)).customClaims;
    await worker({ type: TYPE, source: SOURCE, specversion: '1.0',
      id: '00000000-0000-4000-8000-000000000001', data: { version: 1 } });
    assert.equal(logs.length, 0);
    assert.deepEqual((await ref.get()).val(), firstRaw);
    assert.deepEqual(await f.transition.inspect(), before);
    assert.deepEqual((await f.connection.auth.getUser(f.uid)).customClaims, claimsBefore);
    await worker(event(null, firstRaw));
    let claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    assert.deepEqual(claims.ygoMembership, membershipClaim(first)); assert.equal(claims.role, 'owner'); assert.equal(claims.preserved, true);
    assert.equal(logs[0].status, 'synced');
    assert.equal(logs[0].startupPrepared, true);
    assert.equal(logs[0].spans.filter(s => s.name === 'claims.account').length, 1);
    assert.equal(logs[0].spans.filter(s => s.name === 'claims.readback').length, 1);
    for (const name of ['worker.runtime', 'worker.route', 'claims.acquire', 'claims.patch', 'claims.readback', 'claims.finish']) {
      assert.ok(logs[0].spans.some(s => s.name === name), name);
    }
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(f.uid));
    const second = await complete(f, false, 4000), secondRaw = (await ref.get()).val();
    // 오래된 활성 회원 이벤트가 늦게 와도 지금의 비회원 원본을 반영한다.
    await handler(event(null, firstRaw)); await handler(event(firstRaw, secondRaw));
    claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    assert.deepEqual(claims.ygoMembership, membershipClaim(second)); assert.equal(claims.ygoMembership.active, false);
    assert.equal(claims.admin, true); assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

function timedWorker(f, logs) {
  const runtime = { storage: f.claimsStorage,
    config: { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' } };
  prepareMembershipWorkerStartup(() => runtime, { env: startupEnv, emit() {} });
  return withMembershipWorkerPreparation(withMembershipWorkerTiming(createMembershipClaimsFollowup({ select: () => runtime, emit() {}, wait: async () => {},
    sync: (uid, _runtime, evidence) => syncMembershipClaimsForProfileEvent(uid, { auth: f.connection.auth, storage: f.claimsStorage,
      allowEmulator: true, permissionChanged: evidence.permissionChanged }) }),
  { emit: value => logs.push(value) }), { env: startupEnv, select: () => runtime, emit() {} });
}
const written = (uid, after) => ({ instance: 'synthetic', location: 'asia-southeast1', params: { userKey: encodeKey(uid) },
  data: { before: { val: () => null }, after: { val: () => after } } });

test('계측 worker는 권한 회수·비활성 계정을 fresh 대조하고 기존 관리자 claims를 보존한다', async () => {
  const f = await setup(), logs = [];
  try {
    const ref = f.connection.targetDatabase.ref(`users/${encodeKey(f.uid)}/profile`);
    await complete(f, true); const active = (await ref.get()).val();
    const worker = timedWorker(f, logs); await worker(written(f.uid, active));
    await complete(f, false, 4000);
    await worker(written(f.uid, active)); // 과거 active 이벤트로 새 회수를 뒤집지 않는다.
    let claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    assert.equal(claims.ygoMembership.active, false); assert.equal(claims.admin, true);
    await complete(f, true, 8000); await f.connection.auth.updateUser(f.uid, { disabled: true });
    await assert.rejects(worker(written(f.uid, active)), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });
    claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    assert.equal(claims.ygoMembership.active, false); assert.equal(claims.admin, true);
    assert.equal(logs.at(-1).status, 'pending'); assert.equal(logs.at(-1).attempts, 4);
    assert.equal(logs.at(-1).spans.filter(s => s.name === 'claims.patch').length, 0);
    assert.equal((await f.claimsStorage.customClaims.inspect(f.uid)).state, 'idle');
  } finally { await f.close(); }
});

test('계측 worker의 Auth ACK 유실은 uncertain 장벽을 유지하고 drain 명시 복구로만 재개한다', async () => {
  const f = await setup(), logs = [];
  const auth = f.connection.auth, original = auth.setCustomUserClaims.bind(auth);
  try {
    await complete(f, true);
    const raw = (await f.connection.targetDatabase.ref(`users/${encodeKey(f.uid)}/profile`).get()).val();
    let writes = 0;
    auth.setCustomUserClaims = async (...args) => { writes++; await original(...args); throw new Error('synthetic lost acknowledgement'); };
    await assert.rejects(timedWorker(f, logs)(written(f.uid, raw)), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });
    assert.equal(writes, 1);
    const lock = await f.claimsStorage.customClaims.inspect(f.uid);
    assert.equal(lock.state, 'uncertain'); assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    auth.setCustomUserClaims = original;
    const writer = await f.transition.route(); await f.transition.drain(writer);
    await recoverMembershipClaims(f.uid, lock.operationId, { auth, storage: f.claimsStorage, allowEmulator: true, writersDrained: true });
    assert.equal((await f.claimsStorage.customClaims.inspect(f.uid)).state, 'idle');
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
    const claims = (await auth.getUser(f.uid)).customClaims;
    assert.equal(claims.ygoMembership.active, true); assert.equal(claims.admin, true); assert.equal(claims.preserved, true);
    assert.doesNotMatch(JSON.stringify(logs), /lost acknowledgement/);
  } finally { auth.setCustomUserClaims = original; await f.close(); }
});
