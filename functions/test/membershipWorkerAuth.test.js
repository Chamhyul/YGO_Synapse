'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { syncMembershipClaimsForProfileEvent, membershipClaim } = require('../services/membershipClaims');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
function fixture() {
  const state = { record: { membership: { status: 'active', type: 'csv', levelName: '합성',
    userChannelId: 'UC' + 'x'.repeat(22), verificationVersion: 2, verificationProvider: 'youtube', lastChecked: 1 }, version: 'one' },
    claims: { role: 'owner', admin: true, other: 'preserved' }, reads: 0, writes: 0, observes: 0, acquires: 0, lock: 'idle' };
  const storage = { config: resolveRtdbConfig(env),
    membership: { read: async () => state.record }, writerTransition: { route: async () => ({ backend: 'rtdb', epoch: 1, phase: 'accepting' }) },
    customClaims: {
      observe: async () => { state.observes++; return { revision: 1, generation: 0, value: { state: state.lock, operationId: 'a'.repeat(32), startedAt: 1 } }; },
      isSettled: async () => true,
      acquire: async () => { if (state.lock !== 'idle') throw Error('busy'); state.acquires++; state.lock = 'running'; return 'a'.repeat(32); },
      finish: async (_uid, _id, uncertain) => { state.lock = uncertain ? 'uncertain' : 'idle'; },
    } };
  const auth = { getUser: async () => { state.reads++; return { customClaims: structuredClone(state.claims), disabled: state.disabled }; },
    setCustomUserClaims: async (_uid, next) => { state.writes++; state.claims = structuredClone(next); if (state.afterWrite) await state.afterWrite(); } };
  return { state, auth, options: { auth, storage, env, allowEmulator: true, timeoutMs: 1000 } };
}
test('권한 변경 이벤트는 사전 Auth 조회 없이 잠금 뒤 fresh 조회·저장·readback 세 왕복만 수행한다', async () => {
  const { state, auth, options } = fixture(), get = auth.getUser;
  auth.getUser = (...args) => { assert.equal(state.lock, 'running'); return get(...args); };
  const result = await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: true });
  assert.equal(result.status, 'synced'); assert.equal(state.reads, 2); assert.equal(state.writes, 1);
  assert.equal(state.observes, 0); assert.equal(state.acquires, 1); assert.equal(state.lock, 'idle');
  assert.equal(state.claims.role, 'owner'); assert.equal(state.claims.other, 'preserved');
});
test('확인 시각만 바뀐 이벤트는 기존 읽기 대조와 단일 Auth 조회를 유지한다', async () => {
  const { state, options } = fixture(); state.claims.ygoMembership = membershipClaim(state.record);
  const result = await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: false });
  assert.equal(result.status, 'synced'); assert.equal(state.reads, 1); assert.equal(state.acquires, 0); assert.equal(state.writes, 0);
});
test('과거 이벤트 힌트는 현재 회수된 원본이나 비활성 계정을 승격시키지 않는다', async () => {
  const { state, options } = fixture(); state.record = { membership: { status: 'none' }, version: 'revoked' };
  assert.equal((await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: true })).status, 'synced');
  assert.equal(state.claims.ygoMembership.active, false); assert.equal(state.claims.admin, true);
  const f = fixture(); f.state.disabled = true;
  assert.equal((await syncMembershipClaimsForProfileEvent('synthetic', { ...f.options, permissionChanged: true })).status, 'pending');
  assert.equal(f.state.writes, 0); assert.equal(f.state.lock, 'idle');
});
test('Auth 저장 중 원본 회수는 같은 잠금 안에서 최신 원본을 다시 적용한다', async () => {
  const { state, options } = fixture(); state.afterWrite = async () => { state.record = { membership: { status: 'none' }, version: 'revoked' }; };
  const result = await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: true });
  assert.equal(result.status, 'synced'); assert.equal(state.writes, 2); assert.equal(state.claims.ygoMembership.active, false);
  assert.equal(state.claims.admin, true); assert.equal(state.acquires, 1);
});
test('Auth ACK 유실·readback 불일치와 기존 uncertain 장벽을 우회하지 않는다', async () => {
  for (const kind of ['lost', 'mismatch']) {
    const { state, options } = fixture();
    state.afterWrite = async () => { if (kind === 'lost') throw Error('synthetic lost acknowledgement'); state.claims.extra = 'concurrent'; };
    assert.equal((await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: true })).status, 'pending');
    assert.equal(state.lock, 'uncertain'); assert.equal(state.writes, 1);
    assert.equal((await syncMembershipClaimsForProfileEvent('synthetic', { ...options, permissionChanged: true })).status, 'pending');
    assert.equal(state.writes, 1);
  }
});
