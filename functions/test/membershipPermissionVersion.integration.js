'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { membershipVersion, membershipPermissionVersion } = require('../services/user-storage/membershipStore');
const { membershipClaim } = require('../services/membershipClaims');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { encodeKey } = require('../services/user-storage/codec');
const source = { status: 'active', type: 'csv', levelName: '합성 회원', userChannelId: 'UC' + 'x'.repeat(22),
  verificationVersion: 2, verificationProvider: 'youtube', lastChecked: 1 };
async function setup() {
  const f = await fixture(); await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  const route = await f.binding.transition.route();
  await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
  f.claims = f.load('functions/services/membershipClaims.js'); f.user = f.load('functions/routes/user.js');
  await f.connection.auth.setCustomUserClaims(f.uid, { role: 'owner', admin: true, preserve: 'synthetic' });
  await f.binding.repository.updateSettings(f.uid, { membership: source });
  assert.equal((await f.claims.syncMembershipClaims(f.uid)).status, 'synced');
  return f;
}
function observe(f) {
  const lock = f.binding.claimsStorage.customClaims, acquire = lock.acquire, auth = f.connection.auth, set = auth.setCustomUserClaims;
  const count = { acquire: 0, write: 0 };
  lock.acquire = async (...args) => { count.acquire++; return acquire(...args); };
  auth.setCustomUserClaims = async (...args) => { count.write++; return set.apply(auth, args); };
  return { count, close() { lock.acquire = acquire; auth.setCustomUserClaims = set; } };
}
const full = f => call(f.user.getUserData, { body: { membershipClaimsReadOnly: true } });
test('시각만 갱신된 실제 RTDB profile 이벤트·전체 조회는 잠금/Auth 쓰기 없이 같은 토큰 버전을 반환한다', async () => {
  const f = await setup(); let o;
  try {
    const profile = f.connection.targetDatabase.ref(`users/${encodeKey(f.uid)}/profile`), before = (await profile.get()).val();
    const original = await f.binding.membership.read(f.uid), claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    await f.binding.repository.updateSettings(f.uid, { membership: { ...source, lastChecked: 2 } });
    const after = (await profile.get()).val(), current = await f.binding.membership.read(f.uid);
    assert.notEqual(original.version, current.version); assert.equal(current.membership.lastChecked, 2);
    o = observe(f); let invoked = 0;
    const worker = createMembershipClaimsFollowup({ select: () => ({ storage: f.binding.claimsStorage, config: f.config }),
      sync: uid => { invoked++; return f.claims.syncMembershipClaims(uid); }, emit() {} });
    await worker({ instance: f.config.instanceId, location: f.config.location, params: { userKey: encodeKey(f.uid) },
      data: { before: { val: () => before }, after: { val: () => after } } });
    assert.equal(invoked, 1); // 확인 시각 이벤트도 복구 신호로 유지한다.
    const response = await full(f); assert.equal(response.statusCode, 200); assert(Array.isArray(response.body.allCards));
    assert.deepEqual(response.body.membershipClaims, { status: 'synced', version: claims.ygoMembership.version });
    assert.equal(response.body.sourceMembership.lastChecked, 2);
    assert.deepEqual(o.count, { acquire: 0, write: 0 });
    assert.deepEqual((await f.connection.auth.getUser(f.uid)).customClaims, claims);
    console.log(JSON.stringify({ event: 'synthetic_permission_version_repeat', claimsAcquires: 0, authWrites: 0, sourceTimestampUpdated: true, production: false }));
  } finally { o?.close(); await f.close(); }
});
test('구형 원본 해시 claim은 정상 경로에서 한 번만 교정하고 이후 확인 시각 변경에는 재저장하지 않는다', async () => {
  const f = await setup(); let o;
  try {
    const auth = f.connection.auth, old = (await auth.getUser(f.uid)).customClaims;
    await auth.setCustomUserClaims(f.uid, { ...old, ygoMembership: { ...old.ygoMembership, version: membershipVersion(source) } });
    assert.equal((await full(f)).body.membershipClaims.status, 'pending');
    o = observe(f); assert.equal((await f.claims.syncMembershipClaims(f.uid)).status, 'synced');
    assert.deepEqual(o.count, { acquire: 1, write: 1 });
    await f.binding.repository.updateSettings(f.uid, { membership: { ...source, lastChecked: 3 } });
    assert.equal((await full(f)).body.membershipClaims.status, 'synced');
    assert.equal((await f.claims.syncMembershipClaims(f.uid)).status, 'synced');
    assert.deepEqual(o.count, { acquire: 1, write: 1 });
  } finally { o?.close(); await f.close(); }
});
test('회원 회수·등급·신원·제공자 변경은 pending 후 새 claim으로 저장하며 관리자 권한을 보존한다', async () => {
  const f = await setup(); let o;
  try {
    o = observe(f);
    for (const member of [ { ...source, status: 'none', levelName: '일반' }, { ...source, levelName: '다른 등급' },
      { ...source, userChannelId: 'UC' + 'y'.repeat(22) },
      { status: 'active', type: 'discord', levelName: '대원', discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord', lastChecked: 4 } ]) {
      await f.binding.repository.updateSettings(f.uid, { membership: member });
      assert.equal((await full(f)).body.membershipClaims.status, 'pending');
      const result = await f.claims.syncMembershipClaims(f.uid); assert.equal(result.status, 'synced');
      const saved = await f.binding.membership.read(f.uid);
      assert.equal(result.version, membershipPermissionVersion(saved.membership));
      const account = await f.connection.auth.getUser(f.uid);
      assert.deepEqual(account.customClaims.ygoMembership, membershipClaim(saved));
      assert.equal(account.customClaims.admin, true); assert.equal(account.customClaims.preserve, 'synthetic');
    }
    assert.deepEqual(o.count, { acquire: 4, write: 4 });
    await f.connection.auth.updateUser(f.uid, { disabled: true });
    assert.equal((await f.claims.readMembershipClaimsStatus(f.uid)).status, 'pending');
  } finally { o?.close(); await f.close(); }
});
test('동일 자격이어도 미확정 잠금은 해제하지 않고 drain·명시 복구·역전환을 유지한다', async () => {
  const f = await setup();
  try {
    await f.binding.repository.updateSettings(f.uid, { membership: { ...source, lastChecked: 5 } });
    const lock = f.binding.claimsStorage.customClaims, operationId = await lock.acquire(f.uid);
    await lock.finish(f.uid, operationId, true);
    assert.equal((await full(f)).body.membershipClaims.status, 'pending');
    assert.equal((await lock.inspect(f.uid)).state, 'uncertain');
    const route = await f.binding.transition.route(); await f.binding.transition.drain(route);
    assert.equal((await f.claims.recoverMembershipClaims(f.uid, operationId, { writersDrained: true })).status, 'synced');
    await f.binding.transition.resume(route, { id: require('node:crypto').randomBytes(16).toString('hex'), writersDrained: true });
    assert.equal((await full(f)).body.membershipClaims.status, 'synced');
    const current = await f.binding.transition.route(); await f.binding.transition.copy(current);
    await f.binding.transition.drain(current); await f.binding.transition.activate(current);
    assert.equal((await f.binding.transition.route()).backend, 'legacy');
    assert.equal((await full(f)).body.membershipClaims.status, 'synced');
  } finally { await f.close(); }
});
