'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
async function setup(backend) {
  const f = await fixture(); await f.binding.transition.initialize();
  if (backend === 'rtdb') { const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer); }
  const verify = f.binding.auth.verifyIdToken, authenticatedAt = Math.floor(Date.now() / 1000);
  f.binding.auth.verifyIdToken = async (...args) => ({ ...await verify(...args), auth_time: authenticatedAt });
  const ops = f.load('functions/services/adminWriterOperations.js').createWriterAdminOperations({ env: f.env, writerBinding: f.binding, auth: f.binding.auth });
  const journal = createWriterJournalStore({ database: f.connection.targetDatabase });
  return { ...f, ops, journal, read: () => journal.read(f.config.runId) };
}
for (const backend of ['legacy', 'rtdb']) test(`${backend}: 무인증·위조·비관리자·잘못된 메서드는 실제 journal을 전혀 변경하지 않는다`, async () => {
  const f = await setup(backend);
  try {
    for (const operation of ['checkAdminAccess', 'manageNotice', 'manageAdminRole', 'uploadMembershipCsv']) {
      for (const options of [{ headers: { authorization: undefined } }, { token: 'forged' }, { token: 'member' }, { method: 'GET', token: 'owner' }]) {
        const before = await f.read(); const response = await call(f.ops[operation], { body: { action: 'list' }, ...options });
        assert([401,403,405].includes(response.statusCode)); assert.deepEqual(await f.read(), before);
      }
    }
    const before = await f.read();
    await f.connection.auth.setCustomUserClaims(f.owner, { role: 'admin', admin: true });
    assert.equal((await call(f.ops.manageAdminRole, { token: 'owner', body: { action: 'setAdmin', targetUid: f.uid, isAdmin: true } })).statusCode, 403);
    assert.deepEqual(await f.read(), before); assert.equal((await f.connection.auth.getUser(f.uid)).customClaims?.admin, undefined);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) for (const problem of ['role', 'disabled', 'revoked']) test(`${backend}: 실제 계정 잠금 대기 중 ${problem} 변경은 새 자격으로 거부하고 기록을 정상 종료한다`, async () => {
  const f = await setup(backend); let release, entered, pending, holder;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try {
    holder = f.binding.adminRequests.withRequest({}, async () => { await f.binding.adminRequests.reserveAccounts([f.owner]); entered(); await gate; }); await ready;
    let reserved; const waiting = new Promise(resolve => { reserved = resolve; });
    const reserve = f.binding.adminRequests.reserveAccounts;
    f.binding.adminRequests.reserveAccounts = (...args) => { reserved(); return reserve(...args); };
    pending = call(f.ops.manageNotice, { token: 'owner', body: { action: 'add', title: 'synthetic', content: '<p>synthetic</p>' } }); await waiting;
    if (problem === 'role') await f.connection.auth.setCustomUserClaims(f.owner, { role: 'none', admin: false });
    if (problem === 'disabled') await f.connection.auth.updateUser(f.owner, { disabled: true });
    if (problem === 'revoked') { await new Promise(resolve => setTimeout(resolve, 1100)); await f.connection.auth.revokeRefreshTokens(f.owner); }
    release(); await holder;
    const response = await pending; assert.equal(response.statusCode, problem === 'role' ? 403 : 401);
    assert.equal((await f.binding.notices.list()).notices.length, 0);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { release(); await Promise.allSettled([holder, pending].filter(Boolean)); await f.close(); }
});
