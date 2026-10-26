'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { withAdminRequestTiming } = require('../services/adminRequestTiming');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');

async function setup() {
  const f = await fixture(); await f.binding.transition.initialize();
  const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
  await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
  const hash = createHash('sha256').update('synthetic-session').digest('hex'), time = Date.now();
  const original = { uid: f.owner, lastActivity: time - 1000, expiresAt: time + 3600000 };
  await f.binding.adminSessions.set(hash, original);
  // 합성 모듈 loader와 실제 binding이 같은 계측 범위를 사용한다.
  f.mock('functions/services/adminRequestTiming.js', require('../services/adminRequestTiming'));
  f.mock('functions/services/inventoryRequestTiming.js', require('../services/inventoryRequestTiming'));
  const handler = f.load('functions/services/adminSessionRepository.js').createConfiguredAdminPageHandler({
    auth: f.binding.auth, now: () => time,
    template: async () => '<html><body><div id="admin-content">합성 본문</div></body></html>',
  }, { env: f.env, writerBinding: f.binding });
  const database = f.connection.targetDatabase, ref = database.ref.bind(database), listeners = new Set();
  let fault, bodyGets = 0, archiveGets = 0, bodyTransactions = 0, afterRead;
  database.ref = path => {
    const target = ref(path), body = path === `adminSessions/${encodeKey(hash)}`, archive = path.startsWith('adminSessionWriterReceipts/');
    return new Proxy(target, { get(target, key) {
      if (key === 'get' && (body || archive)) return async () => {
        if (body) bodyGets++; else archiveGets++;
        const result = await target.get();
        if (body && afterRead) { const hook = afterRead; afterRead = null; await hook(); }
        return result;
      };
      if (key === 'on' && (body || archive)) return (event, callback, ...rest) => {
        listeners.add(callback); return target.on(event, callback, ...rest);
      };
      if (key === 'off' && (body || archive)) return (event, callback) => {
        listeners.delete(callback); return target.off(event, callback);
      };
      if (key === 'transaction' && (body || archive)) return async (...args) => {
        if (body) bodyTransactions++;
        if (archive && fault === 'archive-before') throw Error('synthetic-archive-failure');
        const result = await target.transaction(...args);
        if (archive && fault === 'archive-after') throw Object.assign(Error('synthetic-archive-ack-loss'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
        if (body && fault === 'native-after') throw Object.assign(Error('synthetic-native-ack-loss'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return { ...f, hash, original, time, ref, listeners,
    fail: value => { fault = value; }, afterRead: hook => { afterRead = hook; },
    counts: () => ({ bodyGets, archiveGets, bodyTransactions }),
    async request() {
      let timing;
      const timed = withAdminRequestTiming('adminPages', handler, { emit: value => { timing = typeof value === 'string' ? JSON.parse(value) : value; } });
      const res = await call(timed, { url: '/admin/session/activity', token: 'owner', body: { uid: f.owner },
        headers: { cookie: '__session=synthetic-session', host: 'ygo-synapse.web.app', origin: 'https://ygo-synapse.web.app', 'content-type': 'application/json' } });
      return { res, timing };
    },
  };
}

test('정상 활동은 fresh native 조회3회·보관 조회1회와 확정 snapshot을 사용하고 구독을 해제한다', async () => {
  const f = await setup();
  try {
    const { res, timing } = await f.request(); assert.equal(res.statusCode, 204);
    const counts = f.counts(); assert.deepEqual(counts, { bodyGets: 3, archiveGets: 1, bodyTransactions: 1 });
    assert.equal(f.listeners.size, 0);
    const firstGet = timing.spans.find(s => s.name === 'record.get' && s.parent === timing.spans.find(v => v.name === 'admin.session.get').id);
    const observe = timing.spans.find(s => s.name === 'record.observe' && s.parent === firstGet.parent);
    assert(firstGet && observe); assert(observe.startMs < firstGet.startMs + firstGet.durationMs);
    const saved = await f.binding.adminSessions.get(f.hash);
    assert.equal(saved.lastActivity, f.time); assert.equal(saved.expiresAt, f.original.expiresAt);
    console.log(JSON.stringify({ event: 'synthetic_session_native_roundtrips', ...counts, production: false }));
  } finally { await f.close(); }
});

for (const mode of ['archive-before', 'archive-after', 'native-after']) test(`${mode}: 실패를 성공으로 반환하지 않고 fresh 영수증으로 복구한다`, async () => {
  const f = await setup();
  try {
    f.fail(mode); assert.equal((await f.request()).res.statusCode, 503); assert.equal(f.listeners.size, 0);
    if (mode.startsWith('archive-')) assert.equal(f.counts().bodyTransactions, 0);
    f.fail(null);
    const state = (await createWriterJournalStore({ database: f.connection.targetDatabase }).read(f.config.runId)).value;
    const op = Object.values(state.operations).find(v => v.details?.action === 'touch');
    assert.equal(op.status, 'executing'); assert.equal(state.external[op.parentExternal].status, 'running');
    const writer = await f.binding.transition.route(); await f.binding.transition.drain(writer);
    const options = { operation: op.id, parentRequest: op.parentExternal, recoveryRequest: id() };
    const preview = await f.binding.transition.previewSessionRecovery(writer, options);
    assert.equal(preview.action, mode === 'native-after' ? 'recover' : 'fence');
    await f.binding.transition.recoverSession(writer, { ...options, expectedPreview: preview.previewDigest, writersDrained: true });
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.binding.adminSessions.get(f.hash)).lastActivity, mode === 'native-after' ? f.time : f.original.lastActivity);
  } finally { await f.close(); }
});

for (const replacement of [false, true]) test(`fresh snapshot 뒤 세션 ${replacement ? '재발급' : '삭제'}와 겹쳐도 이전 revision으로 활동을 반영하지 않는다`, async () => {
  const f = await setup();
  try {
    const adapter = f.load('functions/services/adminSessionWriterAdapters.js').createSessionWriterAdapters({ db: f.connection.db, database: f.connection.targetDatabase }).rtdb;
    const current = await adapter.read(`session/${f.hash}`), op = { id: id(), digest: 'b'.repeat(64),
      changes: [{ ...current, value: { ...current.value, lastActivity: f.time } }], result: true,
      details: { kind: 'session', action: 'touch', uid: f.owner, at: f.time } };
    f.afterRead(async () => {
      const raw = (await f.ref(`adminSessions/${encodeKey(f.hash)}`).get()).val();
      await f.ref(`adminSessions/${encodeKey(f.hash)}`).set({ ...raw, revision: raw.revision + 1, generation: raw.generation + 1,
        tombstone: !replacement, payload: replacement ? encodeValue({ ...f.original, uid: 'synthetic-replacement' }) : null });
    });
    let confirmed;
    await adapter.withSession(() => adapter.commit(op, receipt => { confirmed = receipt; }));
    assert.equal(confirmed.outcome, 'cancelled'); const latest = await adapter.read(current.key);
    assert.equal(latest.exists, replacement);
    if (replacement) { assert.equal(latest.value.uid, 'synthetic-replacement'); assert.equal(latest.value.lastActivity, f.original.lastActivity); }
    assert.equal(f.listeners.size, 0);
  } finally { await f.close(); }
});

for (const mode of ['equal', 'different', 'tombstone', 'corrupt']) test(`기존 보관 영수증 ${mode}: 일치 원문만 재사용하고 덮어쓰지 않는다`, async () => {
  const f = await setup();
  try {
    const raw = (await f.ref(`adminSessions/${encodeKey(f.hash)}`).get()).val();
    const header = raw.commitReceipt, key = `${f.hash}:${header.id}`;
    const archive = createRecordStore({ database: { ref: f.ref }, path: 'adminSessionWriterReceipts' });
    await archive.createIfAbsent(key, mode === 'different' ? { ...header, digest: 'c'.repeat(64) } : header);
    const target = f.ref(`adminSessionWriterReceipts/${encodeKey(key)}`);
    if (mode === 'tombstone') await archive.delete(key, 1);
    if (mode === 'corrupt') await target.set({ format: 1, revision: 'invalid' });
    const before = (await target.get()).val(), response = await f.request();
    assert.equal(response.res.statusCode, mode === 'equal' ? 204 : 503);
    assert.equal(f.counts().bodyTransactions, mode === 'equal' ? 1 : 0);
    assert.deepEqual((await target.get()).val(), before);
    assert.equal(f.listeners.size, 0);
  } finally { await f.close(); }
});

test('두 독립 writer가 같은 직전 영수증을 동시에 보관해도 한 원문을 유지하고 활동은 한 번만 반영한다', async () => {
  const f = await setup();
  try {
    const create = f.load('functions/services/adminSessionWriterAdapters.js').createSessionWriterAdapters;
    const a = create({ db: f.connection.db, database: { ref: f.ref } }).rtdb;
    const b = create({ db: f.connection.db, database: { ref: f.ref } }).rtdb;
    const key = `session/${f.hash}`, current = await a.read(key);
    const raw = (await f.ref(`adminSessions/${encodeKey(f.hash)}`).get()).val(), previous = raw.commitReceipt;
    const op = n => ({ id: id(), digest: String(n).repeat(64), changes: [{ ...current, value: { ...current.value, lastActivity: f.time + n } }],
      result: true, details: { kind: 'session', action: 'touch', uid: f.owner, at: f.time + n } });
    const ops = [op(1), op(2)], receipts = [];
    await Promise.all([a.commit(ops[0], receipt => receipts.push(receipt)), b.commit(ops[1], receipt => receipts.push(receipt))]);
    assert.equal(receipts.filter(r => r.outcome !== 'cancelled').length, 1);
    assert.equal(receipts.filter(r => r.outcome === 'cancelled').length, 1);
    const archived = await createRecordStore({ database: { ref: f.ref }, path: 'adminSessionWriterReceipts' }).read(`${f.hash}:${previous.id}`);
    assert.deepEqual(archived.value, previous); assert.equal(archived.revision, 1);
    const saved = await a.read(key); assert([f.time + 1, f.time + 2].includes(saved.value.lastActivity));
    assert.equal(f.listeners.size, 0);
  } finally { await f.close(); }
});
