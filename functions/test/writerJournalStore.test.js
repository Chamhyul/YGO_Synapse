'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { encodeValue, encodeKey } = require('../services/user-storage/codec');
const { createWriterJournalStore, projection, encodeJournalRecord } = require('../services/user-storage/writerJournalStore');
const { fingerprint } = require('../services/userMigrationRehearsal');
const id = 'a'.repeat(32), path = `synthetic/${encodeKey(id)}`;
const state = () => ({ format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
  operations: { pending: { body: 'x'.repeat(100000) } }, events: [], frozen: {} });
function fixture(value = state(), legacy = false, createStore = createWriterJournalStore) {
  const record = { format: 1, revision: 1, generation: 0, tombstone: false,
    payload: legacy ? encodeValue(value) : { version: 2, value: encodeValue(value).value, control: projection(value, 1, id) } };
  let raw = legacy ? record : encodeJournalRecord(record, id, path);
  const reads = []; let hook;
  const database = { ref: key => ({ get: async () => {
    reads.push(key); const parts = key === path ? [] : key.slice(path.length + 1).split('/');
    let v = raw; for (const part of parts) v = v?.[part]; const saved = structuredClone(v ?? null);
    hook?.(key); return { val: () => saved };
  } }) };
  const store = createStore({ database, path: 'synthetic' });
  return { store, reads, get raw() { return raw; }, set raw(v) { raw = v; }, set hook(v) { hook = v; } };
}
test('빠른 상태 조회는 통합 헤더 GET1회로 읽고 원문 전체 읽기는 같은 값을 반환한다', async () => {
  const f = fixture(), route = await f.store.readRoute(id);
  assert.equal(route.value.backend, 'legacy'); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads, [`${path}/head`]);
  assert.deepEqual((await f.store.read(id)).value, state());
});
test('기존 범용 기록은 전체 reader로 대조하고 원문을 수정하지 않는다', async () => {
  const f = fixture(state(), true), before = structuredClone(f.raw);
  assert.equal((await f.store.readRoute(id)).value.phase, 'accepting');
  assert.ok(f.reads.includes(path)); assert.deepEqual(f.raw, before);
});
test('CAS가 조회 도중 교체돼도 단일 헤더 snapshot의 backend/epoch/접수 상태는 섞이지 않는다', async () => {
  const f = fixture(); let once = false;
  f.hook = key => { if (!once && key.endsWith('/head')) {
    once = true; const s = { ...state(), backend: 'rtdb', epoch: 2, phase: 'draining' };
    f.raw = encodeJournalRecord({ format: 1, revision: 2, generation: 0, tombstone: false,
      payload: { version: 2, value: encodeValue(s).value, control: projection(s, 2, id) } }, id, path);
  } };
  const before = await f.store.readRoute(id); assert.equal(before.revision, 1);
  assert.equal(before.value.backend, 'legacy'); assert.equal(before.value.epoch, 1);
  const after = await f.store.readRoute(id); assert.equal(after.revision, 2);
  assert.equal(after.value.backend, 'rtdb'); assert.equal(after.value.epoch, 2); assert.equal(after.value.phase, 'draining');
  assert.equal(f.reads.length, 2);
});
test('손상 헤더·지문·주소·세대·원문 불일치는 거부하고 누락 헤더로 새 기록을 숨기지 않는다', async () => {
  for (const mutate of [r => { r.head.format = 9; }, r => { r.head.generation = -1; }, r => { r.head.digest = '0'.repeat(64); },
    r => { r.head.epoch = 0; }, r => { r.head.revision = 2; }, r => { r.head.key = encodeKey('other'); }, r => { delete r.head; }]) {
    const f = fixture(); mutate(f.raw); await assert.rejects(f.store.readRoute(id), { code: 'WRITER_STATE_INVALID' });
  }
  const f = fixture(), s = { ...state(), backend: 'rtdb' };
  f.raw.body = encodeValue(s); await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
  assert.equal(projection({ ...state(), historyVersion: 0 }, 1, id).requiresHistory, true);
  assert.equal(projection({ ...state(), frozen: { rtdb: { format: 1 } } }, 1, id).requiresPlans, true);
});
test('구형 version2의 전체 대조와 tombstone의 세대/부재 의미를 유지한다', async () => {
  const f = fixture(); f.raw = { format: 1, revision: 2, generation: 0, tombstone: false,
    payload: { version: 2, value: encodeValue(state()).value, control: projection(state(), 2, id) } };
  const before = structuredClone(f.raw);
  assert.equal((await f.store.readRoute(id)).revision, 2); assert.deepEqual(f.raw, before); assert.equal(f.reads.length, 2);
  f.raw.payload.control.revision = 1; await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
  f.raw = encodeJournalRecord({ format: 1, revision: 3, generation: 1, tombstone: true }, id, path); f.reads.length = 0;
  assert.deepEqual(await f.store.readRoute(id), { exists: false, revision: 3, generation: 1 }); assert.equal(f.reads.length, 1);
  assert.deepEqual(await f.store.read(id), { exists: false, value: undefined, revision: 3, generation: 1 });
});

