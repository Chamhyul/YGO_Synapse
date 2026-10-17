'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createWriterJournalStore, projection } = require('../services/user-storage/writerJournalStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const { metered } = require('../../integration/user-migration/measure-retention.cjs');
const { fingerprint } = require('../services/userMigrationRehearsal');
const id = () => randomBytes(16).toString('hex');
const state = () => ({ format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
  operations: { synthetic: { body: 'x'.repeat(150000) } }, events: [], frozen: {} });
test('native 제어 요약은 원문과 같은 CAS에 확정되고 조회는 본문 없이 같은 버전을 반환한다', async () => {
  const run = id(), c = open(run), paths = [], meter = metered({ ref: path => { paths.push(path); return c.targetDatabase.ref(path); } });
  const store = createWriterJournalStore({ database: meter.database, path: 'routeJournal' });
  try {
    await store.compareAndSet(run, 0, state());
    const full = await store.read(run); meter.reset(); paths.length = 0;
    const route = await store.readRoute(run);
    assert.equal(route.revision, full.revision); assert.equal(route.value.backend, full.value.backend);
    assert.equal(meter.stats.gets, 1); assert.ok(meter.stats.getPayloadBytes < 1000);
    assert.deepEqual(paths, [`routeJournal/${encodeKey(run)}/head`]);
    await store.update(run, s => ({ value: { ...s, backend: 'rtdb', epoch: 2, phase: 'draining' } }));
    const other = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
    const next = await other.readRoute(run); assert.equal(next.value.epoch, 2); assert.equal(next.value.phase, 'draining');
    assert.equal((await other.read(run)).value.operations.synthetic.body.length, 150000);
  } finally { await c.close(); }
});
test('기존 범용 원문은 읽기만으로 바꾸지 않으며 다음 승인 CAS에서 같은 내용과 제어를 공개한다', async () => {
  const run = id(), c = open(run), legacy = createRecordStore({ database: c.targetDatabase, path: 'routeJournal' }), store = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
  try {
    await legacy.compareAndSet(run, 0, state()); const ref = c.targetDatabase.ref(`routeJournal/${encodeKey(run)}`), before = (await ref.get()).val();
    assert.equal((await store.readRoute(run)).value.epoch, 1); assert.deepEqual((await ref.get()).val(), before);
    await store.update(run, value => ({ value })); assert.equal((await ref.get()).val().head.format, 3);
    assert.deepEqual((await store.read(run)).value, state());
    await assert.rejects(legacy.read(run));
  } finally { await c.close(); }
});
test('CAS 응답 유실·복수 SDK 재개 및 제어/원문 불일치는 성공이나 새 epoch로 숨기지 않는다', async () => {
  const run = id(), c = open(run); let lost = false;
  const database = { ref: path => {
    const ref = c.targetDatabase.ref(path); return new Proxy(ref, { get(target, key) {
      if (key === 'transaction') return async (...args) => { const result = await target.transaction(...args); if (!lost && result.committed) { lost = true; throw Error('synthetic ack loss'); } return result; };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  try {
    const failed = createWriterJournalStore({ database, path: 'routeJournal' }); await assert.rejects(failed.compareAndSet(run, 0, state()));
    const store = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
    assert.equal((await store.readRoute(run)).value.epoch, 1); assert.deepEqual((await store.read(run)).value, state());
    await store.update(run, value => ({ value: { ...value, epoch: 2 } }));
    const ref = c.targetDatabase.ref(`routeJournal/${encodeKey(run)}`), before = (await ref.get()).val();
    await ref.child('head/epoch').set(3); await assert.rejects(store.readRoute(run), { code: 'WRITER_STATE_INVALID' });
    await ref.set(before); await ref.child('head/revision').set(99); await assert.rejects(store.readRoute(run), { code: 'WRITER_STATE_INVALID' });
    await ref.set(before); assert.equal((await store.readRoute(run)).value.epoch, 2);
  } finally { await c.close(); }
});

test('구형 version2는 새 SDK에서 무변경으로 읽고 다음 CAS에서 통합 헤더로 전환된다', async () => {
  const run = id(), c = open(run), store = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
  try {
    const ref = c.targetDatabase.ref(`routeJournal/${encodeKey(run)}`);
    const before = { format: 1, revision: 4, generation: 0, tombstone: false,
      payload: { version: 2, value: encodeValue(state()).value, control: projection(state(), 4, run) } };
    await ref.set(before); assert.equal((await store.readRoute(run)).revision, 4); assert.deepEqual((await ref.get()).val(), before);
    await store.update(run, value => ({ value: { ...value, epoch: 2 } }));
    const raw = (await ref.get()).val(); assert.deepEqual(Object.keys(raw).sort(), ['body', 'head']);
    assert.equal(raw.head.revision, 5); assert.equal(raw.head.epoch, 2); assert.equal(raw.body.version, 1);
    assert.deepEqual((await store.read(run)).value, { ...state(), epoch: 2 });
    const saved = structuredClone(raw); await ref.child('body').remove();
    await assert.rejects(store.read(run), { code: 'WRITER_STATE_INVALID' });
    await assert.rejects(store.update(run, value => ({ value })), { code: 'WRITER_STATE_INVALID' });
    await ref.set(saved); await ref.child('head').remove();
    await assert.rejects(store.readRoute(run), { code: 'WRITER_STATE_INVALID' });
  } finally { await c.close(); }
});

test('두 SDK의 같은 revision CAS 중 하나만 확정되며 헤더와 본문을 함께 대조한다', async () => {
  const run = id(), a = open(run), b = open(run);
  const first = createWriterJournalStore({ database: a.targetDatabase, path: 'routeJournal' });
  const second = createWriterJournalStore({ database: b.targetDatabase, path: 'routeJournal' });
  try {
    await first.compareAndSet(run, 0, state());
    const outcomes = await Promise.allSettled([
      first.compareAndSet(run, 1, { ...state(), epoch: 2 }),
      second.compareAndSet(run, 1, { ...state(), epoch: 3 }),
    ]);
    assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(v => v.status === 'rejected').reason.code, 'USER_STORAGE_CONFLICT');
    const full = await second.read(run), head = await first.readRoute(run);
    assert.equal(full.revision, 2); assert.equal(head.revision, full.revision); assert.equal(head.value.epoch, full.value.epoch);
    const ref = b.targetDatabase.ref(`routeJournal/${encodeKey(run)}`), saved = (await ref.get()).val();
    await ref.child('body').set(encodeValue({ ...full.value, epoch: 7 }));
    await assert.rejects(second.compareAndSet(run, 2, state()), { code: 'WRITER_STATE_INVALID' });
    assert.equal((await ref.get()).val().head.revision, 2); await ref.set(saved);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('검증 결과 재사용은 후속 조회의 손상이나 지문이 맞는 제어/본문 불일치를 숨기지 않는다', async () => {
  const run = id(), c = open(run), store = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
  try {
    await store.compareAndSet(run, 0, state());
    const ref = c.targetDatabase.ref(`routeJournal/${encodeKey(run)}`), saved = (await ref.get()).val();
    const first = await store.readRoute(run); first.value.backend = 'rtdb';
    assert.equal((await store.readRoute(run)).value.backend, 'legacy');
    for (const fields of [{ backend: 'other' }, { requiresHistory: 'false' }, { epoch: 2 }, { requiresPlans: true }]) {
      const raw = structuredClone(saved); Object.assign(raw.head, fields);
      const { digest, ...body } = raw.head; raw.head.digest = fingerprint(body); await ref.set(raw);
      if (fields.backend || typeof fields.requiresHistory === 'string') {
        await assert.rejects(store.readRoute(run), { code: 'WRITER_STATE_INVALID' });
      }
      await assert.rejects(store.read(run), { code: 'WRITER_STATE_INVALID' });
      await assert.rejects(store.compareAndSet(run, 1, state()), { code: 'WRITER_STATE_INVALID' });
      assert.deepEqual((await ref.get()).val(), raw);
    }
    await ref.set(saved);
    const resumed = createWriterJournalStore({ database: c.targetDatabase, path: 'routeJournal' });
    assert.deepEqual((await resumed.read(run)).value, state());
    await resumed.compareAndSet(run, 1, { ...state(), epoch: 2 });
    assert.equal((await store.readRoute(run)).value.epoch, 2);
  } finally { await c.close(); }
});
