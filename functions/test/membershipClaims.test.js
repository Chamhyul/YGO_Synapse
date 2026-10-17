'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncMembershipClaims, updateAccountClaims, membershipClaim, mergeClaims } = require('../services/membershipClaims');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
const source = { status: 'active', type: 'csv', levelName: '합성 회원', userChannelId: 'synthetic-channel', verificationVersion: 2, verificationProvider: 'youtube' };
function fixture() {
  const state = { record: { membership: source, version: 'one' }, claims: { role: 'admin', admin: true, unrelated: { keep: 1 } }, writes: 0, lock: 'idle' };
  const storage = { config: resolveRtdbConfig(env), membership: { read: async () => state.record }, customClaims: {
    async acquire() { if (state.lock !== 'idle') throw new Error('busy'); state.lock = 'running'; return 'operation'; },
    async finish(_uid, _id, uncertain) { state.lock = uncertain ? 'uncertain' : 'idle'; },
  } };
  const auth = { async getUser() { if (state.read) return state.read(); return { customClaims: state.claims, disabled: state.disabled }; },
    async setCustomUserClaims(_uid, next) { state.writes++; if (state.write) return state.write(next); state.claims = next; } };
  return { state, options: { storage, auth, env, allowEmulator: true, timeoutMs: 20 } };
}
test('claims는 권한 요약만 저장하며 기존 관리자·별도 claims를 보존한다', async () => {
  const { state, options } = fixture();
  assert.deepEqual(await syncMembershipClaims('synthetic', options), { status: 'synced', version: 'one' });
  assert.deepEqual(state.claims, { role: 'admin', admin: true, unrelated: { keep: 1 }, ygoMembership: { v: 1, active: true, provider: 'youtube', version: 'one' } });
  assert.doesNotMatch(JSON.stringify(state.claims), /levelName|userChannelId|합성/);
  await syncMembershipClaims('synthetic', options); assert.equal(state.writes, 1); assert.equal(state.lock, 'idle');
});
test('미검증 멤버십은 active claim으로 승격하지 않으며 관리자 혜택과 분리된다', () => {
  assert.equal(membershipClaim({ membership: { status: 'active', type: 'csv' }, version: 'old' }).active, false);
  assert.deepEqual(membershipClaim({ version: '0' }), { v: 1, active: false, provider: 'none', version: '0' });
});
test('claims 전체 1000바이트 제한은 UTF-8로 검사하고 기존 claims를 버리지 않는다', async () => {
  assert.throws(() => mergeClaims({ existing: '가'.repeat(334) }, {}), { code: 'MEMBERSHIP_CLAIMS_TOO_LARGE' });
  const { state, options } = fixture(); state.claims = { existing: 'x'.repeat(950) };
  assert.equal((await syncMembershipClaims('synthetic', options)).status, 'pending'); assert.equal(state.writes, 0); assert.equal(state.claims.existing.length, 950);
});
test('Auth 응답 미확정은 원본을 보존하고 다음 writer를 막는다', async () => {
  const { state, options } = fixture(); state.write = async () => { throw new Error('synthetic secret'); };
  assert.deepEqual(await syncMembershipClaims('synthetic', options), { status: 'pending' });
  assert.equal(state.lock, 'uncertain'); assert.deepEqual(state.record.membership, source);
  await syncMembershipClaims('synthetic', options); assert.equal(state.writes, 1);
});
test('Auth 쓰기 시간초과 뒤 늦은 성공은 새 writer로 덮어쓰지 않는다', async () => {
  const { state, options } = fixture(); let complete;
  state.write = next => new Promise(resolve => { complete = () => { state.claims = next; resolve(); }; });
  assert.equal((await syncMembershipClaims('synthetic', options)).status, 'pending');
  assert.equal(state.lock, 'uncertain'); complete();
  await assert.rejects(updateAccountClaims('synthetic', { role: 'none', admin: false }, options)); assert.equal(state.writes, 1);
});
test('쓰기 전 Auth 실패·명확한 거부는 잠금을 해제하고 재시도할 수 있다', async () => {
  for (const mode of ['read', 'denied', 'disabled']) {
    const { state, options } = fixture();
    if (mode === 'read') state.read = () => new Promise(() => {});
    if (mode === 'denied') state.write = async () => { throw Object.assign(new Error('denied'), { code: 'auth/insufficient-permission' }); };
    if (mode === 'disabled') state.disabled = true;
    assert.equal((await syncMembershipClaims('synthetic', options)).status, 'pending'); assert.equal(state.lock, 'idle');
  }
});
test('Auth 저장 중 RTDB 원본 변경은 최신 버전으로 다시 동기화한다', async () => {
  const { state, options } = fixture(); state.write = async next => {
    state.claims = next; state.record = { membership: { status: 'none' }, version: 'two' };
  };
  assert.deepEqual(await syncMembershipClaims('synthetic', options), { status: 'synced', version: 'two' });
  assert.equal(state.writes, 2); assert.equal(state.claims.ygoMembership.active, false);
});
test('같은 UID 멤버십 writer 실행 중 관리자 변경은 거부하고 재시도시 두 claims를 보존한다', async () => {
  const { state, options } = fixture(); let enter, finish;
  const started = new Promise(resolve => { enter = resolve; });
  state.write = next => new Promise(resolve => { finish = () => { state.claims = next; resolve(); }; enter(); });
  const pending = syncMembershipClaims('synthetic', { ...options, timeoutMs: 1000 }); await started;
  await assert.rejects(updateAccountClaims('synthetic', { role: 'none', admin: false }, options));
  finish(); await pending; state.write = undefined;
  await updateAccountClaims('synthetic', { role: 'none', admin: false }, options);
  assert.equal(state.claims.admin, false); assert.equal(state.claims.ygoMembership.active, true); assert.deepEqual(state.claims.unrelated, { keep: 1 });
});
test('실제 의존성 없는 시험 및 잘못된 설정은 Auth를 호출하지 않는다', async () => {
  const { state, options } = fixture();
  for (const override of [{ allowEmulator: false }, { env: { USER_STORAGE_BACKEND: 'wrong' } }, { storage: { ...options.storage, config: {} } }]) {
    assert.deepEqual(await syncMembershipClaims('synthetic', { ...options, ...override }), { status: 'pending' });
  }
  assert.equal(state.writes, 0); assert.equal(state.lock, 'idle');
});
test('기존 저장소 관리자 변경도 기존 멤버십과 별도 claims를 보존한다', async () => {
  const { state, options } = fixture(); state.claims.ygoMembership = { v: 1, active: true };
  await updateAccountClaims('synthetic', { role: 'none', admin: false }, { ...options, env: {} });
  assert.equal(state.claims.ygoMembership.active, true); assert.equal(state.claims.admin, false); assert.deepEqual(state.claims.unrelated, { keep: 1 });
});
test('관리자는 비활성 계정에서도 기존처럼 역할을 회수할 수 있다', async () => {
  const { state, options } = fixture(); state.disabled = true;
  await updateAccountClaims('synthetic', { role: 'none', admin: false }, options);
  assert.equal(state.claims.admin, false); assert.equal(state.claims.role, 'none');
});
test('원본 재시도는 하나의 시간 예산을 공유하며 예산 뒤 Auth 쓰기를 시작하지 않는다', async () => {
  const { state, options } = fixture(); let reads = 0;
  options.storage.membership.read = async () => {
    reads++;
    if (reads === 2) return { membership: { status: 'none' }, version: 'changed' };
    if (reads === 3) await new Promise(resolve => setTimeout(resolve, 40));
    return state.record;
  };
  assert.equal((await syncMembershipClaims('synthetic', options)).status, 'pending');
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(state.writes, 1); assert.equal(state.lock, 'idle');
});

test('설정의 대상 권한 검사는 RTDB claims 잠금 안에서 쓰기 직전에 수행한다', async () => {
  const {state,options}=fixture();state.claims.role='owner';
  await assert.rejects(updateAccountClaims('synthetic',{role:'admin',admin:true},{...options,validateCurrentClaims:require('../services/adminAccounts').roleGuard('none',true)}),{status:403});
  assert.equal(state.writes,0);assert.equal(state.lock,'idle');assert.equal(state.claims.role,'owner');
});
