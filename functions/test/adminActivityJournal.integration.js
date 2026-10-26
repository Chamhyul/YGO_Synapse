'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createAdminPageHandler } = require('../services/adminPageSession');
const { accountResource } = require('../services/user-storage/accountResource');
const id = () => randomBytes(16).toString('hex');

async function fixture({ getUserHook, summaryHook, templateHook, readHook, reuseJournal = true, fuseActivity = true } = {}) {
  const runId = id(), connection = open(runId), counters = new AsyncLocalStorage();
  const database = { ref(path) {
    const ref = connection.targetDatabase.ref(path);
    return new Proxy(ref, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (['get', 'transaction'].includes(key)) return (...args) => {
        const active = counters.getStore(); if (active) { active[key]++; if (key === 'get' && /^profileWriterTransitions\/[^/]+$/.test(path)) active.journalGets++; readHook?.(path, key, active); }
        return value.apply(target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await createWriterJournalStore({ database }).update(runId, () => ({ value: {
    format: 1, backend: 'rtdb', epoch: 1, phase: 'accepting', sequence: 0,
    floor: 0, operations: {}, events: [], transfer: null, frozen: {},
  } }));
  const options = { db: connection.db, database, bucket: connection.bucket,
    FieldValue: require('firebase-admin/firestore').FieldValue, runId, initializeMissing: false, historyMaintenance: 'deferred',
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } };
  const binding = createUserInventoryWriterBinding(options), cookie = 'synthetic-' + id(), uid = 'synthetic-owner';
  const hash = createHash('sha256').update(cookie).digest('hex');
  await binding.adminSessions.set(hash, { uid, lastActivity: Date.now(), expiresAt: Date.now() + 3600000 });
  const auth = { verifySessionCookie: async () => ({ uid, auth_time: 1 }),
    getUser: async () => { const custom = await getUserHook?.(); if (custom) return custom; return { uid, disabled: false, customClaims: { role: 'owner' }, tokensValidAfterTime: new Date(0).toISOString() }; } };
  if (!fuseActivity) { binding.transition.prepareAndExecuteActivityWithReceipt = undefined; binding.transition.prepareAndExecuteActivityAdmissionWithReceipt = undefined; }
  const originalRequest = binding.adminSessions.withRequest;
  binding.adminSessions.withRequest = (req, action, options) => originalRequest(req, action, { ...options, reuseJournal: reuseJournal && options.reuseJournal });
  const handler = createAdminPageHandler({ auth, store: binding.adminSessions,
    template: async () => { await templateHook?.(); return '<html><body><div id="admin-content" data-admin-title="합성 계측">합성 본문</div></body></html>'; },
    membershipCsv: require('../services/membershipCsvService').createMembershipCsvService({ store: binding.membershipCsv }),
    getErrorSummary: async () => { await summaryHook?.(); return { syntheticPrivate: 'protected-result' }; } });
  return { ...binding, connection, options, hash, uid,
    async call(route = '/admin/session/activity') {
      const counts = { get: 0, transaction: 0, journalGets: 0 }, res = { statusCode: 200, set() { return this; }, type() { return this; },
        status(n) { this.statusCode = n; return this; }, send(value) { this.body = value; return this; }, json(value) { this.body = value; return this; } };
      await counters.run(counts, () => handler({ method: 'POST', body: { uid }, url: route, originalUrl: route, protocol: 'https',
        headers: { host: 'synthetic.example', origin: 'https://synthetic.example', 'content-type': 'application/json', cookie: '__session=' + cookie } }, res));
      return { counts, res };
    }, close: () => connection.close() };
}


for (const reuseJournal of [false, true]) test(`활동 journal 요청 재사용 ${reuseJournal}: 정상 경로 전체 읽기와 다음 요청 최신 Auth`, async () => {
  let accounts = 0, disabled = false;
  const f = await fixture({ reuseJournal, getUserHook: async () => { accounts++; if (disabled) return { uid: 'synthetic-owner', disabled: true, customClaims: { role: 'owner' } }; } });
  try {
    const { counts, res } = await f.call();
    assert.equal(res.statusCode, 204);
    assert.equal(counts.journalGets, 1);
    assert.equal(accounts, 1);
    assert.equal((await f.adminSessions.get(f.hash)).uid, f.uid);
    disabled = true; assert.equal((await f.call()).res.statusCode, 401); assert.equal(accounts, 2);
    console.log(JSON.stringify({ event: 'synthetic_admin_activity_journal', reuseJournal, fullJournalGets: counts.journalGets, transactions: counts.transaction, production: false }));
  } finally { await f.close(); }
});

test('journal 재사용 중 다른 writer의 CAS가 끼어도 외부 기록과 활동 저장을 보존한다', async () => {
  const f = await fixture(), foreign = createUserInventoryWriterBinding(f.options), foreignId = id();
  let entered = false, held = false; const adapter = f.stores.rtdb, commit = adapter.commit;
  try {
    adapter.commit = async (op, ...rest) => {
      if (!entered && op.details?.action === 'touch') {
        entered = true; await foreign.transition.beginExternal(await foreign.transition.route(), foreignId, [accountResource('synthetic-other')]); held = true;
      }
      return commit(op, ...rest);
    };
    const { res } = await f.call(); assert.equal(res.statusCode, 204); assert(entered);
    const journal = await createWriterJournalStore({ database: f.options.database }).read(foreign.transition.runId);
    assert.equal(journal.value.external[foreignId].status, 'running');
    assert.equal((await f.adminSessions.get(f.hash)).uid, f.uid);
    await foreign.transition.endExternal(foreignId); held = false; assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { if (held) await foreign.transition.endExternal(foreignId); await f.close(); }
});

test('journal 최초 조회와 보관 이력 조회는 겹쳐 실행한다', async () => {
  const { withAdminRequestTiming } = require('../services/adminRequestTiming'); let line;
  const f = await fixture();
  try {
    await withAdminRequestTiming('adminPages', async () => { assert.equal((await f.call()).res.statusCode, 204); }, { emit: value => { line = value; } })({ method: 'POST', url: '/admin/session/activity' }, { statusCode: 204 });
    const timing = typeof line === 'string' ? JSON.parse(line) : line;
    const first = timing.spans.find(s => s.name === 'journal.read'), history = timing.spans.find(s => s.name === 'journal.history_lookup');
    assert(first && history); assert(history.startMs < first.startMs + first.durationMs); assert(first.startMs < history.startMs + history.durationMs);
  } finally { await f.close(); }
});