test('지문을 다시 만든 잘못된 제어 필드는 빠른 조회와 전체 조회 모두 거부한다', async () => {
  for (const fields of [{ backend: 'other' }, { epoch: 0 }, { phase: 'other' },
    { requiresPlans: 1 }, { requiresHistory: 'false' }]) {
    const f = fixture(); Object.assign(f.raw.head, fields);
    const { digest, ...body } = f.raw.head; f.raw.head.digest = fingerprint(body);
    await assert.rejects(f.store.readRoute(id), { code: 'WRITER_STATE_INVALID' });
    await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
  }
});
test('동일 SDK 객체의 다음 조회에서도 헤더/본문을 검증하고 반환값 변경을 재사용하지 않는다', async () => {
  const f = fixture(), saved = structuredClone(f.raw);
  const route = await f.store.readRoute(id); route.value.backend = 'rtdb'; route.value.digest = '0'.repeat(64);
  assert.deepEqual((await f.store.readRoute(id)).value, projection(state(), 1, id));
  await f.store.read(id);
  f.raw.head.digest = '0'.repeat(64);
  await assert.rejects(f.store.readRoute(id), { code: 'WRITER_STATE_INVALID' });
  f.raw = saved; f.raw.body = encodeValue({ ...state(), epoch: 2 });
  await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
});
test('유효한 제어 지문도 본문에서 계산한 의존성·주소·버전과 다르면 거부한다', async () => {
  for (const fields of [{ requiresPlans: true }, { requiresHistory: true }, { epoch: 2 }]) {
    const f = fixture(); Object.assign(f.raw.head, fields);
    const { digest, ...body } = f.raw.head; f.raw.head.digest = fingerprint(body);
    await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
  }
  for (const fields of [{ requiresHistory: true }, { key: encodeKey('other') }, { revision: 2 }]) {
    const f = fixture(); const control = { ...projection(state(), 1, id), ...fields };
    const { digest, ...body } = control; control.digest = fingerprint(body);
    f.raw = { format: 1, revision: 1, generation: 0, tombstone: false,
      payload: { version: 2, value: encodeValue(state()).value, control } };
    await assert.rejects(f.store.read(id), { code: 'WRITER_STATE_INVALID' });
  }
});
test('같은 조회의 해시 계산은 줄이고 다음 조회에는 다시 수행한다', async () => {
  const filename = require.resolve('../services/user-storage/writerJournalStore');
  const load = require('node:module').createRequire(filename); let hashes = 0;
  const counted = new (require('node:module').Module)(filename);
  counted.require = name => name === '../userMigrationRehearsal'
    ? { fingerprint: value => { hashes++; return fingerprint(value); } } : load(name);
  counted._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  const f = fixture(state(), false, counted.exports.createWriterJournalStore);
  for (let n = 0; n < 2; n++) {
    hashes = 0; await f.store.readRoute(id); assert.equal(hashes, 2);
    hashes = 0; await f.store.read(id); assert.equal(hashes, 4);
  }
  f.raw = { format: 1, revision: 1, generation: 0, tombstone: false,
    payload: { version: 2, value: encodeValue(state()).value, control: projection(state(), 1, id) } };
  hashes = 0; await f.store.read(id); assert.equal(hashes, 2);
});
