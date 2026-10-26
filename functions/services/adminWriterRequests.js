'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { accountResource } = require('./user-storage/accountResource');
const { createStorageAccess } = require('./user-storage/storageAccess');
const fail = code => Object.assign(new Error('관리자 작업의 전환 상태를 확인해 주세요.'), { code, status: 503 });
const id = () => randomBytes(16).toString('hex');
function checkAdminResource(key) {
  if (key !== 'notice/publication' && !/^adminRequest\/[a-f0-9]{32}$/.test(key)) throw fail('ADMIN_WRITER_INVALID_RESOURCE');
}
function createAdminWriterRequests({ transition, initialize, initializeMissing = true, db, database, timeoutMs = 10000 }) {
  const requests = new AsyncLocalStorage(), publications = new AsyncLocalStorage();
  const access = createStorageAccess({ database, timeoutMs });
  async function wait(action) {
    const expires = Date.now() + timeoutMs;
    while (true) {
      try { return await action(); }
      catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= expires) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
  }
  async function auditLegacyLocks() {
    const snapshot = await access.guarded(db.collection('AdminNoticeLocks').limit(1).get(), false);
    if (!snapshot.empty) throw fail('NOTICE_LEGACY_LOCK_MIGRATION_REQUIRED');
  }
  async function withRequest(req, action) {
    if (requests.getStore()) return action();
    const initialized = await initialize(), requestId = id();
    const context = { writer: initializeMissing ? await transition.route() : initialized, id: requestId,
      resources: new Set([`adminRequest/${requestId}`]) };
    await wait(() => transition.beginExternal(context.writer, context.id, [`adminRequest/${context.id}`]));
    try { return await requests.run(context, action); }
    finally { await transition.endExternal(context.id); }
  }
  async function withReadRequest(_req, action) {
    // Auth 목록 조회에는 업무 쓰기나 계정 잠금이 없다. 초기화도 수행하지 않는다.
    const before = await transition.route();
    const value = await action();
    const after = await transition.route();
    if (before.backend !== after.backend || before.epoch !== after.epoch || before.phase !== after.phase) throw fail('WRITER_FENCED');
    return value;
  }
  async function reserveAccounts(uids) {
    const context = requests.getStore(); if (!context) throw fail('ADMIN_WRITER_REQUEST_REQUIRED');
    const resources = [...new Set(uids)].flatMap(uid => [accountResource(uid), `fs/users/${uid}`, `inventory/${uid}`]);
    const reserve = async () => {
      const missing = resources.filter(key => !context.resources.has(key));
      if (!missing.length) return;
      await wait(() => transition.addExternalResources(context.id, missing));
      for (const key of missing) context.resources.add(key);
    };
    const pending = (context.reserveTail || Promise.resolve()).then(reserve);
    context.reserveTail = pending.catch(() => {});
    await pending;
  }
  async function withPublication(action, parent) {
    if (publications.getStore()) return action();
    parent ||= requests.getStore();
    const initialized = parent?.writer || await initialize();
    await auditLegacyLocks();
    if (parent?.id) await wait(() => transition.addExternalResources(parent.id, ['notice/publication']));
    const context = { writer: parent?.writer || (initializeMissing ? await transition.route() : initialized), id: id(), uncertain: false };
    await wait(() => transition.beginExternal(context.writer, context.id, ['notice/publication'], { parentId: parent?.id }));
    try { return await publications.run(context, action); }
    finally { await transition.endExternal(context.id, context.uncertain); }
  }
  return { withRequest, withReadRequest, reserveAccounts, withPublication, auditLegacyLocks,
    writerLease: () => requests.getStore(), publicationLease: () => publications.getStore() };
}
module.exports = { createAdminWriterRequests, checkAdminResource };
