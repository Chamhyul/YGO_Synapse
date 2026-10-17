'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createWriterPlanStore } = require('../services/user-storage/writerPlanStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');
const runId = '1'.repeat(32), captureId = '2'.repeat(32);
const context = { transferId: '3'.repeat(32), backend: 'legacy', epoch: 1, role: 'baseline' };
function fixture() {
  const data = new Map(), copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const snapshot = value => ({ val: () => copy(value) });
  const database = { ref(path) { return {
    get: async () => snapshot(data.get(path)),
    on(_event, listener) { queueMicrotask(() => listener(snapshot(data.get(path)))); }, off() {},
    async transaction(mutate) { const next = mutate(copy(data.get(path))); if (next === undefined) return { committed: false, snapshot: snapshot(data.get(path)) };
      data.set(path, copy(next)); return { committed: true, snapshot: snapshot(next) }; },
  }; } };
  return { database, data, plans: () => createWriterPlanStore({ database, runId, pageSize: 2 }) };
}
const entry = n => ({ key: `fs/users/${String(n).padStart(3, '0')}`, exists: true, token: '1', value: { n, body: '합성🙂'.repeat(20), null: null, empty: [] } });
const cursor = source => ({ source, after: null });
const source = calls => async after => { const n = after?.source ?? 0; calls.push(n); return { entries: [entry(n)], cursor: n < 2 ? cursor(n + 1) : null, done: n === 2 }; };
async function values(plans, ref) { const result = []; for await (const row of plans.scan(ref)) result.push(row.entry); return result; }
test('수집 페이지 저장 ACK 유실은 새 store에서 해당 원본 페이지를 다시 읽지 않고 이어간다', async () => {
  const f = fixture(), calls = []; let once = true;
  await assert.rejects(f.plans().collect(captureId, context, source(calls), { onCheckpoint: async stage => { if (stage === 'sourcePageSaved' && once) { once = false; throw Error('합성 ACK 유실'); } } }));
  const plans = f.plans(), ref = await plans.collect(captureId, context, source(calls));
  assert.deepEqual(calls, [0, 1, 2]); assert.deepEqual(await values(plans, ref), [entry(0), entry(1), entry(2)]);
});
test('진행점 ACK 유실과 완료 재호출은 확정 원본·계획 ID를 유지하고 원본 재조회를 생략한다', async () => {
  const f = fixture(), calls = []; let once = true;
  await assert.rejects(f.plans().collect(captureId, context, source(calls), { onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && once) { once = false; throw Error('합성 진행점 응답 유실'); } } }));
  const plans = f.plans(), ref = await plans.collect(captureId, context, source(calls));
  assert.deepEqual(calls, [0, 1, 2]); assert.deepEqual(await plans.collect(captureId, context, async () => { throw Error('완료한 원본 재조회'); }), ref);
});
test('진행점 변조·페이지 누락·연결 대상 교체는 원본 읽기 전에 거부한다', async () => {
  const f = fixture(); let once = true;
  await assert.rejects(f.plans().collect(captureId, context, source([]), { onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && once) { once = false; throw Error('중단'); } } }));
  const progress = createRecordStore({ database: f.database, path: `profileWriterPlans/${encodeKey(runId)}/collections` }), old = await progress.read(captureId);
  let reads = 0; const noRead = async () => { reads++; throw Error('읽지 않아야 함'); };
  await assert.rejects(f.plans().collect(captureId, { ...context, epoch: 2 }, noRead), { code: 'WRITER_PLAN_CONFLICT' });
  await progress.compareAndSet(captureId, old.revision, { ...old.value, cursor: cursor(2) });
  await assert.rejects(f.plans().collect(captureId, context, noRead), { code: 'WRITER_PLAN_CONFLICT' }); assert.equal(reads, 0);
  const now = await progress.read(captureId); await progress.compareAndSet(captureId, now.revision, old.value);
  f.data.delete(`profileWriterPlans/${encodeKey(runId)}/collectionPages/${captureId}/${encodeKey('0'.repeat(32))}`);
  await assert.rejects(f.plans().collect(captureId, context, noRead), { code: 'WRITER_PLAN_CONFLICT' }); assert.equal(reads, 0);
});
test('두 수집기의 같은 페이지 경합은 한 페이지 체인으로 확정되고 중복 키를 다시 게시하지 않는다', async () => {
  const f = fixture(), calls = [], a = f.plans(), b = f.plans();
  const [left, right] = await Promise.all([a.collect(captureId, context, source(calls)), b.collect(captureId, context, source(calls))]);
  assert.deepEqual(left, right); assert.equal(left.count, 3); assert.deepEqual(await values(a, left), [entry(0), entry(1), entry(2)]);
});
test('수집 입력 오류·멈춘 cursor·본문 손상은 완성 계획을 게시하지 않는다', async () => {
  const f = fixture();
  await assert.rejects(f.plans().collect(captureId, context, async () => ({ entries: [entry(0)], cursor: null, done: false })), { code: 'WRITER_PLAN_CONFLICT' });
  const manifest = createRecordStore({ database: f.database, path: `profileWriterPlans/${encodeKey(runId)}/manifests` }); assert.equal((await manifest.read(captureId)).exists, false);
  const g = fixture(), plans = g.plans(), ref = await plans.collect(captureId, context, source([]));
  const chunk = [...g.data.keys()].find(key => key.includes(`/chunks/${captureId}/`)); g.data.get(chunk).payload = { type: 'invalid' };
  await assert.rejects(g.plans().collect(captureId, context, source([])));
  assert.equal(ref.count, 3);
});

test('페이지 도중 중단된 후보는 참조가 확정된 첫 본문을 유지하고 바뀐 재조회 값으로 덮어쓰지 않는다', async () => {
  const f = fixture();
  async function* interrupted() { yield entry(0); throw Error('합성 본문 수집 중단'); }
  await assert.rejects(f.plans().collect(captureId, context, async () => ({ entries: interrupted(), cursor: null, done: true })), /합성 본문 수집 중단/);
  async function* resumed() { yield { ...entry(0), value: { changed: true } }; yield entry(1); }
  const plans = f.plans(), ref = await plans.collect(captureId, context, async () => ({ entries: resumed(), cursor: null, done: true }));
  assert.deepEqual(await values(plans, ref), [entry(0), entry(1)]);
});
