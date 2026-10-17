'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectMembershipClaims, recoverMembershipClaims, membershipClaim } = require('../services/membershipClaims');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
const id = 'a'.repeat(32), nextId = 'b'.repeat(32);
function fixture() {
  const state = { lock: { state: 'uncertain', operationId: id, startedAt: 1 }, record: { membership: { status: 'none' }, version: '0' },
    claims: { role: 'owner', admin: true, another: { keep: 1 } }, writes: 0, acquisitions: 0, finished: 0 };
  const auth = { async getUser() { if (state.onRead) await state.onRead(); return { customClaims: state.claims, disabled: state.disabled }; },
    async setCustomUserClaims(_uid, next) { state.writes++; if (state.onWrite) return state.onWrite(next); state.claims = next; } };
  const storage = { config: resolveRtdbConfig(env), membership: { async read() { if (state.onSource) await state.onSource(); return structuredClone(state.record); } },
    customClaims: {
      async inspect() { return structuredClone(state.lock); },
      async beginRecovery(_uid, expected, options) {
        assert.equal(options.writersDrained, true);
        if (!['running', 'uncertain'].includes(state.lock.state) || expected !== state.lock.operationId) throw Object.assign(new Error(), { code: 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT' });
        state.acquisitions++; state.lock = { state: 'running', operationId: nextId, startedAt: 2, recoveryOf: expected }; return nextId;
      },
      async finish(_uid, operationId, uncertain) {
        assert.equal(operationId, state.lock.operationId); state.finished++; state.lock.state = uncertain ? 'uncertain' : 'idle';
      },
    } };
  return { state, options: { env, storage, auth, allowEmulator: true, timeoutMs: 1000, writersDrained: true } };
}
test('기본 대조는 잠금·원본·Auth를 읽기만 하고 개인 정보/claims 전체를 반환하지 않는다', async () => {
  const { state, options } = fixture(); state.claims.ygoMembership = membershipClaim(state.record);
  const before = structuredClone(state);
  assert.deepEqual(await inspectMembershipClaims('synthetic', options), { state: 'uncertain', operationId: id, stable: true, matches: true, version: '0' });
  assert.deepEqual(state, before);
});
test('대조 중 원본 또는 작업이 변경되면 일치한 값도 안정된 결과로 표시하지 않는다', async () => {
  for (const target of ['source', 'lock']) {
    const { state, options } = fixture(); state.claims.ygoMembership = membershipClaim(state.record);
    state.onRead = async () => { if (target === 'source') state.record.version = 'changed'; else state.lock.operationId = nextId; };
    const result = await inspectMembershipClaims('synthetic', options); assert.equal(result.stable, false); assert.equal(result.matches, false); assert.equal(state.writes, 0);
  }
});
test('이전 writer 종료 확인 없이는 설정/SDK/잠금/권한을 변경하지 않는다', async () => {
  const { state, options } = fixture();
  for (const patch of [{ writersDrained: false }, { writersDrained: undefined }]) {
    await assert.rejects(recoverMembershipClaims('synthetic', id, { ...options, ...patch }), { code: 'MEMBERSHIP_CLAIMS_RECOVERY_CONFIRMATION_REQUIRED' });
  }
  assert.equal(state.acquisitions, 0); assert.equal(state.writes, 0);
});
test('복구는 현재 역할을 보존하며 쓰기 재조회가 일치한 뒤에만 잠금을 해제한다', async () => {
  const { state, options } = fixture(); state.disabled = true;
  const result = await recoverMembershipClaims('synthetic', id, options);
  assert.deepEqual(result, { status: 'synced', version: '0', operationId: nextId, recoveryOf: id });
  assert.deepEqual(state.claims, { role: 'owner', admin: true, another: { keep: 1 }, ygoMembership: membershipClaim(state.record) });
  assert.equal(state.lock.state, 'idle'); assert.equal(state.finished, 1);
});
test('이미 적용된 claims 복구는 Auth 쓰기를 반복하지 않는다', async () => {
  const { state, options } = fixture(); state.claims.ygoMembership = membershipClaim(state.record);
  await recoverMembershipClaims('synthetic', id, options); assert.equal(state.writes, 0); assert.equal(state.lock.state, 'idle');
});
test('오래된 작업 번호·이미 해제된 잠금은 복구를 시작하지 않는다', async () => {
  for (const mode of ['changed', 'idle']) {
    const { state, options } = fixture(); if (mode === 'idle') state.lock.state = 'idle';
    await assert.rejects(recoverMembershipClaims('synthetic', mode === 'changed' ? nextId : id, options), { code: 'MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT' });
    assert.equal(state.writes, 0); assert.equal(state.acquisitions, 0);
  }
});
test('Auth 쓰기 거부·응답 재조회 불일치·읽기 장애는 복구 잠금을 보존한다', async () => {
  for (const mode of ['write', 'mismatch', 'read']) {
    const { state, options } = fixture();
    if (mode === 'write') state.onWrite = async () => { throw Object.assign(new Error('private'), { code: 'auth/insufficient-permission' }); };
    if (mode === 'mismatch') state.onWrite = async () => {};
    if (mode === 'read') state.onRead = async () => { throw new Error('private'); };
    await assert.rejects(recoverMembershipClaims('synthetic', id, options));
    assert.equal(state.lock.state, 'uncertain'); assert.equal(state.claims.role, 'owner');
  }
});
test('재조회 뒤 원본이 바뀌면 최신 요약을 다시 맞추고 복구한다', async () => {
  const { state, options } = fixture(); state.onWrite = async next => {
    state.claims = next; if (state.writes === 1) state.record.version = 'changed';
  };
  assert.equal((await recoverMembershipClaims('synthetic', id, options)).version, 'changed');
  assert.equal(state.writes, 2); assert.equal(state.lock.state, 'idle');
});
test('복구 시간초과 후 늦은 Auth 성공에도 잠금은 자동 해제하지 않는다', async () => {
  const { state, options } = fixture(); let finish;
  state.onWrite = next => new Promise(resolve => { finish = () => { state.claims = next; resolve(); }; });
  await assert.rejects(recoverMembershipClaims('synthetic', id, { ...options, timeoutMs: 10 }), { code: 'MEMBERSHIP_CLAIMS_TIMEOUT' });
  finish(); await new Promise(resolve => setImmediate(resolve)); assert.equal(state.lock.state, 'uncertain');
});
