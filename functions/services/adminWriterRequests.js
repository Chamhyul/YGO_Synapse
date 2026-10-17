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
function createAdminWriterRequests({ transition, initialize, db, database, timeoutMs = 10000 }) {
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
    await initialize(); const context = { writer: await transition.route(), id: id() };
    await wait(() => transition.beginExternal(context.writer, context.id, [`adminRequest/${context.id}`]));
    try { return await requests.run(context, action); }
    finally { await transition.endExternal(context.id); }
  }
  async function reserveAccounts(uids) {
    const context = requests.getStore(); if (!context) throw fail('ADMIN_WRITER_REQUEST_REQUIRED');
    const resources = [...new Set(uids)].flatMap(uid => [accountResource(uid), `fs/users/${uid}`, `inventory/${uid}`]);
    await wait(() => transition.addExternalResources(context.id, resources));
  }
  async function withPublication(action, parent) {
    if (publications.getStore()) return action();
    await initialize(); await auditLegacyLocks();
    parent ||= requests.getStore();
    if (parent?.id) await wait(() => transition.addExternalResources(parent.id, ['notice/publication']));
    const context = { writer: parent?.writer || await transition.route(), id: id(), uncertain: false };
    await wait(() => transition.beginExternal(context.writer, context.id, ['notice/publication'], { parentId: parent?.id }));
    try { return await publications.run(context, action); }
    finally { await transition.endExternal(context.id, context.uncertain); }
  }
  return { withRequest, reserveAccounts, withPublication, auditLegacyLocks,
    writerLease: () => requests.getStore(), publicationLease: () => publications.getStore() };
}
module.exports = { createAdminWriterRequests, checkAdminResource };
