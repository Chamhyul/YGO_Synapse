'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserWriterTransition, createTransitionWriter } = require('../services/userWriterTransition');
const { content, fingerprint } = require('../services/userMigrationRehearsal');
const { checkKey } = require('../../integration/user-migration/adapters.cjs');
const id = n => n.toString(16).padStart(32, '0');
const key = 'fs/users/synthetic';
const change = (value, token = '0', selected = key) => ({ key: selected, exists: value !== undefined, token, ...(value !== undefined ? { value } : {}) });
function fixture(options = {}) {
  let state, commitHook, applyHook, checkpoint, historyHook;
  const archives = { operations: new Map(), external: new Map() };
  const history = { get: async (kind, id) => structuredClone(archives[kind].get(id)),
    async put(kind, id, value) {
      const previous = archives[kind].get(id); if (previous) assert.equal(fingerprint(previous), fingerprint(value));
      else archives[kind].set(id, structuredClone(value));
      await historyHook?.(kind, id);
    } };
  const journal = { read: async () => ({ exists: !!state, value: structuredClone(state) }),
    async update(_id, mutate) { state = structuredClone(mutate(structuredClone(state)).value); return { record: { value: structuredClone(state) } }; } };
  function store() {
    const rows = new Map(), receipts = new Map(), projections = new Map(); let calls = 0;
    return { rows, receipts, projections, get calls() { return calls; },
      snapshot: async () => [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
      async commit(op) {
        calls++; await commitHook?.('before', op);
        if (receipts.has(op.id)) return;
        const after = op.changes.map(item => {
          const before = rows.get(item.key) || change(undefined);
          assert.equal(item.token, before.token);
          return { ...structuredClone(item), token: String(Number(before.token) + 1) };
        });
        for (const entry of after) rows.set(entry.key, entry);
        receipts.set(op.id, { id: op.id, digest: op.digest, changes: after, result: op.result });
        await commitHook?.('after', op);
      },
      receipt: async op => structuredClone(receipts.get(op.id)),
      async fence(op) { if (!receipts.has(op.id)) receipts.set(op.id, { id: op.id, digest: op.digest, outcome: 'cancelled' }); return structuredClone(receipts.get(op.id)); },
      async apply(opId, entry, expected) {
        if (projections.has(opId)) return structuredClone(projections.get(opId));
        const before = rows.get(entry.key) || change(undefined, '0', entry.key);
        assert.equal(fingerprint(before), fingerprint(expected));
        const saved = { ...structuredClone(entry), token: String(Number(before.token) + 1) };
        rows.set(entry.key, saved); projections.set(opId, saved);
        await applyHook?.(opId); return structuredClone(saved);
      },
    };
  }
  const stores = { legacy: store(), rtdb: store() };
  const make = () => createUserWriterTransition({ journal, stores, runId: id(1000), checkKey,
    ...(options.useHistory ? { history } : {}),
    onCheckpoint: (...args) => checkpoint?.(...args), ...options });
  return { stores, journal, history, archives, state: () => structuredClone(state), make, tool: make(), set historyHook(v) { historyHook = v; }, set commitHook(v) { commitHook = v; }, set applyHook(v) { applyHook = v; }, set checkpoint(v) { checkpoint = v; } };
}
async function write(f, writer, n, value, selected = key, result = null) {
  const store = f.stores[writer.backend], before = store.rows.get(selected);
  return createTransitionWriter(f.tool, writer).write(id(n), [change(value, before?.token || '0', selected)], result);
}
test('resume는 종료 확인·drain·미확정0을 요구하고 잠금이나 원본을 강제로 바꾸지 않는다', async () => {
  const f = fixture(), writer = await f.tool.initialize(), options = { id: id(900), writersDrained: true };
  await assert.rejects(f.tool.resume(writer, { id: id(900) }), { code: 'WRITER_RESUME_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.tool.resume(writer, options), { code: 'WRITER_NOT_DRAINED' });
  await f.tool.prepare(writer, id(1), [change({ n: 1 })]); await f.tool.drain(writer); const before = f.state();
  await assert.rejects(f.tool.resume(writer, options), { code: 'WRITER_NOT_DRAINED' }); assert.deepEqual(f.state(), before);
  await f.tool.cancelPrepared(writer, id(1)); await f.tool.cancelPrepared(writer, id(1));
  await assert.rejects(f.tool.execute(writer, id(1)), { code: 'WRITER_CANCELLED' }); assert.equal(f.stores.legacy.calls, 0);
  await f.tool.beginExternal(writer, id(2), [key]).catch(error => assert.equal(error.code, 'WRITER_DRAINING'));
  // drain 전에 등록된 미확정 Auth는 resume에서도 해제하지 않는다.
  const g = fixture(), source = await g.tool.initialize(); await g.tool.beginExternal(source, id(2), [key]); await g.tool.drain(source);
  const locked = g.state(); await assert.rejects(g.tool.resume(source, options), { code: 'WRITER_NOT_DRAINED' }); assert.deepEqual(g.state(), locked);
  await assert.rejects(f.tool.resume({ ...writer, epoch: 2 }, options), { code: 'WRITER_FENCED' });
});
test('실패한 복사의 진행점·영수증·이력을 보존해 원본 쓰기와 후속 전환을 재개한다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize(); await write(f, writer, 1, { n: 1, null: null, array: [] });
  let failed = false; f.applyHook = async () => { if (!failed) { failed = true; throw Error('합성 대상 승인 유실'); } };
  await assert.rejects(f.tool.copy(writer), /합성 대상 승인 유실/);
  await write(f, writer, 2, { n: 2 }); await f.tool.drain(writer); const before = f.state();
  const resumed = await f.tool.resume(writer, { id: id(900), writersDrained: true });
  assert.deepEqual(resumed, { backend: 'legacy', epoch: 2, phase: 'accepting' });
  for (const field of ['transfer', 'operations', 'events', 'frozen', 'sequence', 'floor']) assert.deepEqual(f.state()[field], before[field]);
  await assert.rejects(write(f, writer, 3, { n: 3 }), { code: 'WRITER_FENCED' });
  await write(f, resumed, 3, { n: 3 }); await write(f, resumed, 4, { empty: {} }, 'inventory/new');
  await f.tool.copy(resumed); await f.tool.drain(resumed); const active = await f.tool.activate(resumed);
  assert.equal(active.backend, 'rtdb'); assert.equal(active.epoch, 3); assert.deepEqual(f.stores.rtdb.rows.get(key).value, { n: 3 });
  assert.deepEqual(f.stores.rtdb.rows.get('inventory/new').value, { empty: {} });
  await f.tool.copy(active); await f.tool.drain(active); assert.equal((await f.tool.activate(active)).backend, 'legacy');
});
test('resume 응답 유실은 같은 ID의 새 연결에서 멱등이며 새 잠금·업무를 건드리지 않는다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await f.tool.drain(writer); let once = true;
  f.checkpoint = async stage => { if (stage === 'writersResumed' && once) { once = false; throw Error('합성 재개 응답 유실'); } };
  const options = { id: id(900), writersDrained: true }; await assert.rejects(f.tool.resume(writer, options), /합성 재개 응답 유실/);
  const resumed = await f.make().resume(writer, options); assert.equal(resumed.epoch, 2);
  await f.tool.beginExternal(resumed, id(2), [key]); const before = f.state();
  assert.deepEqual(await f.make().resume(writer, options), resumed); assert.deepEqual(f.state(), before);
  await assert.rejects(f.tool.resume(resumed, options), { code: 'WRITER_RESUME_CONFLICT' });
  await assert.rejects(f.tool.resume(writer, { ...options, id: id(901) }), { code: 'WRITER_FENCED' });
});
test('resume 뒤 다시 drain해도 지연된 이전 activate가 backend를 바꾸지 못한다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await write(f, writer, 1, { n: 1 }); await f.tool.copy(writer); await f.tool.drain(writer);
  let entered, release; const atSnapshot = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = f.stores.rtdb.snapshot; f.stores.rtdb.snapshot = async () => { const value = await original(); entered(); await gate; return value; };
  const pending = assert.rejects(f.tool.activate(writer), { code: 'WRITER_FENCED' }); await atSnapshot;
  const resumed = await f.make().resume(writer, { id: id(900), writersDrained: true }); await f.tool.drain(resumed);
  release(); await pending; assert.equal(f.state().backend, 'legacy'); assert.equal(f.state().epoch, 2);
  f.stores.rtdb.snapshot = original; await f.tool.copy(resumed); assert.equal((await f.tool.activate(resumed)).backend, 'rtdb');
});
test('복사 전 resume의 과거 epoch 변경분도 재생하며 RTDB 원본에서도 재개·역전환한다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize(); await write(f, writer, 1, { n: 1 }); await f.tool.drain(writer);
  const resumed = await f.tool.resume(writer, { id: id(900), writersDrained: true }); await f.tool.copy(resumed); await f.tool.drain(resumed);
  const active = await f.tool.activate(resumed); assert.equal(active.backend, 'rtdb');
  await f.tool.copy(active); await write(f, active, 2, { n: 2 }); await f.tool.compact();
  assert.ok(f.state().events.some(event => event.sequence > f.state().transfer.cursor && !event.changes)); await f.tool.drain(active);
  const back = await f.tool.resume(active, { id: id(901), writersDrained: true }); assert.equal(back.backend, 'rtdb');
  await f.tool.copy(back); await f.tool.drain(back); const restored = await f.tool.activate(back);
  assert.equal(restored.backend, 'legacy'); assert.deepEqual(f.stores.legacy.rows.get(key).value, { n: 2 });
});
test('재개의 epoch 한도와 보존된 응답 표식 변조는 쓰기 허용 전에 거부한다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await f.tool.drain(writer);
  await f.journal.update(id(1000), state => ({ value: { ...state, epoch: Number.MAX_SAFE_INTEGER } })); const before = f.state();
  await assert.rejects(f.tool.resume({ ...writer, epoch: Number.MAX_SAFE_INTEGER }, { id: id(900), writersDrained: true }), { code: 'WRITER_SEQUENCE_EXHAUSTED' });
  assert.deepEqual(f.state(), before);
  await f.journal.update(id(1000), state => ({ value: { ...state, epoch: 1, lastResume: { id: id(900), backend: 'legacy', fromEpoch: 1, toEpoch: 2 } } }));
  await assert.rejects(f.tool.resume(writer, { id: id(900), writersDrained: true }), { code: 'WRITER_STATE_INVALID' });
});
test('이미 executing으로 넘어간 요청은 준비 취소/resume로 우회하지 않고 종료까지 기다린다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await f.tool.prepare(writer, id(1), [change({ n: 1 })]);
  let entered, release; const atExecution = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.checkpoint = async stage => { if (stage === 'executing') { entered(); await gate; } };
  const pending = f.tool.execute(writer, id(1)); await atExecution; await f.tool.drain(writer);
  await assert.rejects(f.tool.cancelPrepared(writer, id(1)), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  await assert.rejects(f.tool.resume(writer, { id: id(900), writersDrained: true }), { code: 'WRITER_NOT_DRAINED' });
  release(); await pending; assert.equal(f.stores.legacy.calls, 1);
  assert.equal((await f.tool.resume(writer, { id: id(900), writersDrained: true })).epoch, 2);
});
test('실행 중 변경을 복사·재생하고 새 writer의 변경을 다시 역방향 전환한다', async () => {
  const f = fixture(), old = await f.tool.initialize();
  await write(f, old, 1, { settings: { theme: 'dark' }, null: null, array: [], map: {} });
  await f.tool.copy(old);
  await write(f, old, 2, { settings: { theme: 'light' } });
  await write(f, old, 3, undefined);
  await write(f, old, 4, { registration: { completed: true } });
  await f.tool.replay(old); await f.tool.replay(old); await f.tool.drain(old);
  const current = await f.tool.activate(old);
  assert.equal(current.backend, 'rtdb'); assert.equal(current.epoch, 2);
  await write(f, current, 5, { settings: { membership: { active: true } } });
  await write(f, current, 6, { quantities: [5, 2], locations: { 7: '상자' } }, 'inventory/only');
  await f.tool.copy(current); await f.tool.drain(current); const restored = await f.tool.activate(current);
  assert.equal(restored.epoch, 3); assert.equal(restored.backend, 'legacy');
  assert.equal(content(f.stores.legacy.rows.get(key)), content(f.stores.rtdb.rows.get(key)));
  assert.equal((await f.tool.inspect()).unresolved, 0);
});
test('고정 epoch의 이전 writer와 새 writer 조기 요청을 거부하고 기존 응답은 유지한다', async () => {
  const f = fixture(), old = await f.tool.initialize(), response = { success: true, existing: null };
  assert.deepEqual(await write(f, old, 1, { a: 1 }, key, response), response);
  await assert.rejects(write(f, { backend: 'rtdb', epoch: 2 }, 2, { a: 2 }), { code: 'WRITER_FENCED' });
  await f.tool.copy(old); await f.tool.drain(old); await f.tool.activate(old);
  await assert.rejects(write(f, old, 3, { a: 3 }), { code: 'WRITER_FENCED' });
  assert.deepEqual(await createTransitionWriter(f.tool, old).write(id(1), [change({ a: 1 })], response), response);
  assert.equal(f.stores.legacy.calls, 1);
  await assert.rejects(createTransitionWriter(f.tool, old).write(id(1), [change({ a: 9 })], response), { code: 'WRITER_OPERATION_CONFLICT' });
});
test('늦은 RPC가 완료되기 전 전환을 막으며 등록된 요청만 drain 뒤 완료한다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  let release, started; const entered = new Promise(resolve => { started = resolve; });
  f.commitHook = async phase => { if (phase === 'before') { started(); await new Promise(resolve => { release = resolve; }); } };
  const pending = write(f, writer, 1, { a: 1 }); await entered;
  await f.tool.copy(writer); await f.tool.drain(writer);
  await assert.rejects(write(f, writer, 2, { a: 2 }), { code: 'WRITER_DRAINING' });
  await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
  release(); await pending; await f.tool.activate(writer);
  assert.equal(f.stores.rtdb.rows.get(key).value.a, 1);
});
test('업무 저장 응답 유실은 영수증으로만 복구하고 commit을 두 번 호출하지 않는다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  f.commitHook = phase => { if (phase === 'after') throw new Error('합성 응답 유실'); };
  await assert.rejects(write(f, writer, 1, { a: 1 }));
  f.tool = f.make(); await f.tool.copy(writer); await f.tool.drain(writer);
  await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
  await assert.rejects(f.tool.execute(writer, id(1)), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  await f.tool.recover(id(1)); await f.tool.recover(id(1)); await f.tool.activate(writer);
  assert.equal(f.stores.legacy.calls, 1);
});
test('본문이 일치해도 영수증 없는 미확정 실행은 해제하거나 재실행하지 않는다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  f.commitHook = phase => { if (phase === 'before') throw new Error('미확정 RPC'); };
  await assert.rejects(write(f, writer, 1, { a: 1 }));
  f.stores.legacy.rows.set(key, change({ a: 1 }, '1'));
  await assert.rejects(f.tool.recover(id(1)), { code: 'WRITER_RECEIPT_REQUIRED' });
  await assert.rejects(f.tool.cancelPrepared(writer, id(1)), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  await assert.rejects(write(f, writer, 2, { a: 2 }), { code: 'WRITER_RESOURCE_BUSY' });
});
test('제출 전 작업만 취소 가능하고 drain과 경쟁한 새 등록은 거부한다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  await f.tool.prepare(writer, id(1), [change({ a: 1 })]); await f.tool.drain(writer);
  await assert.rejects(f.tool.prepare(writer, id(2), [change({ a: 2 })]), { code: 'WRITER_DRAINING' });
  await f.tool.cancelPrepared(writer, id(1)); await f.tool.copy(writer); await f.tool.activate(writer);
  assert.equal(f.stores.legacy.calls, 0);
});
test('재생 응답 유실 후 durable projection으로 재개하며 중복/오래된 재생을 막는다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await write(f, writer, 1, { a: 1 });
  let once = true; f.applyHook = () => { if (once) { once = false; throw new Error('재생 응답 유실'); } };
  await assert.rejects(f.tool.copy(writer)); f.tool = f.make(); await f.tool.copy(writer);
  await write(f, writer, 2, undefined); await f.tool.replay(writer); await f.tool.replay(writer);
  await f.tool.drain(writer); await f.tool.activate(writer);
  await assert.rejects(f.tool.replay(writer), { code: 'WRITER_FENCED' });
  assert.equal(f.stores.rtdb.rows.get(key).exists, false);
});
test('활성 writer를 우회한 원본/대상 변경은 대조 실패로 전환을 막는다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); await write(f, writer, 1, { a: 1 });
  await f.tool.copy(writer); await f.tool.drain(writer);
  f.stores.legacy.rows.set(key, change({ a: 9 }, '9'));
  await assert.rejects(f.tool.activate(writer), { code: 'WRITER_COMPARE_FAILED' });
  f.stores.rtdb.rows.set(key, change({ a: 8 }, '8'));
  await assert.rejects(f.tool.activate(writer), { code: 'WRITER_DESTINATION_CHANGED' });
});
test('관련 영역만 허용하고 데이터 없는 상태도 전환하며 기록 한도에서 fail closed한다', async () => {
  const f = fixture({ maxOperations: 1 }), writer = await f.tool.initialize();
  await assert.rejects(write(f, writer, 1, {}, 'fs/cards/a'), { code: 'MIGRATION_INVALID_SNAPSHOT' });
  await write(f, writer, 1, { a: 1 });
  await assert.rejects(write(f, writer, 2, { a: 2 }), { code: 'WRITER_JOURNAL_FULL' });
  const empty = fixture(), fresh = await empty.tool.initialize(); await empty.tool.copy(fresh); await empty.tool.drain(fresh);
  assert.equal((await empty.tool.activate(fresh)).backend, 'rtdb');
});
test('키 정책처럼 변경하지 않는 조회 의존성도 동일한 작업 자원으로 잠근다', async () => {
  const f = fixture(), writer = await f.tool.initialize(), policy = 'fs/cardApiKeys/key', usage = 'fs/cardApiUsage/key';
  await f.tool.prepare(writer, id(1), [change({ day: 1 }, '0', usage)], null, { resources: [policy] });
  await assert.rejects(f.tool.prepare(writer, id(2), [change({ enabled: false }, '0', policy)]), { code: 'WRITER_RESOURCE_BUSY' });
  await f.tool.cancelPrepared(writer, id(1)); await f.tool.prepare(writer, id(2), [change({ enabled: false }, '0', policy)]);
});
test('변경 포착 ACK 유실 후 API 결과를 그대로 반환하고 기록을 한 번만 남긴다', async () => {
  const f = fixture(), writer = await f.tool.initialize(), response = { success: true, count: 1 };
  f.checkpoint = stage => { if (stage === 'captured') throw new Error('합성 포착 ACK 유실'); };
  await assert.rejects(write(f, writer, 1, { a: 1 }, key, response)); f.checkpoint = undefined;
  assert.deepEqual(await f.tool.recover(id(1)), response);
  assert.equal((await f.tool.inspect()).captured, 1); assert.equal(f.stores.legacy.calls, 1);
});
test('포착 영수증·변경 기록을 위한 공간을 업무 저장 전에 예약한다', async () => {
  const f = fixture({ maxBytes: 4000 }), writer = await f.tool.initialize();
  await assert.rejects(write(f, writer, 1, { body: 'x'.repeat(1500) }), { code: 'WRITER_JOURNAL_FULL' });
  assert.equal(f.stores.legacy.calls, 0); assert.equal((await f.tool.inspect()).unresolved, 0);
});
test('보관된 완료 ID/결과는 총128건을 넘겨도 재실행·다른 명령 재사용 없이 유지한다', async () => {
  const f = fixture({ useHistory: true, maxOperations: 8 }), writer = await f.tool.initialize();
  const response = { success: true, preserved: null }; await write(f, writer, 1, { n: 1 }, key, response);
  for (let n = 2; n <= 160; n++) await write(f, writer, n, { n });
  await f.tool.compact(); assert.equal((await f.tool.historyStatus()).retainedOperations, 0);
  assert.equal(f.archives.operations.size, 160); assert.equal(f.stores.legacy.calls, 160);
  assert.deepEqual(await createTransitionWriter(f.make(), writer).write(id(1), [change({ n: 1 })], response), response);
  await assert.rejects(createTransitionWriter(f.tool, writer).write(id(1), [change({ n: 999 })], response), { code: 'WRITER_OPERATION_CONFLICT' });
  assert.equal(f.stores.legacy.calls, 160); await f.tool.copy(writer); await f.tool.drain(writer); const next = await f.tool.activate(writer);
  await write(f, next, 161, { n: 161 }); await f.tool.copy(next); await f.tool.drain(next); await f.tool.activate(next);
  assert.equal(f.stores.legacy.rows.get(key).value.n, 161); assert.deepEqual(await f.tool.recover(id(1)), response);
});
test('보관 승인 유실은 hot 기록을 남기며 새 연결이 동일 증거로 정리를 재개한다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize(); await write(f, writer, 1, { n: 1 });
  f.historyHook = () => { throw Error('합성 보관 ACK 유실'); };
  await assert.rejects(f.tool.compact()); assert.ok(f.state().operations[id(1)]); assert.equal(f.state().events.length, 1);
  f.historyHook = undefined; f.tool = f.make(); await f.tool.compact(); assert.equal(f.state().operations[id(1)], undefined);
  assert.equal(f.archives.operations.size, 1); assert.equal(await f.tool.recover(id(1)), null);
});
test('보관 조회와 정리 CAS 경합은 이전 ID를 새 prepared 작업으로 되살리지 않는다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize();
  const read = f.history.get; let once = true;
  f.history.get = async (kind, operation) => { const value = await read(kind, operation); if (once && operation === id(1)) { once = false; await write(f, writer, 1, { n: 1 }); await f.tool.compact(); } return value; };
  await createTransitionWriter(f.tool, writer).write(id(1), [change({ n: 1 })]);
  assert.equal(f.stores.legacy.calls, 1); assert.equal(f.archives.operations.size, 1);
});
test('미확정 작업/외부 잠금은 정리하지 않고 종료된 복구 체인만 함께 보관한다', async () => {
  const f = fixture({ useHistory: true, maxOperations: 8 }), writer = await f.tool.initialize();
  await f.tool.beginExternal(writer, id(200), [key]); await f.tool.endExternal(id(200), true);
  await f.tool.compact(); assert.equal((await f.tool.inspect()).externalUnresolved, 1);
  await f.tool.drain(writer); const recovery = await f.tool.recoverExternal(id(200), id(201), [key], { writersDrained: true });
  await f.tool.compact(); assert.ok(f.state().external[id(200)]); assert.equal(f.archives.external.size, 0);
  assert.equal(await f.tool.recoverExternal(id(200), id(201), [key], { writersDrained: true }), recovery);
  await f.tool.endExternal(recovery); await f.tool.compact(); assert.equal(f.archives.external.size, 2);
  await assert.rejects(f.tool.beginExternal(writer, id(200), [key]), { code: 'WRITER_OPERATION_CONFLICT' });
  const pending = fixture({ useHistory: true, maxOperations: 1 }), route = await pending.tool.initialize();
  await pending.tool.prepare(route, id(1), [change({ n: 1 })]); await pending.tool.compact();
  await assert.rejects(write(pending, route, 2, { n: 2 }), { code: 'WRITER_JOURNAL_FULL' });
  assert.ok(pending.state().operations[id(1)]); assert.equal(pending.archives.operations.size, 0);
});
test('복사 중 보관한 변경은 receipt 참조로 순서대로 재생하며 지문 누락/변조는 거부한다', async () => {
  const f = fixture({ useHistory: true, maxOperations: 8 }), writer = await f.tool.initialize(); await f.tool.copy(writer);
  for (let n = 1; n <= 12; n++) await write(f, writer, n, { n });
  await f.tool.compact(); assert.equal(f.state().events.length, 12); assert.ok(f.state().events.every(event => event.receiptDigest && !event.changes));
  const original = f.archives.operations.get(id(1)); f.archives.operations.delete(id(1));
  await assert.rejects(f.tool.replay(writer), { code: 'WRITER_HISTORY_CONFLICT' }); f.archives.operations.set(id(1), original);
  await f.tool.replay(writer); await f.tool.compact(); assert.equal(f.state().events.length, 0);
  assert.deepEqual(Object.keys(f.state().transfer.applied), []); await f.tool.drain(writer); await f.tool.activate(writer);
  assert.equal(f.stores.rtdb.rows.get(key).value.n, 12);
});
test('완료 이력으로 인한 bytes 부족은 보관 후 재시도하되 단일 초과 명령은 RPC 전에 거부한다', async () => {
  const f = fixture({ useHistory: true, maxBytes: 6000 }), writer = await f.tool.initialize();
  for (let n = 1; n <= 10; n++) await write(f, writer, n, { body: 'x'.repeat(700), n });
  assert.ok(f.archives.operations.size > 0); assert.equal(f.stores.legacy.calls, 10);
  await assert.rejects(write(f, writer, 11, { body: 'x'.repeat(10000) }), { code: 'WRITER_JOURNAL_FULL' });
  assert.equal(f.stores.legacy.calls, 10);
});
test('재생 checkpoint 정리 뒤 늦은 이전 재생 응답은 cursor/대상 기대값을 되돌리지 않는다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize(); await f.tool.copy(writer); await write(f, writer, 1, { n: 1 });
  let release, entered; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.applyHook = async () => { entered(); await gate; };
  const pending = f.tool.replay(writer); await ready; f.applyHook = undefined;
  await f.tool.replay(writer); await f.tool.compact(); await write(f, writer, 2, { n: 2 }); await f.tool.replay(writer); await f.tool.compact();
  release(); await pending; assert.equal(f.state().transfer.cursor, 2); assert.equal(f.state().transfer.expected[0].value.n, 2);
  await f.tool.drain(writer); await f.tool.activate(writer); assert.equal(f.stores.rtdb.rows.get(key).value.n, 2);
});
test('보관된 run은 보관 의존성을 생략한 엔진으로 다시 열어 ID 증거를 우회하지 못한다', async () => {
  const f = fixture({ useHistory: true }), writer = await f.tool.initialize(); await write(f, writer, 1, { n: 1 }); await f.tool.compact();
  const unsafe = createUserWriterTransition({ journal: f.journal, stores: f.stores, runId: id(1000), checkKey });
  await assert.rejects(unsafe.route(), { code: 'WRITER_HISTORY_REQUIRED' }); assert.equal(f.stores.legacy.calls, 1);
});
test('업무 DB의 영구 취소 fence가 늦은 미반영 RPC를 차단한 뒤에만 전환한다', async () => {
  const f = fixture(), writer = await f.tool.initialize(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.commitHook = async phase => { if (phase === 'before') { entered(); await new Promise(resolve => { release = resolve; }); } };
  const pending = write(f, writer, 1, { a: 1 }); await started;
  assert.deepEqual(await f.tool.fenceUncommitted(id(1)), { status: 'cancelled' });
  await f.tool.copy(writer); await f.tool.drain(writer); await f.tool.activate(writer);
  release(); await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
  assert.equal(f.stores.legacy.rows.size, 0); assert.equal(f.stores.rtdb.rows.size, 0);
});

test('외부 Auth 등록은 UID 자원·drain·역전환을 잠그며 불확실한 응답을 자동 해제하지 않는다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  await f.tool.beginExternal(writer, id(20), [key]);
  await assert.rejects(write(f, writer, 21, {}), { code: 'WRITER_RESOURCE_BUSY' });
  await f.tool.copy(writer); await f.tool.drain(writer);
  await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
  await f.tool.endExternal(id(20), true);
  await assert.rejects(f.tool.endExternal(id(20)), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  await assert.rejects(f.tool.recoverExternal(id(20), id(22), [key]), { code: 'WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.tool.recoverExternal(id(20), id(22), ['fs/users/other'], { writersDrained: true }), { code: 'WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED' });
  await f.tool.recoverExternal(id(20), id(22), [key], { writersDrained: true });
  await f.tool.endExternal(id(22)); assert.equal((await f.tool.activate(writer)).backend, 'rtdb');
});
test('drain 뒤 기존 인증의 하위 저장만 같은 epoch와 자원 범위에서 허용한다', async () => {
  const f = fixture(), writer = await f.tool.initialize();
  await f.tool.beginExternal(writer, id(30), [key]); await f.tool.drain(writer);
  await assert.rejects(f.tool.prepare(writer, id(31), [change({})]), { code: 'WRITER_DRAINING' });
  await assert.rejects(f.tool.prepare(writer, id(31), [change({}, '0', 'fs/users/other')], null, { parentExternal: id(30) }), { code: 'WRITER_FENCED' });
  await f.tool.prepare(writer, id(31), [change({ a: 1 })], null, { parentExternal: id(30) });
  await f.tool.execute(writer, id(31)); await f.tool.endExternal(id(30));
  await f.tool.copy(writer); assert.equal((await f.tool.activate(writer)).backend, 'rtdb');
});
test('외부 작업도 기록 한도에서 업무 RPC 전에 거부한다', async () => {
  const f = fixture({ maxOperations: 1 }), writer = await f.tool.initialize();
  await f.tool.beginExternal(writer, id(40), [key]); await f.tool.endExternal(id(40));
  await assert.rejects(write(f, writer, 41, {}), { code: 'WRITER_JOURNAL_FULL' });
  assert.equal(f.stores.legacy.calls, 0);
});


test('등록된 로그인 요청은 drain 뒤 새 cookie hash 자원을 충돌 확인 후 확장한다', async () => {
  const f = fixture(), writer = await f.tool.initialize(), extra = 'fs/users/other';
  await f.tool.beginExternal(writer, id(80), [key]); await f.tool.beginExternal(writer, id(81), [extra]);
  await f.tool.drain(writer);
  await assert.rejects(f.tool.addExternalResources(id(80), [extra]), { code: 'WRITER_RESOURCE_BUSY' });
  await f.tool.endExternal(id(81)); await f.tool.addExternalResources(id(80), [extra]);
  await f.tool.prepare(writer, id(82), [change({ value: 1 }, '0', extra)], null, { parentExternal: id(80) });
  await f.tool.execute(writer, id(82)); await f.tool.endExternal(id(80));
  await assert.rejects(f.tool.addExternalResources(id(80), [extra]), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  await f.tool.copy(writer); assert.equal((await f.tool.activate(writer)).backend, 'rtdb');
});

test('병렬 조회 뒤 historyVersion이 바뀌면 재조회하고 보관된 완료 ID를 다시 실행하지 않는다', async () => {
  const f = fixture({ useHistory: true, historyMaintenance: 'deferred' });
  const writer = await f.tool.initialize(); await write(f, writer, 51, { n: 1 }); await f.tool.compact();
  let reads = 0;
  f.journal.readWithFallback = async (run, select, fallback) => {
    reads++;
    const record = await f.journal.read(run), value = select(record) ? undefined : await fallback();
    if (reads === 1) await f.journal.update(run, state => ({ value: { ...state, historyVersion: (state.historyVersion || 0) + 1 } }));
    return { record, value };
  };
  // 이미 완료된 ID는 불변 이력의 결과로 반환하며 업무를 다시 호출하지 않는다.
  const before = f.stores.legacy.calls;
  await f.tool.prepare(writer, id(51), [change({ n: 1 })]);
  assert.equal(f.stores.legacy.calls, before);
  // 새로운 ID는 변경된 historyVersion을 CAS에서 대조한다.
  reads = 0;
  await f.tool.prepare(writer, id(52), [change({ n: 2 }, '1')]);
  assert(reads >= 2);
});
