'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
async function setup(backend) {
  const f = await fixture(); await f.binding.transition.initialize();
  if (backend === 'rtdb') { const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w); }
  const auth = f.binding.auth, at = Math.floor(Date.now() / 1000);
  auth.verifyIdToken = async token => { if (token !== 'owner') throw Object.assign(Error('synthetic'), { code: 'auth/invalid-id-token' }); return { uid: f.owner, auth_time: at }; };
  const ops = f.load('functions/services/adminWriterOperations.js').createWriterAdminOperations({ env: f.env, writerBinding: f.binding, auth });
  const journal = createWriterJournalStore({ database: f.connection.targetDatabase });
  return { ...f, auth, ops, read: () => journal.read(f.config.runId) };
}
for (const backend of ['legacy', 'rtdb']) test(`${backend}: 관리자 읽기 API는 멤버십 잠금과 겹쳐도 journal·업무 데이터를 쓰지 않는다`, async () => {
  const f = await setup(backend); let release, ready, holder;
  const gate = new Promise(r => { release = r; }), entered = new Promise(r => { ready = r; });
  try {
    holder = f.binding.membership.withVerification(f.owner, 'discord', async () => { ready(); await gate; }); await entered;
    const before = await f.read();
    f.binding.adminRequests.reserveAccounts = () => assert.fail('읽기의 계정 잠금 금지');
    for (const [operation, body] of [['checkAdminAccess', {}], ['checkAdminAccess', { scope: 'settings' }],
      ['manageAdminRole', { action: 'list' }], ['manageAdminRole', { action: 'settingsList' }],
      ['manageAdminRole', { action: 'settingsLookup', kind: 'uid', value: f.uid }]]) {
      const result = await call(f.ops[operation], { token: 'owner', body });
      assert.equal(result.statusCode, 200); assert.equal(result.body.success, true); assert.deepEqual(await f.read(), before);
    }
    release(); await holder;
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { release(); await holder?.catch(() => {}); await f.close(); }
});
for (const problem of ['role', 'disabled', 'revoked', 'expired', 'auth-unavailable', 'epoch']) test(`읽기 도중 ${problem} 변경은 목록 본문을 반환하지 않는다`, async () => {
  const f = await setup('rtdb'); const list = f.auth.listUsers; let expired = false;
  try {
    if (problem === 'expired') { const verify = f.auth.verifyIdToken; f.auth.verifyIdToken = token => { if (expired) throw Object.assign(Error('synthetic'), { code: 'auth/id-token-expired' }); return verify(token); }; }
    f.auth.listUsers = async (...args) => {
      const page = await list(...args);
      if (problem === 'role') await f.connection.auth.setCustomUserClaims(f.owner, { role: 'none', admin: false });
      if (problem === 'disabled') await f.connection.auth.updateUser(f.owner, { disabled: true });
      if (problem === 'revoked') { await new Promise(r => setTimeout(r, 1100)); await f.connection.auth.revokeRefreshTokens(f.owner); }
      if (problem === 'expired') expired = true;
      if (problem === 'auth-unavailable') f.auth.getUser = async () => { throw Error('synthetic'); };
      if (problem === 'epoch') { const w = await f.binding.transition.route(); await f.binding.transition.drain(w); await f.binding.transition.resume(w, { id: 'd'.repeat(32), writersDrained: true }); }
      return page;
    };
    const result = await call(f.ops.manageAdminRole, { token: 'owner', body: { action: 'settingsList' } });
    assert.notEqual(result.statusCode, 200); assert.equal(result.body.accounts, undefined); assert.equal(result.body.success, false);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('일반 자격 조회의 응답 역할은 마지막 Auth 확인 값을 사용한다', async () => {
  const f = await setup('rtdb'); const get = f.auth.getUser; let reads = 0;
  try {
    f.auth.getUser = async (...args) => {
      if (++reads === 2) await f.connection.auth.setCustomUserClaims(f.owner, { role: 'admin', admin: true });
      return get(...args);
    };
    const response = await call(f.ops.checkAdminAccess, { token: 'owner' });
    assert.equal(response.statusCode, 200); assert.equal(response.body.role, 'admin');
  } finally { await f.close(); }
});
