'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { encodeKey } = require('../services/user-storage/codec');
const { cardHash } = require('../services/user-storage/inventoryManifest');
const { createInventoryOperations } = require('../services/user-storage/inventoryOperations');

const uid = '합성/사용자.#';
const id = '1'.repeat(32);
const hashes = [cardHash('SYNTHETIC-A'), cardHash('SYNTHETIC-B')].sort();
const digest = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = { code: 'USER_STORAGE_INVALID_OPERATION' };

function journal(state = 'ready') {
  const plan = { expectedRevision: 4, generation: 1, kind: 'update', staged: {
    [hashes[0]]: 'a'.repeat(32), [hashes[1]]: 'b'.repeat(32),
  }, retired: { [hashes[0]]: 'c'.repeat(32) } };
  const value = { version: 1, plan, digest: digest(plan), state,
    ready: state !== 'prepared', cleanup: 'pending' };
  if (state === 'committed' || state === 'cancelled') value.receipt = {
    id, digest: value.digest, outcome: state, revision: 5, generation: 1,
  };
  return value;
}

// 읽기 전용 모형이다. transaction/set/remove가 없으므로 조회·검증이 쓰기를
// 시도하면 즉시 실패한다. 실제 SDK 경합은 별도 Docker 통합 검사에서 다룬다.
function readonlyStore(raw, options = {}) {
  const requested = [];
  const database = { ref(path) {
    requested.push(path);
    return { async get() { return { val: () => raw }; } };
  } };
  return { operations: createInventoryOperations({ database, ...options }), requested };
}

test('작업 조회는 안전하게 인코딩한 사용자와 작업 ID의 단일 기록만 읽는다', async () => {
  const raw = journal(), before = clone(raw);
  Object.freeze(raw.plan.staged);
  Object.freeze(raw.plan.retired);
  Object.freeze(raw.plan);
  Object.freeze(raw);
  const f = readonlyStore(raw);
  assert.deepEqual(await f.operations.read(uid, id), before);
  assert.deepEqual(f.requested, [`inventoryOperations/${encodeKey(uid)}/${id}`]);
  assert.deepEqual(raw, before, '조회와 검증이 원본 기록을 수정하면 안 된다');
});

test('누락된 작업과 형식이 손상된 작업을 구분하고 원본을 보존한다', async () => {
  for (const raw of [null, undefined]) {
    await assert.rejects(readonlyStore(raw).operations.read(uid, id), { code: 'USER_STORAGE_OPERATION_NOT_FOUND' });
  }
  for (const mutate of [
    raw => { delete raw.plan; },
    raw => { raw.version = 2; },
    raw => { raw.extra = '허용되지 않는 필드'; },
    raw => { raw.ready = 1; },
    raw => { raw.state = 'unknown'; },
    raw => { raw.cleanup = 'unknown'; },
    raw => { raw.state = 'prepared'; },
    raw => { raw.ready = false; },
  ]) {
    const raw = journal(); mutate(raw);
    const before = clone(raw), f = readonlyStore(raw);
    await assert.rejects(f.operations.read(uid, id), invalid);
    assert.deepEqual(raw, before);
    assert.equal(f.requested.length, 1);
  }
});

test('확정 작업에는 실제 객체 영수증이 있어야 하며 빈 값은 영수증으로 인정하지 않는다', async () => {
  for (const state of ['committed', 'cancelled']) {
    const missing = journal(state); delete missing.receipt;
    await assert.rejects(readonlyStore(missing).operations.read(uid, id), invalid);
    for (const receipt of [null, false, 0, '', [], {}]) {
      const raw = journal(state); raw.receipt = receipt;
      await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
    }
  }
});

test('영수증의 작업 ID·계획·결과·revision·generation 불일치를 거부한다', async () => {
  for (const mutate of [
    r => { r.id = '2'.repeat(32); },
    r => { r.digest = '0'.repeat(64); },
    r => { r.outcome = 'cancelled'; },
    r => { r.revision = 4; },
    r => { r.revision = 6; },
    r => { r.generation = 0; },
    r => { r.generation = 2; },
    r => { r.extra = true; },
  ]) {
    const raw = journal('committed'); mutate(raw.receipt);
    await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
  }
  const raw = journal('ready'); raw.receipt = journal('committed').receipt;
  await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
});

test('확정 결과 대조는 같은 영수증만 허용하고 기존 확정 결과를 다른 결과로 바꾸지 않는다', async () => {
  for (const state of ['committed', 'cancelled']) {
    const raw = journal(state), f = readonlyStore(raw);
    const operation = await f.operations.read(uid, id);
    const reordered = Object.fromEntries(Object.entries(operation.receipt).reverse());
    assert.deepEqual(f.operations.confirmed(uid, id, operation, reordered), operation);
    for (const patch of [
      { outcome: state === 'committed' ? 'cancelled' : 'committed' },
      { id: '2'.repeat(32) }, { digest: '0'.repeat(64) }, { revision: 6 }, { generation: 2 },
    ]) assert.throws(() => f.operations.confirmed(uid, id, operation, { ...operation.receipt, ...patch }), invalid);
    assert.equal(f.requested.length, 1, '메모리에 있는 영수증 대조는 추가 DB 접근을 하지 않는다');
    assert.deepEqual(raw, journal(state));
  }
});

