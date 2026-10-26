'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { encodeKey } = require('../services/user-storage/codec');
const { fingerprint } = require('../services/userMigrationRehearsal');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
async function fixture(hook = {}) {
  const runId = id(), c = open(runId), options = { db: c.db, database: c.targetDatabase, bucket: c.bucket, FieldValue, runId,
    config: c.config, migration, historyMaintenance: 'deferred', ...hook };
  const b = createUserInventoryWriterBinding(options); await b.initialize();
  let writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
  const uid = id(), key = `verification/youtube/${uid}`, parent = c.targetDatabase.ref(`users/${encodeKey(uid)}`), ids = [];
  const commit = b.membershipAdapters.rtdb.commit;
  b.membershipAdapters.rtdb.commit = async (op, ...rest) => { ids.push(op.id); return commit(op, ...rest); };
  const authenticate = async () => {
    const now = Date.now(), nonceHash = createHash('sha256').update(id()).digest('hex');
    await b.membership.start(uid, 'youtube', { nonceHash, startedAt: now, expiresAt: now + 300000, consumed: false, localOnly: false });
    await b.membership.withVerification(uid, 'youtube', async () => {
      await b.membership.consume(uid, 'youtube', nonceHash);
      await b.membership.complete(uid, 'youtube', nonceHash, { status: 'none', type: 'csv', levelName: '일반',
        userChannelId: 'UC'+'a'.repeat(22), verificationVersion: 2, verificationProvider: 'youtube', lastChecked: Date.now() });
    });
  };
  const operations = async () => {
    if (b.transition.lookupOperation) return Promise.all([...new Set(ids)].map(value => b.transition.lookupOperation(value)));
    const journal = require('../services/user-storage/writerJournalStore').createWriterJournalStore({ database: c.targetDatabase, path: 'profileWriterTransitions' });
    const state = (await journal.read(runId)).value;
    return [...new Set(ids)].map(value => state.operations[value]);
  };
  const connections = [];
  const fresh = () => { const next = open(runId); connections.push(next); return createUserInventoryWriterBinding({ ...options, db: next.db, database: next.targetDatabase, bucket: next.bucket }); };
  return { c, b, options, uid, key, parent, ids, authenticate, operations, fresh, close: async () => { for (const connection of connections) await connection.close(); await c.close(); } };
}
test('완료 이력을 보관한 뒤만 본문을 분리하며 새 SDK·늦은 commit·fence·기존 결과를 보존한다', async () => {
  const f = await fixture();
  try {
    await f.authenticate(); const ops = await f.operations(), before = (await f.parent.get()).val();
    await f.b.transition.compact({ limit: 128 }); const after = (await f.parent.get()).val();
    assert.deepEqual(after.profile, before.profile); assert.deepEqual(after.verification, before.verification);
    assert(Buffer.byteLength(JSON.stringify(after)) < Buffer.byteLength(JSON.stringify(before)) * .6);
    const fresh = f.fresh(), adapter = fresh.membershipAdapters.rtdb;
    for (const op of ops) {
      assert.equal(after.membershipWriterReceipts[op.id].v, 1);
      assert.equal(Object.keys(after.membershipWriterReceipts[op.id]).sort().join(','), 'd,h,v');
      assert.deepEqual(await adapter.receipt(op), op.receipt);
      assert.deepEqual(await fresh.transition.recover(op.id), op.result);
      await adapter.commit(op); assert.deepEqual(await adapter.fence(op), op.receipt);
    }
    assert.deepEqual((await f.parent.get()).val(), after, '이미 실행된 작업을 다시 적용하지 않는다');
    assert.equal((await fresh.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('본문 보관 누락/변조는 확정 결과로 추정하지 않고 늦은 commit도 재적용하지 않는다', async () => {
  const f = await fixture();
  try {
    await f.authenticate(); const ops = await f.operations(); await f.b.transition.compact({ limit: 128 });
    const op = ops.at(-1), ref = f.c.targetDatabase.ref(`membershipWriterReceiptArchive/${encodeKey(f.uid)}/${op.id}`), original = (await ref.get()).val();
    const before = (await f.parent.get()).val(); await ref.set({ ...original, receipt: { ...original.receipt, digest: '0'.repeat(64) } });
    await assert.rejects(f.b.membershipAdapters.rtdb.receipt(op), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
    await assert.rejects(f.b.membershipAdapters.rtdb.commit(op), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
    assert.deepEqual((await f.parent.get()).val(), before);
    await ref.remove(); await assert.rejects(f.b.membershipAdapters.rtdb.receipt(op), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
    await ref.set(original); assert.deepEqual(await f.b.membershipAdapters.rtdb.receipt(op), op.receipt);
  } finally { await f.close(); }
});
test('미확정·취소·투영은 분리하지 않으며 이미 보관된 기록의 재개는 멱등이다', async () => {
  const f = await fixture();
  try {
    await f.authenticate(); const op = (await f.operations()).at(-1), before = (await f.parent.get()).val();
    // Native ACK는 있지만 journal 포착이 없는 상황은 별도 미확정 상태로 남긴다.
    assert.equal((await f.b.membershipAdapters.rtdb.archiveConfirmedReceipts([{ ...op, status: 'executing' }])).eligible, 0);
    assert.equal((await f.b.membershipAdapters.rtdb.archiveConfirmedReceipts([{ ...op, status: 'cancelled' }])).eligible, 0);
    await assert.rejects(f.b.membershipAdapters.rtdb.archiveConfirmedReceipts([op]), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' }, 'hot 완료만 있고 불변 보관 승인이 없으면 거부한다');
    assert.deepEqual((await f.parent.get()).val(), before);
    await f.b.transition.compact({ limit: 128 });
    // 기존 이력에서 다시 페이지를 읽는 작업은 멱등이며 원문을 덮어쓰지 않는다.
    const summary = await f.b.archiveMembershipReceipts({ limit: 128, apply: true });
    assert.equal(summary.moved, 0); assert.equal(summary.alreadyArchived, 3);
    assert.equal((await f.b.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
for (const boundary of ['archive', 'parent']) test(`${boundary} ACK 유실은 자동 재제출하지 않고 새 SDK에서 원문·참조를 대조한다`, async () => {
  const f = await fixture();
  try {
    await f.authenticate(); const ops = await f.operations(), before = (await f.parent.get()).val();
    delete f.b.stores.rtdb.archiveConfirmedReceipts;
    await f.b.transition.compact({ limit: 128 });
    let injected = 0;
    const database = { ref(path) {
      const ref = f.c.targetDatabase.ref(path), targeted = boundary === 'archive'
        ? path.startsWith('membershipWriterReceiptArchive/') : path === `users/${encodeKey(f.uid)}`;
      if (!targeted) return ref;
      return new Proxy(ref, { get(object, property) {
        if (property === 'transaction') return async (...args) => {
          const result = await object.transaction(...args);
          if (result.committed && injected++ === 0) return new Promise(() => {});
          return result;
        };
        const value = object[property]; return typeof value === 'function' ? value.bind(object) : value;
      } });
    } };
    const ambiguous = createUserInventoryWriterBinding({ ...f.options, database, timeoutMs: 250 });
    await assert.rejects(ambiguous.archiveMembershipReceipts({ limit: 128, apply: true }), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
    if (boundary === 'archive') assert.deepEqual((await f.parent.get()).val(), before);
    const fresh = f.fresh();
    await fresh.archiveMembershipReceipts({ limit: 128, apply: true });
    for (const op of ops) assert.deepEqual(await fresh.membershipAdapters.rtdb.receipt(op), op.receipt);
    assert.deepEqual((await f.parent.get()).val().profile, before.profile);
  } finally { await f.close(); }
});
test('진행점은 제한 페이지로 재개하고 완료한 날에는 원문을 다시 순회하지 않는다', async () => {
  const f = await fixture();
  try {
    await f.authenticate(); delete f.b.stores.rtdb.archiveConfirmedReceipts;
    await f.b.transition.compact({ limit: 128 });
    const preview = await f.b.archiveMembershipReceipts({ limit: 128 });
    assert.equal(preview.moved, 0); assert(preview.beforeBytes > preview.afterBytes);
    const first = await f.b.maintainMembershipReceipts({ limit: 1 }); assert.equal(first.complete, false);
    const fresh = f.fresh();
    let scanned = first.scanned, moved = first.moved;
    for (let n = 0; n < 4; n++) {
      const result = await fresh.maintainMembershipReceipts({ limit: 1 }); scanned += result.scanned; moved += result.moved;
      if (result.complete) break;
    }
    assert.equal(scanned, 3); assert.equal(moved, 3);
    assert.deepEqual(await fresh.maintainMembershipReceipts(), { scanned: 0, moved: 0, complete: true });
  } finally { await f.close(); }
});
test('동시 보관과 신규 프로필 저장은 CAS로 병합되고 기존 양방향 전환을 유지한다', async () => {
  const f = await fixture();
  try {
    await f.authenticate(); const before = (await f.parent.get()).val();
    await Promise.all([f.b.transition.compact({ limit: 128 }), f.fresh().repository.updateNickname(f.uid, '보존')]);
    assert.equal((await f.b.repository.read(f.uid)).value.Nickname, '보존');
    const markers = (await f.parent.get()).val().membershipWriterReceipts;
    assert.equal(Object.keys(markers).length, Object.keys(before.membershipWriterReceipts).length);
    let writer = await f.b.transition.route(); await f.b.transition.copy(writer); await f.b.transition.drain(writer); await f.b.transition.activate(writer);
    assert.equal((await f.b.repository.read(f.uid)).value.Nickname, '보존');
    writer = await f.b.transition.route(); await f.b.transition.copy(writer); await f.b.transition.drain(writer); await f.b.transition.activate(writer);
    assert.equal((await f.b.repository.read(f.uid)).value.Nickname, '보존');
    assert.equal((await f.b.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('누적 완료 영수증256개를 제한 배치로 분리해 부모 크기와 SDK 처리 비용을 비교한다', async () => {
  const { createWriterHistoryStore } = require('../services/user-storage/writerHistoryStore');
  const { performance } = require('node:perf_hooks');
  const f = await fixture();
  try {
    await f.authenticate(); const original = (await f.operations()).at(-1), raw = (await f.parent.get()).val(), template = raw.membershipWriterReceipts[original.id];
    const history = createWriterHistoryStore({ database: f.c.targetDatabase, runId: f.options.runId });
    const operations = Array.from({ length: 256 }, () => {
      const next = id(); return { ...original, id: next, receipt: { ...original.receipt, id: next } };
    });
    const bodies = Object.fromEntries(operations.map(op => [op.id, { ...template, id: op.id }]));
    await f.parent.child('membershipWriterReceipts').update(bodies);
    await history.withSession(async () => {
      for (let n = 0; n < operations.length; n += 8) await Promise.all(operations.slice(n, n+8).map(op => history.put('operations', op.id, op)));
    });
    async function probe() {
      const snapshot = (await f.parent.get()).val(); let listener;
      await new Promise((resolve, reject) => { listener = () => resolve(); f.parent.on('value', listener, reject); });
      const cpu = process.cpuUsage(), started = performance.now();
      try {
        await f.parent.transaction(value => value, undefined, false);
        const usage = process.cpuUsage(cpu);
        return { parentBytes: Buffer.byteLength(JSON.stringify(snapshot)), transactionMs: performance.now()-started,
          processCpuMs: (usage.user+usage.system)/1000 };
      } finally { f.parent.off('value', listener); }
    }
    const before = await probe();
    for (let n = 0; n < operations.length; n += 128) await f.b.membershipAdapters.rtdb.archiveConfirmedReceipts(operations.slice(n, n+128));
    const after = await probe(); assert(after.parentBytes < before.parentBytes*.15);
    assert.deepEqual((await f.parent.get()).val().profile, raw.profile);
    const next = f.fresh();
    assert.deepEqual(await next.membershipAdapters.rtdb.receipt(operations[0]), operations[0].receipt);
    console.log(JSON.stringify({ event: 'synthetic_membership_receipt_archive_scale', receipts: operations.length, before, after,
      emulatorOnly: true, processWideCpu: true }));
  } finally { await f.close(); }
});
