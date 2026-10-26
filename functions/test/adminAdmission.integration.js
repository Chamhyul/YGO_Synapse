'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const id = () => randomBytes(16).toString('hex');
async function setup({ accountDelay = 0 } = {}) {
  const f = await fixture(); await f.binding.transition.initialize();
  const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
  await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
  const at = Date.now(), hash = createHash('sha256').update('synthetic-session').digest('hex');
  const value = { uid: f.owner, lastActivity: at - 1000, expiresAt: at + 3600000 };
  await f.binding.adminSessions.set(hash, value);
  let fault, transactions = 0, commits = 0, tracking = false, firstState, beforeAdmission;
  const database = f.connection.targetDatabase, ref = database.ref.bind(database), adapter = f.binding.stores.rtdb, commit = adapter.commit;
  adapter.commit = async (op, ...rest) => { if (op.details?.action === 'touch') commits++; return commit(op, ...rest); };
  database.ref = path => {
    const target = ref(path);
    return new Proxy(target, { get(target, key) {
      if (key === 'transaction' && /^profileWriterTransitions\/[^/]+$/.test(path)) return async (...args) => {
        const n = tracking ? ++transactions : 0;
        if (n === 1 && fault === 'before') throw Error('synthetic-admission-before');
        const result = await target.transaction(...args);
        if (n === 1) {
          firstState = await createWriterJournalStore({ database: { ref } }).read(f.config.runId);
          if (fault === 'after') throw Object.assign(Error('synthetic-admission-ack-loss'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
        }
        return result;
      };
      const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v;
    } });
  };
  const admit = f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt;
  f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt = async (...args) => {
    if (beforeAdmission) { const hook = beforeAdmission; beforeAdmission = null; await hook(); }
    return admit(...args);
  };
  f.mock('functions/services/adminRequestTiming.js', require('../services/adminRequestTiming'));
  f.mock('functions/services/inventoryRequestTiming.js', require('../services/inventoryRequestTiming'));
  if (accountDelay) { const get = f.binding.auth.getUser.bind(f.binding.auth); f.binding.auth.getUser = async (...args) => { await new Promise(r => setTimeout(r, accountDelay)); return get(...args); }; }
  const handler = f.load('functions/services/adminSessionRepository.js').createConfiguredAdminPageHandler({ auth: f.binding.auth, now: () => at }, { env: f.env, writerBinding: f.binding });
  return { ...f, hash, value, at, adapter,
    fault: v => { fault = v; }, beforeAdmission: action => { beforeAdmission = action; },
    state: async () => (await createWriterJournalStore({ database: { ref } }).read(f.config.runId)).value,
    stats: () => ({ transactions, commits, firstState: firstState?.value }),
    async request({ timing } = {}) {
      transactions = 0; commits = 0; tracking = true;
      try { const target = timing ? require('../services/adminRequestTiming').withAdminRequestTiming('adminPages', handler, { emit: timing }) : handler; return await call(target, { url: '/admin/session/activity', body: { uid: f.owner }, token: 'owner',
        headers: { cookie: '__session=synthetic-session', host: 'ygo-synapse.web.app', origin: 'https://ygo-synapse.web.app', 'content-type': 'application/json' } }); }
      finally { tracking = false; }
    },
  };
}
test('활동 admission 첫 ACK는 실행 명령·상위 잠금을 함께 확정하고 성공은 전역 CAS2회다', async () => {
  const f = await setup();
  try {
    assert.equal((await f.request()).statusCode, 204);
    const { transactions, commits, firstState } = f.stats(), op = Object.values(firstState.operations).find(o => o.details?.action === 'touch');
    assert.equal(transactions, 2); assert.equal(commits, 1); assert.equal(op.status, 'executing');
    assert.equal(firstState.external[op.parentExternal].status, 'running');
    const end = await f.state(); assert.equal(end.operations[op.id].status, 'completed'); assert.equal(end.external[op.parentExternal].status, 'completed');
  } finally { await f.close(); }
});
for (const fault of ['before', 'after']) test(`admission ${fault} 실패는 native RPC를 제출하지 않고 미확정은 기존 fence 복구한다`, async () => {
  const f = await setup();
  try {
    f.fault(fault); assert.equal((await f.request()).statusCode, 503); f.fault(null); assert.equal(f.stats().commits, 0);
    const state = await f.state(), op = Object.values(state.operations).find(o => o.details?.action === 'touch');
    if (fault === 'before') { assert.equal(op, undefined); assert.equal(Object.values(state.external || {}).filter(v => v.status === 'running').length, 0); }
    else {
      assert.equal(op.status, 'executing'); assert.equal(state.external[op.parentExternal].status, 'running');
      const writer = await f.binding.transition.route(); await f.binding.transition.drain(writer);
      const options = { operation: op.id, parentRequest: op.parentExternal, recoveryRequest: id() };
      const preview = await f.binding.transition.previewSessionRecovery(writer, options); assert.equal(preview.action, 'fence');
      await f.binding.transition.recoverSession(writer, { ...options, expectedPreview: preview.previewDigest, writersDrained: true });
      assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    }
    assert.equal((await f.binding.adminSessions.get(f.hash)).lastActivity, f.value.lastActivity);
  } finally { await f.close(); }
});
for (const replacement of [false, true]) test(`자격 조회 뒤 admission 전 ${replacement ? '재발급' : '삭제'}된 세션은 갱신·부활하지 않는다`, async () => {
  const f = await setup();
  try {
    f.beforeAdmission(async () => {
      await f.binding.adminSessions.withRequest({}, async () => {
        await f.binding.adminSessions.remove(f.hash);
        if (replacement) await f.binding.adminSessions.set(f.hash, { ...f.value, uid: 'synthetic-new-owner' });
      });
    });
    const response = await f.request(); assert.notEqual(response.statusCode, 204);
    const saved = await f.binding.adminSessions.get(f.hash);
    if (replacement) { assert.equal(saved.uid, 'synthetic-new-owner'); assert.equal(saved.lastActivity, f.value.lastActivity); }
    else assert.equal(saved, undefined);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
for (const mode of ['draining', 'epoch']) test(`새 admission은 ${mode} 변경 뒤 두 등록 모두 거부한다`, async () => {
  const f = await setup();
  try {
    const writer = await f.binding.transition.route(), entry = await f.adapter.read('session/' + f.hash), parent = id(), operation = id();
    await f.binding.transition.drain(writer);
    if (mode === 'epoch') await f.binding.transition.resume(writer, { id: id(), writersDrained: true });
    await assert.rejects(f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt(writer, operation,
      [{ ...entry, value: { ...entry.value, lastActivity: f.at } }], true, { resources: [entry.key], parentExternal: parent,
        details: { kind: 'session', action: 'touch', uid: f.owner, at: f.at }, onParentCompleted() {} }),
      e => ['WRITER_DRAINING', 'WRITER_FENCED'].includes(e.code));
    const state = await f.state(); assert.equal(state.external?.[parent], undefined); assert.equal(state.operations[operation], undefined); assert.equal(f.stats().commits, 0);
  } finally { await f.close(); }
});

test('두 등록의 용량을 한 번에 예약하지 못하면 잠금·명령·native 쓰기 모두 남기지 않는다', async () => {
  const f = await setup();
  try {
    const runId = id(), journal = createWriterJournalStore({ database: f.connection.targetDatabase });
    const transition = require('../services/userWriterTransition').createUserWriterTransition({ journal, runId,
      stores: f.binding.stores, checkKey() {}, maxOperations: 1 });
    await transition.initialize(); const writer = await transition.route(), parent = id(), operation = id();
    const entry = await f.adapter.read('session/' + f.hash);
    await assert.rejects(transition.prepareAndExecuteActivityAdmissionWithReceipt(writer, operation,
      [{ ...entry, value: { ...entry.value, lastActivity: f.at } }], true, { resources: [entry.key], parentExternal: parent,
        details: { kind: 'session', action: 'touch', uid: f.owner, at: f.at }, onParentCompleted() {} }),
      { code: 'WRITER_JOURNAL_FULL' });
    const state = (await journal.read(runId)).value;
    assert.equal(state.external?.[parent], undefined); assert.equal(state.operations[operation], undefined); assert.equal(f.stats().commits, 0);
  } finally { await f.close(); }
});

test('등록 준비의 journal·두 ID 보관 읽기는 현재 Auth와 겹치고 권한 판정 전에는 CAS를 제출하지 않는다', async () => {
  const f = await setup({ accountDelay: 180 }); let timing;
  try {
    assert.equal((await f.request({ timing: value => { timing = typeof value === 'string' ? JSON.parse(value) : value; } })).statusCode, 204);
    const account = timing.spans.find(s => s.name === 'admin.auth.account');
    const prepared = timing.spans.filter(s => ['journal.read', 'journal.history_lookup'].includes(s.name));
    assert(prepared.length >= 3); assert(prepared.slice(0, 3).every(s => s.startMs < account.startMs + account.durationMs));
    assert(timing.spans.filter(s => s.name === 'journal.cas').every(s => s.startMs >= account.startMs + account.durationMs));
    assert.equal(f.stats().transactions, 2); assert.equal(f.stats().commits, 1);
  } finally { await f.close(); }
});
