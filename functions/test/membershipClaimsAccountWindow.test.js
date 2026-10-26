'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readMembershipClaimsStatusWithAccount, membershipClaim } = require('../services/membershipClaims');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
function fixture() {
  const state = { reads: 0, observations: 0, routes: 0, lock: 'idle', revision: 1,
    record: { membership: { status: 'none' }, version: 'one' }, log: [] };
  state.claims = { other: true, ygoMembership: membershipClaim(state.record) };
  const auth = { getUser: async () => { state.log.push('account'); state.reads++;
    return state.account ? state.account() : { uid: 'synthetic', customClaims: state.claims }; },
    setCustomUserClaims: () => assert.fail('읽기에서 Auth 쓰기 금지') };
  const storage = { config: resolveRtdbConfig(env),
    writerTransition: { route: async () => { state.routes++; if (state.routeError) throw Error('route');
      return { backend: 'rtdb', epoch: state.routes > 1 && state.fenced ? 2 : 1, phase: 'accepting' }; } },
    membership: { read: async () => { state.log.push('source');
      if (state.sourceError) throw Error('source'); return state.record; } },
    customClaims: { observe: async () => { state.log.push('lock'); state.observations++;
      if (state.observations > 1 && state.changedLock) state.revision++;
      return { revision: state.revision, generation: 0, value: { state: state.lock, operationId: 'a'.repeat(32) } }; },
      isSettled: async () => { if (state.settledError) throw Error('settled'); return !state.unsettled; },
      acquire: () => assert.fail('조회에서 잠금 획득 금지') } };
  const options = { env, storage, auth, allowEmulator: true, timeoutMs: 50, readAccount: () => auth.getUser('synthetic') };
  return { state, options, run: () => readMembershipClaimsStatusWithAccount('synthetic', options) };
}
test('잠금 관측 뒤 최신 Auth1회만 읽고 같은 계정·완료 결과를 인증 단계에 돌려준다', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.membershipClaims.status, 'synced'); assert.equal(result.account.uid, 'synthetic');
  assert.equal(f.state.reads, 1); assert(f.state.log.indexOf('lock') < f.state.log.indexOf('account'));
});
test('running/uncertain·전환·원본·완료 증거 장애도 요청 계정 인증을 건너뛰지 않는다', async () => {
  for (const change of [{ lock: 'running' }, { lock: 'uncertain' }, { routeError: true }, { sourceError: true }, { settledError: true }, { unsettled: true }]) {
    const f = fixture(); Object.assign(f.state, change);
    const result = await f.run(); assert.equal(result.membershipClaims.status, 'pending');
    assert.equal(result.account.uid, 'synthetic'); assert.equal(f.state.reads, 1);
  }
});
test('검증 창 중 원본·잠금·epoch가 변하면 이전 계정값으로 완료를 인정하지 않는다', async () => {
  for (const mode of ['source', 'lock', 'epoch']) {
    const f = fixture();
    if (mode === 'lock') f.state.changedLock = true;
    if (mode === 'epoch') f.state.fenced = true;
    if (mode === 'source') f.state.account = async () => { const claims = f.state.claims;
      f.state.record = { membership: { status: 'none' }, version: 'two' };
      return { uid: 'synthetic', customClaims: claims }; };
    assert.equal((await f.run()).membershipClaims.status, 'pending'); assert.equal(f.state.reads, 1);
  }
});
test('Auth 실패·시간초과·다른 UID는 인증 호출자에게 실패로 전달하고 재조회하지 않는다', async () => {
  for (const mode of ['error', 'timeout', 'uid']) {
    const f = fixture(); f.options.timeoutMs = 10;
    f.state.account = mode === 'timeout' ? () => new Promise(() => {})
      : mode === 'uid' ? async () => ({ uid: 'other' }) : async () => { throw Error('synthetic'); };
    await assert.rejects(f.run()); assert.equal(f.state.reads, 1);
  }
});
test('계정 비활성은 synced로 인정하지 않고 인증 단계에서 재검사할 현재 계정값을 유지한다', async () => {
  const f = fixture(); f.state.account = async () => ({ uid: 'synthetic', disabled: true });
  const result = await f.run(); assert.equal(result.membershipClaims.status, 'pending'); assert.equal(result.account.disabled, true);
});
