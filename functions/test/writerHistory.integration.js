'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createWriterHistoryStore } = require('../services/user-storage/writerHistoryStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createTransitionWriter, createUserWriterTransition } = require('../services/userWriterTransition');
const { createWriterPlanStore } = require('../services/user-storage/writerPlanStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const { fingerprint } = require('../services/userMigrationRehearsal');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
async function setup(options = {}, runId = id()) {
  const connection = open(runId), binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config, migration, ...options });
  await binding.initialize(); return { ...binding, runId, connection,
    history: createWriterHistoryStore({ database: connection.targetDatabase, runId }),
    journal: createWriterJournalStore({ database: connection.targetDatabase, path: 'profileWriterTransitions' }), close: () => connection.close() };
}
async function flip(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
async function write(f, operationId, value, result = null) {
  const writer = await f.transition.route(), key = 'fs/users/synthetic', before = await f.stores[writer.backend].read(key);
  const changes = [{ key, exists: true, token: before.token, value }];
  const options = { details: { kind: 'profile', serverTimestampPaths: [] } };
  await createTransitionWriter(f.transition, writer).write(operationId, changes, result, options);
  return { writer, changes, result, options };
}
test('native 기본 binding은128건 초과 프로필/외부 요청을 보관하고 양방향 전환·이전 ID 결과를 유지한다', async () => {
  const f = await setup(); try {
    const operationId = id(), response = { success: true, retained: null }, request = await write(f, operationId, { settings: { theme: 'dark' }, custom: [] }, response);
    for (let n = 0; n < 140; n++) await f.repository.updateSettings('synthetic', { theme: n % 2 ? 'light' : 'dark' });
    for (let n = 0; n < 140; n++) await f.adminRequests.withRequest({}, async () => {});
    while ((await f.transition.compact({ limit: 128 })).moved) {}
    const status = await f.transition.historyStatus(); assert.equal(status.archived.operations, 141); assert.equal(status.archived.external, 140);
    assert.equal(status.retainedOperations, 0); assert.equal(status.retainedExternal, 0); assert.equal(status.retainedEvents, 0);
    assert.ok(status.hotBytes < 5000);
    assert.deepEqual(await createTransitionWriter(f.transition, request.writer).write(operationId, request.changes, response, request.options), response);
    await assert.rejects(createTransitionWriter(f.transition, request.writer).write(operationId, [{ ...request.changes[0], value: {} }], response, request.options), { code: 'WRITER_OPERATION_CONFLICT' });
    await flip(f); assert.deepEqual((await f.repository.read('synthetic')).value.custom, []);
    await f.repository.updateSettings('synthetic', { theme: 'dark' }); await flip(f);
    assert.equal((await f.repository.read('synthetic')).value.settings.theme, 'dark'); assert.deepEqual(await f.transition.recover(operationId), response);
    const current = await f.history.get('operations', operationId); assert.equal(current.capturedSequence, 1);
    const ids = new Set(); let cursor, pages = 0;
    do { const page = await f.history.summaryPage('operations', { cursor, limit: 7 }); assert.ok(page.items.length <= 7); assert.equal(page.coverage, 'indexed');
      page.items.forEach(item => { assert.equal(ids.has(item.id), false); ids.add(item.id); }); cursor = page.cursor || undefined; pages++;
    } while (cursor);
    assert.equal(ids.size, (await f.transition.historyStatus()).archived.operations); assert.ok(pages > 10);
  } finally { await f.close(); }
});
function archived(operation, text = 'synthetic'.repeat(1500), sequence = 1) {
  const entry = { key: 'fs/users/synthetic', exists: true, token: 'before', value: { text } };
  return { id: operation, digest: fingerprint(entry), backend: 'legacy', epoch: 1, status: 'completed',
    capturedSequence: sequence, resources: [entry.key], changes: [entry], result: null,
    receipt: { id: operation, digest: fingerprint(entry), changes: [{ ...entry, token: 'after' }], result: null } };
}
test('format2 이력은 같은 본문을 한 번 저장하고 요약 목록은 상세/본문 경로를 읽지 않는다', async () => {
  const f = await setup(), reads = [], operations = Array.from({ length: 9 }, (_, n) => archived(id(), undefined, n + 1));
  try {
    for (const op of operations) await f.history.put('operations', op.id, op);
    const root = `profileWriterHistory/${encodeKey(f.runId)}`, pool = (await f.connection.targetDatabase.ref(`${root}/bodies`).get()).val();
    assert.equal(Object.keys(pool).length, 1);
    const saved = await createRecordStore({ database: f.connection.targetDatabase, path: `${root}/operations` }).read(operations[0].id);
    assert.equal(saved.value.format, 2); assert.equal(saved.value.refs.length, 2);
    assert.equal(saved.value.value.changes[0].value, null); assert.equal(saved.value.value.receipt.changes[0].value, null);
    assert.deepEqual(await f.history.get('operations', operations[0].id), operations[0]);
    const detailed = await f.history.page('operations', { limit: 2 });
    assert.equal(detailed.items.length, 2); assert.ok(detailed.items.every(item => !('stats' in item)));
    const history = createWriterHistoryStore({ database: { ref: path => { reads.push(path); return f.connection.targetDatabase.ref(path); } }, runId: f.runId });
    const seen = new Set(); let cursor;
    do {
      const page = await history.summaryPage('operations', { cursor, limit: 2 }); assert.equal(page.coverage, 'indexed');
      for (const item of page.items) { assert.equal(seen.has(item.id), false); seen.add(item.id);
        assert.equal(item.value.status, 'completed'); assert.equal(item.value.digest, fingerprint(operations.find(op => op.id === item.id)));
        assert.equal('changes' in item.value, false); assert.equal('receipt' in item.value, false); assert.equal('result' in item.value, false); }
      cursor = page.cursor || undefined;
    } while (cursor);
    assert.equal(seen.size, operations.length); assert.ok(reads.length > 0);
    assert.ok(reads.every(path => path === `${root}/summaries/operations`));
    await assert.rejects(history.summaryPage('operations', { limit: 129 }), { code: 'WRITER_HISTORY_CONFLICT' });
    await assert.rejects(history.summaryPage('external', { cursor: 'invalid' }), { code: 'WRITER_HISTORY_CONFLICT' });
  } finally { await f.close(); }
});
test('기존 format1 원문/전체 목록은 유지하고 명시적 제한 배치 색인만 요약 목록에 추가한다', async () => {
  const f = await setup(), operations = [archived(id()), archived(id(), 'different'.repeat(1000))];
  try {
    const path = `profileWriterHistory/${encodeKey(f.runId)}/operations`, store = createRecordStore({ database: f.connection.targetDatabase, path });
    for (const op of operations) await store.compareAndSet(op.id, 0, { format: 1, kind: 'operations', value: op, digest: fingerprint(op) });
    const before = (await f.connection.targetDatabase.ref(path).get()).val();
    assert.deepEqual(await f.history.get('operations', operations[0].id), operations[0]);
    assert.equal((await f.history.page('operations')).items.length, 2);
    assert.equal((await f.history.summaryPage('operations')).items.length, 0);
    let cursor, total = 0;
    do { const batch = await f.history.indexPage('operations', { cursor, limit: 1 }); total += batch.indexed; cursor = batch.cursor || undefined; } while (cursor);
    assert.equal(total, 2); assert.equal((await f.history.summaryPage('operations')).items.length, 2);
    await f.history.indexPage('operations', { limit: 1 });
    assert.deepEqual((await f.connection.targetDatabase.ref(path).get()).val(), before);
    assert.equal((await f.connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(f.runId)}/bodies`).get()).exists(), false);
    await f.history.put('operations', operations[0].id, operations[0]);
    assert.deepEqual((await f.connection.targetDatabase.ref(path).get()).val(), before);
  } finally { await f.close(); }
});
test('본문 누락/손상은 복구·재생을 차단하고 hot 참조와 native 결과를 보존한다', async () => {
  const f = await setup(), operation = id();
  try {
    const writer = await f.transition.route(); await f.transition.copy(writer);
    await write(f, operation, { text: 'preserved'.repeat(2000) }); await f.transition.compact();
    const root = `profileWriterHistory/${encodeKey(f.runId)}`, values = (await f.connection.targetDatabase.ref(`${root}/bodies`).get()).val();
    const [key, body] = Object.entries(values)[0], ref = f.connection.targetDatabase.ref(`${root}/bodies/${key}`);
    await ref.remove();
    await assert.rejects(f.transition.recover(operation), { code: 'WRITER_HISTORY_CONFLICT' });
    await assert.rejects(f.transition.replay(writer), { code: 'WRITER_HISTORY_CONFLICT' });
    assert.equal((await f.journal.read(f.runId)).value.events.length, 1);
    assert.equal((await f.repository.read('synthetic')).value.text, 'preserved'.repeat(2000));
    assert.equal((await f.history.summaryPage('operations')).items.length, 1);
    await ref.set({ ...body, payload: { invalid: true } }); await assert.rejects(f.history.get('operations', operation));
    await ref.set(body); await f.transition.replay(writer); await f.transition.drain(writer); await f.transition.activate(writer);
    assert.equal((await f.repository.read('synthetic')).value.text, 'preserved'.repeat(2000));
    assert.equal(await f.transition.recover(operation), null);
  } finally { await f.close(); }
});
test('본문/요약 확정 응답 유실은 hot 정리를 막고 새 SDK에서 같은 기록으로 재개한다', async () => {
  for (const failurePath of ['/bodies/', '/summaries/operations/']) {
    const f = await setup(), operation = id(); let injected = false;
    try {
      await write(f, operation, { text: 'synthetic'.repeat(2000) });
      const database = { ref: path => {
        const ref = f.connection.targetDatabase.ref(path);
        return new Proxy(ref, { get(target, key) {
          if (key === 'transaction') return async (...args) => {
            const result = await target.transaction(...args);
            if (!injected && path.includes(failurePath) && result.committed) { injected = true; throw Error('synthetic archive ack loss'); }
            return result;
          };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
      } };
      const history = createWriterHistoryStore({ database, runId: f.runId });
      const transition = createUserWriterTransition({ journal: f.journal, history, runId: f.runId, stores: f.stores,
        plans: createWriterPlanStore({ database: f.connection.targetDatabase, runId: f.runId }), checkKey: () => {} });
      await assert.rejects(transition.compact()); assert.equal(injected, true);
      assert.ok((await f.journal.read(f.runId)).value.operations[operation]);
      const other = await setup({}, f.runId);
      try { await other.transition.compact(); assert.equal(await other.transition.recover(operation), null);
        assert.equal((await other.history.summaryPage('operations')).items.length, 1);
        assert.equal((await other.transition.historyStatus()).archived.operations, 1); }
      finally { await other.close(); }
    } finally { await f.close(); }
  }
});
test('복수 SDK의 같은 ID/다른 ID 보관은 불변 본문을 공유하고 다른 원문 충돌을 거부한다', async () => {
  const f = await setup(), other = await setup({}, f.runId), op = archived(id());
  try {
    await Promise.all([f.history.put('operations', op.id, op), other.history.put('operations', op.id, op)]);
    const nextId = id(), next = { ...op, id: nextId, receipt: { ...op.receipt, id: nextId } };
    await other.history.put('operations', next.id, next);
    assert.deepEqual(await other.history.get('operations', op.id), op);
    const pool = (await f.connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(f.runId)}/bodies`).get()).val();
    assert.equal(Object.keys(pool).length, 1); assert.equal((await f.history.summaryPage('operations')).items.length, 2);
    await assert.rejects(f.history.put('operations', op.id, { ...op, result: 'different' }), { code: 'WRITER_HISTORY_CONFLICT' });
    const summary = f.connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(f.runId)}/summaries/operations/${encodeKey(op.id)}`);
    await summary.child('payload').set({ invalid: true }); await assert.rejects(f.history.summaryPage('operations'));
    assert.deepEqual(await f.history.get('operations', op.id), op);
  } finally { await other.close(); await f.close(); }
});
test('새 경량/기존 범용 요약을 함께 조회하고 이전 요약의 재개는 원문을 덮어쓰지 않는다', async () => {
  const f = await setup(), ops = [archived(id()), archived(id())];
  try {
    for (const op of ops) await f.history.put('operations', op.id, op);
    const items = (await f.history.summaryPage('operations')).items;
    const root = `profileWriterHistory/${encodeKey(f.runId)}/summaries/operations`;
    const fresh = (await f.connection.targetDatabase.ref(`${root}/${encodeKey(ops[1].id)}`).get()).val();
    assert.equal(fresh.payload.v, 2); assert.equal('id' in fresh.payload, false);
    const s = items.find(item => item.id === ops[0].id).value;
    const old = { ...fresh, payload: encodeValue({ format: 1, kind: 'operations', value: s, digest: fingerprint(s) }) };
    const ref = f.connection.targetDatabase.ref(`${root}/${encodeKey(ops[0].id)}`);
    await ref.set(old); assert.equal((await f.history.summaryPage('operations')).items.length, 2);
    await f.history.put('operations', ops[0].id, ops[0]); await f.history.indexPage('operations');
    assert.deepEqual((await ref.get()).val(), old);
    // 다른 ID 주소로 옮긴 요약은 주소를 포함한 지문과 일치하지 않아 거부한다.
    const copied = f.connection.targetDatabase.ref(`${root}/${encodeKey(id())}`);
    await copied.set(fresh); await assert.rejects(f.history.summaryPage('operations'), { code: 'WRITER_HISTORY_CONFLICT' });
  } finally { await f.close(); }
});
test('성공 CAS라도 다른 확정 snapshot이나 공개 직후 누락된 본문은 hot 정리 전에 거부한다', async () => {
  for (const fault of ['body', 'operation', 'summary', 'missing-after-publish']) {
    const f = await setup(), operation = id(); let injected = false;
    try {
      await write(f, operation, { text: 'preserved'.repeat(2000) });
      const root = `profileWriterHistory/${encodeKey(f.runId)}`;
      const database = { ref: path => {
        const ref = f.connection.targetDatabase.ref(path);
        return new Proxy(ref, { get(target, key) {
          if (key === 'transaction') return async (...args) => {
            const result = await target.transaction(...args);
            const selected = fault === 'body' ? '/bodies/' : fault === 'summary' ? '/summaries/operations/' : '/operations/';
            if (!injected && path.includes(selected) && result.committed) {
              injected = true;
              if (fault === 'missing-after-publish') await f.connection.targetDatabase.ref(`${root}/bodies`).remove();
              else return { ...result, snapshot: { val: () => ({ ...result.snapshot.val(), payload: { invalid: true } }) } };
            }
            return result;
          };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
      } };
      const history = createWriterHistoryStore({ database, runId: f.runId });
      const transition = createUserWriterTransition({ journal: f.journal, history, runId: f.runId, stores: f.stores,
        plans: createWriterPlanStore({ database: f.connection.targetDatabase, runId: f.runId }), checkKey: () => {} });
      await assert.rejects(transition.compact()); assert.equal(injected, true);
      assert.ok((await f.journal.read(f.runId)).value.operations[operation]);
      assert.equal((await f.repository.read('synthetic')).value.text, 'preserved'.repeat(2000));
      if (fault !== 'missing-after-publish') {
        const other = await setup({}, f.runId);
        try { await other.transition.compact(); assert.equal(await other.transition.recover(operation), null); }
        finally { await other.close(); }
      } else {
        await assert.rejects(f.history.get('operations', operation), { code: 'WRITER_HISTORY_CONFLICT' });
        // 보관이 실패해 남겨 둔 hot 원문은 기존 완료 결과를 계속 반환할 수 있다.
        assert.equal(await f.transition.recover(operation), null);
      }
    } finally { await f.close(); }
  }
});
test('복사 중 큰 변경 본문은 별도 보관 참조로 재생하고 대상 재생 승인 유실 뒤에도 이어간다', async () => {
  let fail = false; const f = await setup({ onCheckpoint: async stage => { if (fail && stage === 'replayed') { fail = false; throw Error('synthetic projection ack loss'); } } });
  try {
    const writer = await f.transition.route(); await f.transition.copy(writer);
    for (let n = 0; n < 10; n++) await write(f, id(), { body: 'x'.repeat(30000), n });
    await f.transition.compact(); const state = (await f.journal.read(f.runId)).value;
    assert.equal(state.events.length, 10); assert.ok(state.events.every(event => event.receiptDigest && !event.changes));
    assert.ok((await f.transition.historyStatus()).hotBytes < 10000);
    fail = true; await assert.rejects(f.transition.replay(writer)); const other = await setup({}, f.runId);
    try { await other.transition.replay(writer); await other.transition.compact(); await other.transition.drain(writer); await other.transition.activate(writer);
      assert.equal((await other.repository.read('synthetic')).value.n, 9);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
test('보관 ACK 유실·동시 두 SDK 정리는 원문을 지우지 않고 같은 불변 기록을 재사용한다', async () => {
  let fail = false; const f = await setup({ onCheckpoint: async stage => { if (fail && stage === 'historyArchived') { fail = false; throw Error('synthetic archive ack loss'); } } }), op = id();
  try {
    await write(f, op, { custom: null }); fail = true; await assert.rejects(f.transition.compact());
    assert.ok((await f.journal.read(f.runId)).value.operations[op]); assert.ok(await f.history.get('operations', op));
    const other = await setup({}, f.runId); try {
      const results = await Promise.allSettled([f.transition.compact(), other.transition.compact()]);
      assert.ok(results.some(result => result.status === 'fulfilled'));
      results.filter(result => result.status === 'rejected').forEach(result => assert.equal(result.reason.code, 'WRITER_HISTORY_CHANGED'));
      assert.equal((await f.transition.historyStatus()).archived.operations, 1); assert.equal(await other.transition.recover(op), null);
      const before = await f.history.get('operations', op); await assert.rejects(f.history.put('operations', op, { ...before, result: 'changed' }), { code: 'WRITER_HISTORY_CONFLICT' });
      assert.deepEqual(await f.history.get('operations', op), before);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
test('기존 format1 완료 기록은 원래 event 순번으로 보관하고 시간이나 새 순번을 추측하지 않는다', async () => {
  const f = await setup(), operation = id(); try {
    await write(f, operation, { old: null });
    await f.journal.update(f.runId, value => { delete value.operations[operation].capturedSequence; return { value }; });
    await f.transition.compact(); assert.equal((await f.history.get('operations', operation)).capturedSequence, 1);
    assert.equal(await f.transition.recover(operation), null);
  } finally { await f.close(); }
});
test('미확정 업무/외부 RPC와 복구 부모는 유지하며 완료 체인만 페이지별로 보관한다', async () => {
  const f = await setup(), operation = id(), old = id(), recovery = id();
  try {
    const writer = await f.transition.route(); await f.transition.prepare(writer, operation, [{ key: 'fs/users/pending', exists: true, token: '0', value: {} }]);
    await f.transition.beginExternal(writer, old, ['fs/users/uncertain']); await f.transition.endExternal(old, true);
    await f.transition.compact(); assert.equal((await f.transition.inspect()).unresolved, 2);
    await f.transition.cancelPrepared(writer, operation); await f.transition.drain(writer);
    await f.transition.recoverExternal(old, recovery, ['fs/users/uncertain'], { writersDrained: true });
    await f.transition.compact(); assert.ok((await f.journal.read(f.runId)).value.external[old]);
    await f.transition.endExternal(recovery); await f.transition.compact();
    assert.equal((await f.transition.inspect()).unresolved, 0); assert.equal((await f.history.get('external', old)).recoveryId, recovery);
    await assert.rejects(f.transition.beginExternal(writer, old, ['fs/users/uncertain']), { code: 'WRITER_OPERATION_CONFLICT' });
    await assert.rejects(f.transition.execute(writer, operation), { code: 'WRITER_CANCELLED' });
  } finally { await f.close(); }
});
test('보관 지문 손상/누락은 재생 전에 거부하고 hot 참조·업무 자료·receipt를 보존한다', async () => {
  const f = await setup(), operation = id(); try {
    const writer = await f.transition.route(); await f.transition.copy(writer); await write(f, operation, { custom: 'preserve' }); await f.transition.compact();
    const raw = f.connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(f.runId)}/operations/${encodeKey(operation)}`);
    const original = (await raw.get()).val(); await raw.child('payload').set({ t: 'invalid' });
    await assert.rejects(f.transition.replay(writer)); assert.equal((await f.journal.read(f.runId)).value.events.length, 1);
    assert.equal((await f.repository.read('synthetic')).value.custom, 'preserve'); await raw.set(original);
    await f.transition.replay(writer); await f.transition.drain(writer); await f.transition.activate(writer);
    assert.equal((await f.repository.read('synthetic')).value.custom, 'preserve');
    await assert.rejects(f.history.page('operations', { limit: 0 }), { code: 'WRITER_HISTORY_CONFLICT' });
  } finally { await f.close(); }
});

