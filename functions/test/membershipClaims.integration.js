'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const scope = `synthetic-claims-${require('node:crypto').randomUUID()}`;
const { createEmulatorUserStorage } = require('../services/user-storage');
const { syncMembershipClaims, updateAccountClaims, membershipClaim } = require('../services/membershipClaims');
const stores = [createEmulatorUserStorage(), createEmulatorUserStorage()];
after(() => Promise.all(stores.map(store => store.close())));
const source = { status: 'active', type: 'discord', levelName: '합성 회원', discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord' };
const options = (storage, auth) => ({ storage, auth, env: process.env, allowEmulator: true });

test('독립 RTDB 연결의 같은 UID claims 잠금은 하나만 성공하며 다른 UID를 막지 않는다', async () => {
  const uid = `${scope}-lock`;
  const attempts = await Promise.allSettled(stores.map(store => store.customClaims.acquire(uid)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'MEMBERSHIP_CLAIMS_BUSY');
  const index = attempts.findIndex(value => value.status === 'fulfilled');
  await assert.rejects(stores[1 - index].customClaims.finish(uid, 'a'.repeat(32)), { code: 'MEMBERSHIP_CLAIMS_BUSY' });
  const other = await stores[1 - index].customClaims.acquire(`${uid}-other`);
  await stores[1 - index].customClaims.finish(`${uid}-other`, other);
  await stores[index].customClaims.finish(uid, attempts[index].value);
  assert.equal((await stores[1 - index].customClaims.inspect(uid)).state, 'idle');
});
test('실제 RTDB 원본에서 합성 Auth로 동기화하고 역할 회수시 멤버십·별도 claims를 보존한다', async () => {
  const uid = `${scope}-source`; await stores[0].profile.createIfAbsent(uid, { settings: { membership: source, theme: 'dark' } });
  let claims = { role: 'admin', admin: true, custom: 'keep' }, writes = 0;
  const auth = { getUser: async () => ({ customClaims: claims }), setCustomUserClaims: async (_uid, next) => { claims = next; writes++; } };
  const result = await syncMembershipClaims(uid, options(stores[0], auth));
  assert.deepEqual(result, { status: 'synced', version: membershipClaim(await stores[1].membership.read(uid)).version });
  await syncMembershipClaims(uid, options(stores[1], auth)); assert.equal(writes, 1);
  await updateAccountClaims(uid, { role: 'none', admin: false }, options(stores[1], auth));
  assert.equal(claims.admin, false); assert.equal(claims.ygoMembership.active, true); assert.equal(claims.custom, 'keep');
  assert.deepEqual((await stores[0].profile.read(uid)).value.settings, { membership: source, theme: 'dark' });
});
test('미확정 Auth 쓰기는 RTDB에 기록되어 새 서버 연결에서도 자동 재시도를 막는다', async () => {
  const uid = `${scope}-uncertain`; await stores[0].profile.createIfAbsent(uid, { settings: { membership: source } });
  let writes = 0;
  const auth = { getUser: async () => ({ customClaims: {} }), setCustomUserClaims: async () => { writes++; throw new Error('synthetic'); } };
  assert.deepEqual(await syncMembershipClaims(uid, options(stores[0], auth)), { status: 'pending' });
  assert.equal((await stores[1].customClaims.inspect(uid)).state, 'uncertain');
  assert.deepEqual(await syncMembershipClaims(uid, options(stores[1], auth)), { status: 'pending' });
  assert.equal(writes, 1); assert.deepEqual((await stores[1].membership.read(uid)).membership, source);
});
test('claims 저장 중 사용자 설정 변경은 보존하고 멤버십 변경은 최신 버전으로 반영한다', async () => {
  const uid = `${scope}-race`; await stores[0].profile.createIfAbsent(uid, { settings: { membership: source } });
  let claims = {}, writes = 0;
  const auth = { getUser: async () => ({ customClaims: claims }), setCustomUserClaims: async (_uid, next) => {
    claims = next; writes++;
    if (writes === 1) await stores[1].profile.update(uid, { settings: { theme: 'light', membership: { status: 'none', type: 'none' } } });
  } };
  const result = await syncMembershipClaims(uid, options(stores[0], auth));
  assert.equal(result.status, 'synced'); assert.equal(claims.ygoMembership.active, false); assert.equal(writes, 2);
  assert.equal((await stores[0].profile.read(uid)).value.settings.theme, 'light');
});
