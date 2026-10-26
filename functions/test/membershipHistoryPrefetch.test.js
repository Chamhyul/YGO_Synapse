'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserWriterTransition } = require('../services/userWriterTransition');
const { content } = require('../services/userMigrationRehearsal');
const id = n => n.toString(16).padStart(32, '0'), key = 'fs/users/synthetic';
const copy = structuredClone;
function fixture({ compatible = true } = {}) {
  let state, hook; const archives = new Map(), calls = [], rows = new Map(), receipts = new Map();
  const journal = { read: async () => ({ exists: !!state, value: copy(state) }),
    async update(_id, mutate) { hook?.(); const next = mutate(copy(state)); state = copy(next.value); return { record: { value: copy(state) } }; } };
  if (compatible) journal.readWithFallback = async (run, select, fallback) => {
    const record = await journal.read(run); return { record, value: select(record) ? undefined : await fallback() };
  };
  const history = { async get(kind, value) { calls.push(`${kind}/${value}`); const found = archives.get(`${kind}/${value}`); if (found instanceof Error) throw found; return copy(found); },
    async put(kind, value, entry) { archives.set(`${kind}/${value}`, copy(entry)); } };
  const store = { snapshot: async () => [...rows.values()],
    async commit(op, confirmed) {
      const changes = op.changes.map(change => {
        const current = rows.get(change.key) || { exists: false, token: '0' };
        assert.equal(change.token, current.token); const saved = { ...change, token: String(Number(current.token) + 1) }; rows.set(change.key, saved); return saved;
      });
      const receipt = { id: op.id, digest: op.digest, changes, result: op.result }; receipts.set(op.id, receipt); confirmed?.(receipt);
    }, receipt: async op => receipts.get(op.id), apply: async () => { throw Error('unexpected projection'); } };
  const tool = createUserWriterTransition({ journal, history, stores: { legacy: store, rtdb: store }, runId: id(1000), checkKey: value => assert.equal(value, key),
    receiptMatches: (_op, actual, planned) => content(actual) === content(planned) });
  return { tool, journal, archives, calls, rows, get state() { return state; }, set hook(value) { hook = value; } };
}
const change = token => [{ key, exists: true, token, value: { synthetic: true } }];
async function opened(options) { const f = fixture(options); await f.tool.initialize(); f.writer = await f.tool.route(); return f; }
test('새 ID 이력 두 건은 부모 잠금 CAS 전에 시작하고 소비·완료 준비에서 재조회하지 않는다', async () => {
  const f = await opened();
  await f.tool.withOperationHistoryPrefetch([id(2), id(3)], async () => {
    f.hook = () => { if (!f.state.external?.[id(1)]) assert.equal(f.calls.filter(v => v.startsWith('operations/')).length, 2); };
    await f.tool.beginExternal(f.writer, id(1), [key]); f.hook = undefined;
    await f.tool.prepareAndExecuteWithReceipt(f.writer, id(2), change('0'), null, { parentExternal: id(1) });
    await f.tool.prepareAndExecuteWithReceipt(f.writer, id(3), change('1'), null, { parentExternal: id(1) });
    await f.tool.endExternal(id(1));
  });
  for (const n of [2, 3]) assert.equal(f.calls.filter(v => v === `operations/${id(n)}`).length, 1);
});
test('사전 부재 조회 뒤 이력 버전이 바뀌면 fresh 조회로 기존 ID 충돌을 거부한다', async () => {
  const f = await opened();
  await f.tool.withOperationHistoryPrefetch([id(2)], async () => {
    await f.tool.beginExternal(f.writer, id(1), [key]);
    f.state.historyVersion = 1; f.archives.set(`operations/${id(2)}`, { id: id(2), status: 'completed', digest: 'different' });
    await assert.rejects(f.tool.prepare(f.writer, id(2), change('0'), null, { parentExternal: id(1) }), { code: 'WRITER_OPERATION_CONFLICT' });
  });
  assert.equal(f.calls.filter(v => v === `operations/${id(2)}`).length, 2); assert.equal(f.rows.size, 0);
});
test('부재 조회 후 CAS 도중 이관되어도 historyVersion 검사를 생략하지 않는다', async () => {
  const f = await opened();
  await f.tool.withOperationHistoryPrefetch([id(2)], async () => {
    await f.tool.beginExternal(f.writer, id(1), [key]);
    f.hook = () => { f.hook = undefined; f.state.historyVersion = 1; f.archives.set(`operations/${id(2)}`, { id: id(2), status: 'completed', digest: 'different' }); };
    await assert.rejects(f.tool.prepare(f.writer, id(2), change('0'), null, { parentExternal: id(1) }), { code: 'WRITER_OPERATION_CONFLICT' });
  });
  assert.equal(f.rows.size, 0); assert.equal(f.calls.filter(v => v === `operations/${id(2)}`).length, 2);
});
test('사용할 사전 이력 조회의 실패는 업무 저장을 시작하지 않는다', async () => {
  const f = await opened(); f.archives.set(`operations/${id(2)}`, Error('synthetic unavailable'));
  await assert.rejects(f.tool.withOperationHistoryPrefetch([id(2)], async () => {
    await f.tool.beginExternal(f.writer, id(1), [key]);
    await f.tool.prepareAndExecuteWithReceipt(f.writer, id(2), change('0'), null, { parentExternal: id(1) });
  }), /synthetic unavailable/); assert.equal(f.rows.size, 0);
});
test('미사용 조회 실패는 회수하며 hot의 확정 작업이 있으면 hot 우선권을 보존한다', async () => {
  const f = await opened();
  await f.tool.prepareAndExecuteWithReceipt(f.writer, id(2), change('0'));
  f.archives.set(`operations/${id(2)}`, Error('unused archive')); f.archives.set(`operations/${id(3)}`, Error('unused archive'));
  await f.tool.withOperationHistoryPrefetch([id(2), id(3)], async () => {
    await f.tool.beginExternal(f.writer, id(1), [key]);
    assert.equal((await f.tool.prepareAndExecuteWithReceipt(f.writer, id(2), change('0'))).receipt.id, id(2));
    await f.tool.endExternal(id(1));
  });
});
test('사전 조회 결과는 다음 요청에 전달하지 않는다', async () => {
  const f = await opened();
  await f.tool.withOperationHistoryPrefetch([id(2)], () => f.tool.beginExternal(f.writer, id(1), [key]));
  await f.tool.prepare(f.writer, id(2), change('0'), null, { parentExternal: id(1) });
  assert.equal(f.calls.filter(v => v === `operations/${id(2)}`).length, 2);
});
test('구형 journal 계약은 추가 사전 조회 없이 기존 경로로 동작한다', async () => {
  const f = await opened({ compatible: false });
  await f.tool.withOperationHistoryPrefetch([id(2)], () => f.tool.beginExternal(f.writer, id(1), [key]));
  assert.equal(f.calls.filter(v => v.startsWith('operations/')).length, 0);
});
test('잘못된 ID·중복·상한 초과는 조회 전에 거부한다', async () => {
  const f = await opened();
  for (const ids of [['invalid'], [id(2), id(2)], [id(2), id(3), id(4)]]) await assert.rejects(f.tool.withOperationHistoryPrefetch(ids, () => {}));
  assert.equal(f.calls.length, 0);
});