// 배치 캐시는 생성 승인만 공유한다. 공개 후 참조 본문의 서버 조회는 각 이력마다 남는다.
test('보관 배치의 동일 본문 생성은1회이며 배치 종료·본문 손상 뒤 새 검증을 수행한다', async () => {
  const f = await setup(), calls = { transaction: 0, get: 0 };
  try {
    const database = { ref: path => {
      const ref = f.connection.targetDatabase.ref(path);
      return new Proxy(ref, { get(o, k) {
        const v = o[k]; if (typeof v !== 'function') return v;
        return (...args) => { if (path.includes('/bodies/') && k in calls) calls[k]++; return v.apply(o, args); };
      } });
    } };
    const history = createWriterHistoryStore({ database, runId: f.runId });
    const ops = Array.from({ length: 4 }, (_, n) => archived(id(), undefined, n + 1));
    await history.withSession(() => Promise.all(ops.map(op => history.put('operations', op.id, op))));
    assert.equal(calls.transaction, 1); assert.equal(calls.get, 4);
    for (const op of ops) assert.deepEqual(await history.get('operations', op.id), op);
    const next = archived(id());
    await history.withSession(() => history.put('operations', next.id, next));
    assert.equal(calls.transaction, 2); // 이전 배치의 승인 기억을 사용하지 않는다.
    const root = `profileWriterHistory/${encodeKey(f.runId)}/bodies`;
    const raw = (await f.connection.targetDatabase.ref(root).get()).val();
    await f.connection.targetDatabase.ref(`${root}/${Object.keys(raw)[0]}`).remove();
    await assert.rejects(history.get('operations', next.id), { code: 'WRITER_HISTORY_CONFLICT' });
  } finally { await f.close(); }
});
test('같은 배치에서도 envelope 공개 뒤 본문 손상을 실제 DB에서 거부한다', async () => {
  const f = await setup(); let removed = false;
  try {
    const database = { ref: path => {
      const ref = f.connection.targetDatabase.ref(path);
      return new Proxy(ref, { get(o, k) {
        const v = o[k]; if (typeof v !== 'function') return v;
        if (k === 'transaction' && path.includes('/operations/')) return async (...args) => {
          const result = await v.apply(o, args);
          if (result.committed && !removed) {
            removed = true;
            await f.connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(f.runId)}/bodies`).remove();
          }
          return result;
        };
        return v.bind(o);
      } });
    } };
    const history = createWriterHistoryStore({ database, runId: f.runId }), op = archived(id());
    await assert.rejects(history.withSession(() => history.put('operations', op.id, op)), { code: 'WRITER_HISTORY_CONFLICT' });
    assert.equal(removed, true);
    assert.equal((await f.history.summaryPage('operations')).items.length, 0);
  } finally { await f.close(); }
});
