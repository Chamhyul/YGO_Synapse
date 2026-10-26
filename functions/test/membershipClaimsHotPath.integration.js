'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { syncMembershipClaims, readMembershipClaimsStatus, recoverMembershipClaims, membershipClaim } = require('../services/membershipClaims');
const id = () => randomBytes(16).toString('hex');
async function setup(backend = 'rtdb') {
  const runId = id(), connection = open(runId), f = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config,
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } });
  await f.initialize();
  if (backend === 'rtdb') { const w = await f.transition.route(); await f.transition.copy(w); await f.transition.drain(w); await f.transition.activate(w); }
  const uid = 'claims-fast-' + runId;
  await connection.auth.createUser({ uid }); await connection.auth.setCustomUserClaims(uid, { role: 'owner', admin: true, custom: 'preserved' });
  return { ...f, uid, connection, close: () => connection.close() };
}
const options = (f, auth = f.connection.auth) => ({ auth, storage: f.claimsStorage, allowEmulator: true, env: process.env });
function nonce(localOnly = false) { const now = Date.now(); return { nonceHash: createHash('sha256').update(id()).digest('hex'), startedAt: now, expiresAt: now + 300000, consumed: false, localOnly, redirectUri: 'https://ygo-synapse.web.app/' }; }
const member = () => ({ status: 'none', type: 'discord', levelName: '일반', discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord', lastChecked: Date.now() });
async function completed(f, action, localOnly = false) {
  const s = nonce(localOnly); await f.membership.start(f.uid, 'discord', s);
  return f.membership.withVerification(f.uid, 'discord', async () => {
    await f.membership.consume(f.uid, 'discord', s.nonceHash);
    const saved = await f.membership.complete(f.uid, 'discord', s.nonceHash, member());
    return action(saved, s);
  });
}
for (const backend of ['legacy', 'rtdb']) test(`${backend} 저장 후 claims는 fresh 원본/Auth 병렬 조회와 전환 전후2회만 사용한다`, async () => {
  const f = await setup(backend);
  try {
    await completed(f, async saved => {
      const route = f.transition.route;
      const oldRead = f.membership.read, oldObserve = f.claimsStorage.customClaims.observe;
      let routes = 0, reads = 0, accounts = 0, release, retained;
      f.transition.route = async (...args) => { routes++; return route(...args); };
      f.membership.read = f.claimsStorage.customClaims.observe = () => assert.fail('중복 사전 대조/reader 금지');
      const window = f.membership.withClaimsWriteWindow;
      f.membership.withClaimsWriteWindow = (uid, action) => window(uid, scope => { retained = scope.read; return action({ read: async () => { reads++; if (reads === 1) await new Promise(resolve => { release = resolve; }); return scope.read(); } }); });
      const auth = { getUser: async uid => { accounts++; if (accounts === 1) { assert.equal(reads, 1); release(); } return f.connection.auth.getUser(uid); }, setCustomUserClaims: (...args) => f.connection.auth.setCustomUserClaims(...args) };
      try {
        assert.deepEqual(await syncMembershipClaims(f.uid, options(f, auth)), { status: 'synced', version: membershipClaim(saved).version });
        assert.deepEqual({ routes, reads, accounts }, { routes: 2, reads: 2, accounts: 2 });
        await assert.rejects(retained(), { code: 'WRITER_FENCED' });
        const claims = (await f.connection.auth.getUser(f.uid)).customClaims;
        assert.equal(claims.role, 'owner'); assert.equal(claims.admin, true); assert.equal(claims.custom, 'preserved');
        assert.deepEqual(claims.ygoMembership, membershipClaim(saved)); assert.equal(claims.ygoMembership.active, false);
      } finally { f.transition.route = route; f.membership.read = oldRead; f.claimsStorage.customClaims.observe = oldObserve; f.membership.withClaimsWriteWindow = window; }
    });
    assert.equal((await f.membership.withClaimsWriteWindow(f.uid, () => assert.fail('종료 lease 재사용'))).used, false);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.equal((await syncMembershipClaims(f.uid, options(f))).status, 'synced');
  } finally { await f.close(); }
});
test('완료 전·다른 UID·localOnly·실패한 후속 명령은 저장 후 전용 경로를 얻지 못한다', async () => {
  const f = await setup(); const forbidden = () => assert.fail('확정 저장 없는 경로');
  try {
    assert.deepEqual(await f.membership.withClaimsWriteWindow(f.uid, forbidden), { used: false });
    await f.membership.withVerification(f.uid, 'discord', async () => assert.deepEqual(await f.membership.withClaimsWriteWindow(f.uid, forbidden), { used: false }));
    await completed(f, async () => {
      assert.deepEqual(await f.membership.withClaimsWriteWindow('other', forbidden), { used: false });
      await assert.rejects(f.membership.consume(f.uid, 'discord', '0'.repeat(64)), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
      assert.deepEqual(await f.membership.withClaimsWriteWindow(f.uid, forbidden), { used: false });
    });
    // 이전 nonce를 대체하기 위한 합성 시간 조정만 한다. 운영 자료는 사용하지 않는다.
    const s = nonce(true); s.startedAt += 4000; s.expiresAt += 4000; await f.membership.start(f.uid, 'discord', s);
    await f.membership.withVerification(f.uid, 'discord', async () => {
      await f.membership.consume(f.uid, 'discord', s.nonceHash);
      assert.equal((await f.membership.complete(f.uid, 'discord', s.nonceHash, member())).stored, false);
      assert.deepEqual(await f.membership.withClaimsWriteWindow(f.uid, forbidden), { used: false });
    });
  } finally { await f.close(); }
});
test('저장 후에도 비활성 계정은 claims를 쓰지 않는다', async () => {
  const f = await setup();
  try { await completed(f, async () => {
    await f.connection.auth.updateUser(f.uid, { disabled: true });
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: () => assert.fail('비활성 claims 쓰기') };
    assert.deepEqual(await syncMembershipClaims(f.uid, options(f, auth)), { status: 'pending' });
  }); assert.equal((await f.transition.inspect()).unresolved, 0); } finally { await f.close(); }
});
test('저장 후 원본이 반복 변경되면 synced를 반환하지 않고 최신 원본으로 재시도한다', async () => {
  const f = await setup();
  try { await completed(f, async () => {
    const window = f.membership.withClaimsWriteWindow; let reads = 0;
    f.membership.withClaimsWriteWindow = (uid, action) => window(uid, scope => action({ read: async () => ({ ...await scope.read(), version: 'changed-' + ++reads }) }));
    assert.deepEqual(await syncMembershipClaims(f.uid, options(f)), { status: 'pending' }); assert.equal(reads, 6);
    f.membership.withClaimsWriteWindow = window;
  }); assert.equal((await f.transition.inspect()).unresolved, 0); } finally { await f.close(); }
});
test('저장 후 전환 epoch 불일치는 claims가 확인돼도 pending으로 반환한다', async () => {
  const f = await setup();
  try { await completed(f, async () => {
    const route = f.transition.route; let n = 0;
    f.transition.route = async () => { const w = await route(); return ++n === 2 ? { ...w, epoch: w.epoch + 1 } : w; };
    try { assert.deepEqual(await syncMembershipClaims(f.uid, options(f)), { status: 'pending' }); } finally { f.transition.route = route; }
  }); assert.equal((await f.transition.inspect()).unresolved, 0); } finally { await f.close(); }
});
test('drain 전 획득한 인증 lease의 확정 저장은 drain 중 claims 완료 후 전환한다', async () => {
  const f = await setup('legacy'); let writer;
  try { await completed(f, async () => {
    writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    assert.equal((await syncMembershipClaims(f.uid, options(f))).status, 'synced');
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
  }); await f.transition.activate(writer); assert.equal((await f.transition.route()).backend, 'rtdb'); assert.equal((await f.transition.inspect()).unresolved, 0); } finally { await f.close(); }
});
test('저장 후 Auth ACK 유실은 장벽을 남기며 drain·명시 복구 뒤에만 재개한다', async () => {
  const f = await setup();
  try { await completed(f, async () => {
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: async (...args) => { await f.connection.auth.setCustomUserClaims(...args); throw Error('synthetic ACK loss'); } };
    assert.deepEqual(await syncMembershipClaims(f.uid, options(f, auth)), { status: 'pending' });
  });
    assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    const lock = await f.claimsStorage.customClaims.inspect(f.uid), writer = await f.transition.route(); await f.transition.drain(writer);
    assert.equal((await recoverMembershipClaims(f.uid, lock.operationId, { ...options(f), writersDrained: true })).status, 'synced');
    assert.equal((await f.transition.inspect()).unresolved, 0); await f.transition.resume(writer, { id: id(), writersDrained: true });
  } finally { await f.close(); }
});

test('후속 완료 조회는 인벤토리·Auth 쓰기·잠금 획득 없이 현재 확정 상태만 읽는다', async () => {
  const f = await setup();
  try {
    await completed(f, async () => {});
    assert.equal((await syncMembershipClaims(f.uid, options(f))).status, 'synced');
    const before = await f.transition.inspect();
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: () => assert.fail('완료 확인에서 Auth 쓰기 금지') };
    const acquire = f.claimsStorage.customClaims.acquire;
    f.claimsStorage.customClaims.acquire = () => assert.fail('완료 확인에서 잠금 쓰기 금지');
    try {
      assert.equal((await readMembershipClaimsStatus(f.uid, options(f, auth))).status, 'synced');
      await f.connection.auth.setCustomUserClaims(f.uid, { role: 'owner', admin: true });
      assert.deepEqual(await readMembershipClaimsStatus(f.uid, options(f, auth)), { status: 'pending' });
      const broken = { ...auth, getUser: async () => { throw Error('synthetic'); } };
      assert.deepEqual(await readMembershipClaimsStatus(f.uid, options(f, broken)), { status: 'pending' });
      assert.deepEqual(await f.transition.inspect(), before);
    } finally { f.claimsStorage.customClaims.acquire = acquire; }
  } finally { await f.close(); }
});