test('폐쇄 표식이 필요한 취소를 완전 삭제로 표시하거나 불가능한 fenced 상태를 허용하지 않는다', async () => {
  const cases = [];
  const complete = journal('cancelled'); complete.ready = false; complete.cleanup = 'complete'; cases.push(complete);
  const ready = journal('cancelled'); ready.cleanup = 'fenced'; cases.push(ready);
  const committed = journal('committed'); committed.cleanup = 'fenced'; cases.push(committed);
  const pending = journal('prepared'); pending.cleanup = 'fenced'; cases.push(pending);
  const noStage = journal('cancelled');
  noStage.ready = false; noStage.cleanup = 'fenced'; delete noStage.plan.staged;
  noStage.digest = digest(noStage.plan); noStage.receipt.digest = noStage.digest; cases.push(noStage);
  for (const raw of cases) await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);

  const fenced = journal('cancelled'); fenced.ready = false; fenced.cleanup = 'fenced';
  assert.deepEqual(await readonlyStore(fenced).operations.read(uid, id), fenced);
  const cleaned = journal('cancelled'); cleaned.cleanup = 'complete';
  assert.deepEqual(await readonlyStore(cleaned).operations.read(uid, id), cleaned);
});

test('계획 해시는 RTDB 객체 필드 순서와 무관하며 계획 내용이 바뀌면 기존 해시를 거부한다', async () => {
  const original = journal(), reordered = clone(original);
  reordered.plan.staged = Object.fromEntries(Object.entries(reordered.plan.staged).reverse());
  reordered.plan = Object.fromEntries(Object.entries(reordered.plan).reverse());
  assert.deepEqual(await readonlyStore(reordered).operations.read(uid, id), original);
  for (const mutate of [
    raw => { raw.plan.expectedRevision = 5; },
    raw => { raw.plan.staged[hashes[0]] = 'd'.repeat(32); },
    raw => { raw.digest = '0'.repeat(64); },
  ]) {
    const raw = journal(); mutate(raw);
    await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
  }
});

test('작업 계획의 잘못된 세대·업무 종류·빈 후보·중복 주소를 거부한다', async () => {
  for (const mutate of [
    p => { p.expectedRevision = -1; }, p => { p.expectedRevision = 1.5; },
    p => { p.generation = 5; }, p => { p.generation = -1; },
    p => { p.kind = 'unknown'; }, p => { p.kind = 'clear'; },
    p => { p.staged = {}; }, p => { p.retired = []; },
    p => { p.staged[hashes[0]] = 'short'; },
    p => { p.retired[hashes[0]] = p.staged[hashes[0]]; },
    p => { p.extra = true; },
  ]) {
    const raw = journal(); mutate(raw.plan); raw.digest = digest(raw.plan);
    await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
  }
});

test('초기화 영수증은 실제 초기화의 generation 증가와 일치해야 한다', async () => {
  const raw = journal('committed'); raw.plan.kind = 'clear'; delete raw.plan.staged;
  raw.digest = digest(raw.plan); raw.receipt.digest = raw.digest; raw.receipt.generation = 2;
  assert.deepEqual(await readonlyStore(raw).operations.read(uid, id), raw);
  raw.receipt.generation = 1;
  await assert.rejects(readonlyStore(raw).operations.read(uid, id), invalid);
});

test('잘못된 작업 ID·사용자 키·제어 경로는 DB 접근 전에 거부한다', async () => {
  const f = readonlyStore(journal());
  for (const badId of [null, '', 'A'.repeat(32), '1'.repeat(31), '1'.repeat(33), '../operation']) {
    await assert.rejects(f.operations.read(uid, badId), invalid);
  }
  await assert.rejects(f.operations.read(null, id), { code: 'user-storage/invalid-key' });
  await assert.rejects(f.operations.read('\ud800', id), { code: 'user-storage/invalid-key' });
  assert.equal(f.requested.length, 0);
  for (const path of ['', '/', 'unsafe.#', 'operations//nested', 'operations/', Array(33).fill('a').join('/')]) {
    assert.throws(() => readonlyStore(journal(), { path }), { code: 'USER_STORAGE_INVALID_PATH' });
  }
  const longPath = readonlyStore(journal(), { path: 'p'.repeat(750) });
  await assert.rejects(longPath.operations.read(uid, id), { code: 'USER_STORAGE_INVALID_PATH' });
  assert.equal(longPath.requested.length, 0);
});

test('계획에 경로를 탈출하는 카드 해시가 있으면 읽기 뒤에도 저장 동작 없이 거부한다', async () => {
  for (const hash of ['../other', 'h' + 'A'.repeat(42), 'h' + 'A'.repeat(42) + 'B']) {
    const raw = journal(); raw.plan.staged = { [hash]: 'a'.repeat(32) }; raw.digest = digest(raw.plan);
    const f = readonlyStore(raw);
    await assert.rejects(f.operations.read(uid, id), { code: 'user-storage/invalid-inventory-format' });
    assert.equal(f.requested.length, 1);
  }
});
