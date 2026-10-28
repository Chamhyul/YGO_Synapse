'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { beginLoginMembershipCheck, membershipClaim } = require('../services/membershipClaims');
const { resolveRtdbConfig } = require('../config/userStorage');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-storage',
  FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-storage-default-rtdb' };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(change = {}) {
  const state = { log: [], reads: 0, writes: 0, revision: 1, routes: 0, ...change };
  state.record = { membership: { status: 'none' }, version: 'one' };
  state.account = { uid: 'synthetic', customClaims: { preserved: true, ygoMembership: membershipClaim(state.record) } };
  const storage = { config: resolveRtdbConfig(env), membership: { read: async () => {
    state.log.push('source'); if (state.sourceError) throw Error('synthetic'); return state.record;
  } }, customClaims: {
    observe: async () => { state.log.push('lock'); await state.lockGate?.promise;
      return { revision: state.revision, generation: 0, value: state.absent ? undefined
        : { state: state.lock || 'idle', operationId: 'a'.repeat(32) } }; },
    isSettled: async () => { state.log.push('evidence'); await state.evidenceGate?.promise;
      if (state.evidenceError) throw Error('synthetic'); return !state.unsettled; },
    acquire: async () => { state.writes++; return 'b'.repeat(32); }, finish: async () => {},
  }, writerTransition: { route: async () => { state.log.push('route'); state.routes++;
    await state.routeGate?.promise; return { backend: 'rtdb', epoch: state.fenced && state.routes > 1 ? 2 : 1, phase: 'accepting' }; } } };
  const auth = { getUser: async () => { state.log.push('account'); state.reads++;
    if (state.accountError) throw Error('synthetic'); return state.account; },
    setCustomUserClaims: async (_uid, claims) => { state.writes++; state.account.customClaims = claims; } };
  return { state, start: () => beginLoginMembershipCheck('synthetic', { env, storage, auth,
    allowEmulator: true, timeoutMs: 100, readAccount: () => auth.getUser() }) };
}
test('최초 route·잠금을 함께 읽고 검증 창의 계정1회를 인증에 먼저 돌려준다', async () => {
  const routeGate = gate(), lockGate = gate(), evidenceGate = gate(), f = fixture({ routeGate, lockGate, evidenceGate });
  const check = f.start(); await tick();
  assert(f.state.log.includes('route')); assert(f.state.log.includes('lock'));
  assert(!f.state.log.includes('account'));
  routeGate.resolve(); lockGate.resolve();
  assert.equal((await check.account).uid, 'synthetic');
  let done = false; check.checked.then(() => { done = true; }); await tick();
  assert.equal(done, false); assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
  evidenceGate.resolve(); const result = await check.checked;
  assert.equal(result.claims.status, 'synced'); assert.equal(result.repair, undefined);
  assert.equal(f.state.reads, 1); assert.equal(f.state.routes, 2);
});
for (const mode of ['running', 'uncertain', 'source-error', 'evidence-error', 'disabled', 'epoch', 'lock-change', 'source-change']) {
  test(`${mode}는 성공으로 바꾸거나 사전 권한 쓰기를 실행하지 않는다`, async () => {
    const evidenceGate = gate(), f = fixture({ evidenceGate });
    if (['running', 'uncertain'].includes(mode)) f.state.lock = mode;
    if (mode === 'source-error') f.state.sourceError = true;
    if (mode === 'evidence-error') f.state.evidenceError = true;
    if (mode === 'disabled') f.state.account.disabled = true;
    if (mode === 'epoch') f.state.fenced = true;
    const check = f.start(); assert.equal((await check.account).uid, 'synthetic');
    if (mode === 'lock-change') f.state.revision++;
    if (mode === 'source-change') f.state.record = { ...f.state.record, version: 'two' };
    evidenceGate.resolve();
    const result = await check.checked;
    assert.equal(result.claims.status, 'pending'); assert.equal(result.repair, undefined);
    assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
  });
}
test('불일치는 읽기 결과와 repair를 분리하고 실제 쓰기는 호출 뒤 fresh 계정으로 수행한다', async () => {
  const f = fixture(); f.state.account.customClaims.ygoMembership = { active: true };
  const check = f.start(); await check.account;
  const result = await check.checked;
  assert.equal(result.claims.status, 'pending'); assert.equal(typeof result.repair, 'function');
  assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
  assert.equal((await result.repair()).status, 'synced');
  assert.equal(f.state.reads, 3); assert.equal(f.state.writes, 2);
  assert.equal(f.state.account.customClaims.preserved, true);
});
test('Auth 실패·다른 UID는 인증 호출자에게 전달하며 DB 결과로 대체하지 않는다', async () => {
  for (const mode of ['failure', 'uid']) {
    const f = fixture(); if (mode === 'failure') f.state.accountError = true; else f.state.account.uid = 'other';
    const check = f.start(); await assert.rejects(check.account);
    assert.equal((await check.checked).claims.status, 'pending'); assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
  }
});
test('불일치의 완료 증거 읽기는 결과 판정을 막지 않고 요청 종료 전에 별도로 회수한다', async () => {
  const evidenceGate = gate(), f = fixture({ evidenceGate });
  f.state.account.customClaims.ygoMembership = { active: true };
  const check = f.start(); await check.account; const result = await check.checked;
  assert.equal(typeof result.repair, 'function');
  let drained = false; const finishing = check.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); evidenceGate.resolve(); await finishing;
  assert.equal(f.state.writes, 0);
});
