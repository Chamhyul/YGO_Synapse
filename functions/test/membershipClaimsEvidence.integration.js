'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./commonWriterFixture.cjs');
const { createRecordStore } = require('../services/user-storage/recordStore');
const source = { status: 'active', type: 'csv', levelName: '합성 회원', userChannelId: 'UC' + 'x'.repeat(22),
  verificationVersion: 2, verificationProvider: 'youtube', lastChecked: 1 };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function reached(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic-parallel-read-not-started')), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function setup() {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const w = await f.binding.transition.route(); await f.binding.transition.copy(w);
    await f.binding.transition.drain(w); await f.binding.transition.activate(w);
    await f.connection.auth.setCustomUserClaims(f.uid, { role: 'owner', admin: true, preserve: 'synthetic' });
    await f.binding.repository.updateSettings(f.uid, { membership: source });
    f.claims = f.load('functions/services/membershipClaims.js');
    assert.equal((await f.claims.syncMembershipClaims(f.uid)).status, 'synced');
    f.storage = f.binding.claimsStorage;
    f.read = options => f.claims.readMembershipClaimsAfterVerification(f.uid, options);
    return f;
  } catch (error) { await f.close(); throw error; }
}
function holdEvidence(f) {
  const entered = gate(), release = gate(), original = f.storage.customClaims.isSettled;
  f.storage.customClaims.isSettled = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  return { entered, release, close() { release.resolve(); f.storage.customClaims.isSettled = original; } };
}
test('완료 증거와 fresh Auth는 서로의 응답을 기다리지 않고 시작하며 읽기만 수행한다', { timeout: 30000 }, async () => {
  const f = await setup(), evidence = holdEvidence(f), account = gate(), release = gate(); let pending;
  try {
    const before = await f.binding.transition.inspect(), old = await f.storage.customClaims.observe(f.uid);
    const claims = (await f.connection.auth.getUser(f.uid)).customClaims;
    f.storage.customClaims.acquire = () => assert.fail('읽기에서 잠금 쓰기 금지');
    const auth = { getUser: async uid => { account.resolve(); await release.promise; return f.connection.auth.getUser(uid); },
      setCustomUserClaims: () => assert.fail('읽기에서 Auth 쓰기 금지') };
    pending = f.read({ auth }); await reached(account.promise); await reached(evidence.entered.promise);
    evidence.release.resolve(); release.resolve(); assert.equal((await pending).status, 'synced');
    assert.deepEqual(await f.binding.transition.inspect(), before);
    assert.deepEqual(await f.storage.customClaims.observe(f.uid), old);
    assert.deepEqual((await f.connection.auth.getUser(f.uid)).customClaims, claims);
  } finally { release.resolve(); evidence.close(); await Promise.allSettled([pending].filter(Boolean)); await f.close(); }
});
for (const change of ['source', 'lock-revision', 'drain', 'disabled']) test(`완료 증거를 기다리는 중 ${change} 변경은 synced로 반환하지 않는다`, { timeout: 30000 }, async () => {
  const f = await setup(), evidence = holdEvidence(f), sourceRead = gate(), authGate = gate(); let pending;
  const window = f.storage.membership.withReadWindow;
  f.storage.membership.withReadWindow = (uid, action) => window(uid, scope => action({ ...scope,
    read: async () => { const value = await scope.read(); sourceRead.resolve(); return value; } }));
  try {
    // disabled도 fresh Auth 자체를 늦춰 실제 새 계정 상태로 확인한다.
    const auth = change === 'disabled' ? {
      getUser: async uid => { await authGate.promise; return f.connection.auth.getUser(uid); },
      setCustomUserClaims: () => assert.fail('비활성 계정 쓰기 금지'),
    } : undefined;
    pending = f.read(auth ? { auth } : undefined); await reached(evidence.entered.promise); await reached(sourceRead.promise);
    if (change === 'source') await f.binding.repository.updateSettings(f.uid, { membership: { ...source, status: 'none', lastChecked: 2 } });
    if (change === 'lock-revision') {
      const records = createRecordStore({ database: f.connection.targetDatabase, path: 'customClaimsSync' });
      const current = await records.read(f.uid); await records.compareAndSet(f.uid, current.revision, current.value);
    }
    if (change === 'drain') await f.binding.transition.drain(await f.binding.transition.route());
    if (change === 'disabled') await f.connection.auth.updateUser(f.uid, { disabled: true });
    authGate.resolve(); evidence.release.resolve(); assert.equal((await pending).status, 'pending');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { authGate.resolve(); evidence.close(); await Promise.allSettled([pending].filter(Boolean)); f.storage.membership.withReadWindow = window; await f.close(); }
});
for (const failure of ['missing', 'read-error']) test(`일치한 claims의 완료 증거 ${failure}는 pending이며 쓰기·복구를 자동 실행하지 않는다`, async () => {
  const f = await setup();
  try {
    const before = await f.binding.transition.inspect();
    f.storage.customClaims.isSettled = async () => { if (failure === 'read-error') throw Error('synthetic-evidence-read'); return false; };
    assert.equal((await f.read()).status, 'pending');
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { await f.close(); }
});
test('부가 증거 읽기가 실패해도 불일치 claims의 기존 동기 복구를 막지 않는다', async () => {
  const f = await setup();
  try {
    const prior = (await f.connection.auth.getUser(f.uid)).customClaims;
    await f.connection.auth.setCustomUserClaims(f.uid, { ...prior, ygoMembership: { ...prior.ygoMembership, version: 'old-synthetic-version' } });
    f.storage.customClaims.isSettled = async () => { throw Error('synthetic-evidence-read'); };
    assert.equal((await f.read()).status, 'pending');
    assert.equal((await f.claims.syncMembershipClaims(f.uid)).status, 'synced');
    assert.deepEqual((await f.connection.auth.getUser(f.uid)).customClaims, prior);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('Auth 실패도 이미 시작한 완료 증거 읽기를 회수한 뒤 pending으로 끝낸다', async () => {
  const f = await setup(), evidence = holdEvidence(f); let pending, done = false;
  try {
    const auth = { getUser: async () => { throw Error('synthetic-auth-read'); }, setCustomUserClaims: () => assert.fail('실패 시 쓰기 금지') };
    pending = f.read({ auth }).then(value => { done = true; return value; });
    await reached(evidence.entered.promise); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(done, false);
    evidence.release.resolve(); assert.equal((await pending).status, 'pending');
  } finally { evidence.close(); await Promise.allSettled([pending].filter(Boolean)); await f.close(); }
});
test('병렬 읽기가 시간 예산을 넘기면 pending이며 늦은 읽기 성공은 권한을 저장하지 않는다', async () => {
  const f = await setup(), release = gate(), entered = gate();
  try {
    const account = await f.connection.auth.getUser(f.uid), before = await f.binding.transition.inspect();
    const auth = { getUser: async () => { entered.resolve(); await release.promise; return account; },
      setCustomUserClaims: () => assert.fail('시간초과 뒤 Auth 쓰기 금지') };
    const pending = f.read({ auth, timeoutMs: 60 }); await reached(entered.promise);
    assert.equal((await pending).status, 'pending'); release.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await f.binding.transition.inspect(), before);
    assert.deepEqual((await f.connection.auth.getUser(f.uid)).customClaims, account.customClaims);
  } finally { release.resolve(); await f.close(); }
});
