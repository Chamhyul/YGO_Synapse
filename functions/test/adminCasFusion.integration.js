'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const id = () => randomBytes(16).toString('hex');
async function setup({ fuse = true, admission = true } = {}) {
  const f = await fixture(); await f.binding.transition.initialize();
  const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
  await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
  const time = Date.now(), hash = createHash('sha256').update('synthetic-session').digest('hex');
  const original = { uid: f.owner, lastActivity: time - 1000, expiresAt: time + 3600000 };
  await f.binding.adminSessions.set(hash, original);
  if (!admission) f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt = undefined;
  if (!fuse) { f.binding.transition.prepareAndExecuteActivityWithReceipt = undefined; f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt = undefined; }
  const handler = f.load('functions/services/adminSessionRepository.js').createConfiguredAdminPageHandler({
    auth: f.binding.auth, now: () => time,
    template: async () => '<html><body><div id="admin-content">합성 본문</div></body></html>',
  }, { env: f.env, writerBinding: f.binding });
  const counts = { journal: 0 }, database = f.connection.targetDatabase, ref = database.ref.bind(database);
  let tracking = false, captureFault = false;
  database.ref = path => {
    const value = ref(path);
    return new Proxy(value, { get(target, key) {
      if (key === 'transaction' && /^profileWriterTransitions\/[^/]+$/.test(path)) return async (...args) => {
        const n = tracking ? ++counts.journal : 0, result = await target.transaction(...args);
        if (captureFault && n === 2) throw Object.assign(Error('synthetic-capture-ack-loss'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
        return result;
      };
      const item = Reflect.get(target, key, target); return typeof item === 'function' ? item.bind(target) : item;
    } });
  };
  return { ...f, hash, original, time, counts,
    request: (url, { method = 'POST', body = { uid: f.owner } } = {}) => call(handler, { url, method, body, token: 'owner',
      headers: { cookie: '__session=synthetic-session', host: 'ygo-synapse.web.app', origin: 'https://ygo-synapse.web.app', 'content-type': 'application/json' } }),
    track(value = true) { tracking = value; counts.journal = 0; },
    loseCaptureAck() { captureFault = true; },
    journal: async () => (await createWriterJournalStore({ database }).read(f.config.runId)).value,
  };
}

for (const [fuse, admission, expected] of [[false, false, 4], [true, false, 3], [true, true, 2]]) test(`실제 관리자 연결의 활동 합성: journal CAS${expected}`, async () => {
  const f = await setup({ fuse, admission });
  try {
    f.track(); const res = await f.request('/admin/session/activity'); const transactions = f.counts.journal; f.track(false);
    assert.equal(res.statusCode, 204); assert.equal(transactions, expected);
    const state = await f.journal(), touches = Object.values(state.operations).filter(o => o.details?.action === 'touch');
    assert.equal(touches.length, 1); assert.equal(touches[0].status, 'completed');
    assert.equal(state.external[touches[0].parentExternal].status, 'completed');
    const saved = await f.binding.adminSessions.get(f.hash); assert.equal(saved.lastActivity, f.time); assert.equal(saved.expiresAt, f.original.expiresAt);
    console.log(JSON.stringify({ event: 'synthetic_activity_cas_fusion', fused: fuse, journalTransactions: transactions, production: false }));
  } finally { await f.close(); }
});

test('실제 configured handler의 회원 목록·미리보기는 journal 쓰기 없이 현재 권한을 검사한다', async () => {
  const f = await setup();
  try {
    f.track(); const summary = await f.request('/admin/api/membership-csv', { method: 'GET' });
    assert.equal(summary.statusCode, 200); assert.equal(f.counts.journal, 0);
    const csvText = '회원,프로필에 연결,현재 등급\n합성,https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv,합성등급';
    const preview = await f.request('/admin/api/membership-csv/preview', { body: { csvText } });
    assert.equal(preview.statusCode, 200); assert.equal(f.counts.journal, 0);
    await f.binding.auth.setCustomUserClaims(f.owner, { role: 'none' });
    assert.equal((await f.request('/admin/api/membership-csv', { method: 'GET' })).statusCode, 401);
    assert.equal(f.counts.journal, 0);
  } finally { await f.close(); }
});

for (const afterCommit of [false, true]) test(`활동 native ${afterCommit ? '승인 뒤' : '제출 전'} 실패는 성공하지 않고 명시 복구한다`, async () => {
  const f = await setup(), adapter = f.binding.stores.rtdb, commit = adapter.commit;
  try {
    adapter.commit = async (op, ...args) => {
      if (op.details?.action === 'touch') { if (afterCommit) await commit(op, ...args); throw Error('synthetic-native-failure'); }
      return commit(op, ...args);
    };
    assert.equal((await f.request('/admin/session/activity')).statusCode, 503); adapter.commit = commit;
    const state = await f.journal(), op = Object.values(state.operations).find(o => o.details?.action === 'touch');
    assert.equal(op.status, 'executing'); assert.equal(state.external[op.parentExternal].status, 'running');
    const writer = await f.binding.transition.route(); await f.binding.transition.drain(writer);
    const options = { operation: op.id, parentRequest: op.parentExternal, recoveryRequest: id() };
    const preview = await f.binding.transition.previewSessionRecovery(writer, options);
    assert.equal(preview.action, afterCommit ? 'recover' : 'fence');
    const done = await f.binding.transition.recoverSession(writer, { ...options, expectedPreview: preview.previewDigest, writersDrained: true });
    assert.equal(done.recoveryState, 'completed'); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    if (!afterCommit) await commit(op);
    assert.equal((await f.binding.adminSessions.get(f.hash)).lastActivity, afterCommit ? f.time : f.original.lastActivity);
  } finally { adapter.commit = commit; await f.close(); }
});

test('합성 완료·종료 ACK 유실은503이며 fresh 영수증 대조 후 재저장 없이 완료를 확인한다', async () => {
  const f = await setup();
  try {
    f.track(); f.loseCaptureAck(); assert.equal((await f.request('/admin/session/activity')).statusCode, 503); f.track(false);
    const state = await f.journal(), op = Object.values(state.operations).find(o => o.details?.action === 'touch');
    assert.equal(op.status, 'completed'); assert.equal(state.external[op.parentExternal].status, 'completed');
    const writer = await f.binding.transition.route(); await f.binding.transition.drain(writer);
    const options = { operation: op.id, parentRequest: op.parentExternal, recoveryRequest: id() };
    const preview = await f.binding.transition.previewSessionRecovery(writer, options); assert.equal(preview.action, 'already-settled');
    f.track(); const done = await f.binding.transition.recoverSession(writer, { ...options, expectedPreview: preview.previewDigest, writersDrained: true });
    assert.equal(done.recoveryState, 'completed'); assert.equal(f.counts.journal, 0); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.binding.adminSessions.get(f.hash)).lastActivity, f.time);
  } finally { await f.close(); }
});
