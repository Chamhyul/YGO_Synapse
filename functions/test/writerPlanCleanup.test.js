'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createWriterPlanStore } = require('../services/user-storage/writerPlanStore');
const { createUserWriterTransition } = require('../services/userWriterTransition');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');
const { content, fingerprint } = require('../services/userMigrationRehearsal');
const runId = '4'.repeat(32), jobId = '5'.repeat(32), key = 'fs/users/synthetic';
const copy = value => value === undefined ? undefined : structuredClone(value);
function fixture() {
  const data = new Map();
  function raw(path) { if (data.has(path)) return copy(data.get(path)); const values = {};
    for (const [p, value] of data) if (p.startsWith(path + '/')) { const suffix = p.slice(path.length + 1); if (!suffix.includes('/')) values[suffix] = copy(value); }
    return Object.keys(values).length ? values : null;
  }
  const snapshot = value => ({ val: () => copy(value), forEach(callback) { for (const key of Object.keys(value || {}).sort()) callback({ key, val: () => copy(value[key]) }); } });
  const database = { ref(path) { let after, size;
    const ref = { get: async () => { let value = raw(path); if (size !== undefined) { const keys = Object.keys(value || {}).sort().filter(key => after === undefined || key > after).slice(0, size); value = keys.length ? Object.fromEntries(keys.map(key => [key, value[key]])) : null; } return snapshot(value); },
      orderByKey() { return ref; }, startAfter(value) { after = value; return ref; }, startAt(value) { after = value; return ref; }, limitToFirst(value) { size = value; return ref; },
      on(_event, fn) { queueMicrotask(() => fn(snapshot(raw(path)))); }, off() {},
      async transaction(fn) { const value = fn(raw(path)); if (value === undefined) return { committed: false, snapshot: snapshot(raw(path)) }; data.set(path, copy(value)); return { committed: true, snapshot: snapshot(value) }; },
      async remove() { for (const p of [...data.keys()]) if (p === path || p.startsWith(path + '/')) data.delete(p); },
    }; return ref;
  } };
  let state, hook;
  const journal = { read: async () => ({ exists: !!state, value: copy(state) }), update: async (_id, fn) => { state = copy(fn(copy(state)).value); return { record: { value: copy(state) } }; } };
  function store(initial = []) { const rows = new Map(initial.map(value => [value.key, value])), receipts = new Map();
    return { rows, snapshotLayout: 'a'.repeat(64), snapshot: async () => [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
      snapshotPage: async () => ({ entries: [...rows.values()], cursor: null, done: true }),
      read: async selected => copy(rows.get(selected) || { key: selected, exists: false, token: '0' }),
      commit: async () => {}, receipt: async op => receipts.get(op.id),
      async apply(id, entry, expected) { if (receipts.has(id)) return copy(receipts.get(id)); const old = rows.get(entry.key) || { key: entry.key, exists: false, token: '0' }; assert.equal(fingerprint(old), fingerprint(expected));
        const saved = { ...copy(entry), token: String(Number(old.token) + 1) }; rows.set(entry.key, saved); receipts.set(id, saved); return copy(saved); },
    };
  }
  const stores = { legacy: store([{ key, exists: true, token: '1', value: { null: null, empty: [], settings: { theme: 'dark' } } }]), rtdb: store() };
  const makePlans = () => createWriterPlanStore({ database, runId, sortOptions: { maxEntries: 2 } });
  const make = () => createUserWriterTransition({ journal, stores, plans: makePlans(), runId, checkKey: () => {}, onCheckpoint: (...args) => hook?.(...args) });
  const tool = make(); return { data, database, stores, journal, make, tool, plans: makePlans(), state: () => copy(state), set hook(value) { hook = value; } };
}
async function flip(f) { const writer = await f.tool.route(); await f.tool.copy(writer); await f.tool.drain(writer); return f.tool.activate(writer); }
async function ready() { const f = fixture(); await f.tool.initialize(); await flip(f); await flip(f); return f; }
test('정리 미리보기는 무변경이며 현행·역전환 참조와 분류되지 않은 계획을 보호한다', async () => {
  const f = await ready(), unknown = await f.plans.save([{ key: 'fs/users/unknown', exists: false, token: '0' }]); const before = JSON.stringify([...f.data]);
  const report = await f.tool.previewPlanCleanup(await f.tool.route(), { beforeEpoch: 3, limit: 32 }); assert.ok(report.selected > 0); assert.equal(JSON.stringify([...f.data]), before);
  const pinned = Object.values(f.state().frozen); await f.tool.cleanupPlans(await f.tool.route(), { id: jobId, beforeEpoch: 3, writersDrained: true });
  for (const ref of [...pinned, unknown]) await f.plans.verify(ref);
  assert.equal((await f.tool.route()).phase, 'accepting'); await flip(f); assert.equal(content(await f.stores.rtdb.read(key)), content(await f.stores.legacy.read(key)));
});
test('writer 종료 확인·진행 중 전환·잘못된 cutoff는 삭제를 시작하지 않는다', async () => {
  const f = await ready(), before = JSON.stringify([...f.data]), writer = await f.tool.route();
  await assert.rejects(f.tool.cleanupPlans(writer, { id: jobId, beforeEpoch: 3 }), { code: 'WRITER_NOT_DRAINED' });
  await assert.rejects(f.tool.cleanupPlans(writer, { id: jobId, beforeEpoch: 4, writersDrained: true })); assert.equal(JSON.stringify([...f.data]), before);
  await f.tool.copy(writer); await assert.rejects(f.tool.cleanupPlans(writer, { id: jobId, beforeEpoch: 3, writersDrained: true }), { code: 'WRITER_NOT_DRAINED' });
});
test('삭제 응답 유실은 장벽을 유지하고 같은 ID의 새 연결로 재개한다', async () => {
  const f = await ready(); let once = true;
  f.hook = async stage => { if (stage === 'planScopeRemoved' && once) { once = false; throw Error('합성 삭제 ACK 유실'); } };
  const writer = await f.tool.route(); await assert.rejects(f.tool.cleanupPlans(writer, { id: jobId, beforeEpoch: 3, writersDrained: true }), /합성 삭제 ACK 유실/);
  assert.equal((await f.tool.route()).phase, 'draining'); await assert.rejects(f.tool.copy(writer), { code: 'WRITER_PLAN_MAINTENANCE' });
  await assert.rejects(f.tool.resume(writer, { id: '9'.repeat(32), writersDrained: true }), { code: 'WRITER_PLAN_MAINTENANCE' });
  const other = f.make(), result = await other.cleanupPlans(writer, { id: jobId, beforeEpoch: 3, writersDrained: true }); assert.ok(result.removed > 0); assert.equal((await other.route()).phase, 'accepting');
  assert.deepEqual(await other.cleanupPlans(writer, { id: jobId, beforeEpoch: 3, writersDrained: true }), result);
});
test('영구 퇴역 표식은 오래된 계획 읽기·재수집과 늦게 재생성된 본문을 거부한다', async () => {
  const f = await ready(), writer = await f.tool.route(); const selected = await f.plans.cleanup.candidates({ beforeEpoch: 3, currentEpoch: 3, protectedIds: new Set(Object.values(f.state().frozen).map(ref => ref.id)), limit: 32 });
  const item = selected.items[0], manifest = createRecordStore({ database: f.database, path: `profileWriterPlans/${encodeKey(runId)}/manifests` }), ref = (await manifest.read(item.id)).value;
  const old = [...f.data].filter(([path]) => path.includes('/' + item.id + '/') || path.endsWith('/' + encodeKey(item.id)));
  await f.tool.cleanupPlans(writer, { id: jobId, beforeEpoch: 3, writersDrained: true }); for (const [path, value] of old) f.data.set(path, value);
  await assert.rejects(f.plans.verify(ref), { code: 'WRITER_PLAN_RETIRED' }); let reads = 0;
  await assert.rejects(f.plans.collect(item.id, item.context, async () => { reads++; }), { code: 'WRITER_PLAN_RETIRED' }); assert.equal(reads, 0);
});
