'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUserStorageConnection } = require('../config/userStorage');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { encodeKey } = require('../services/user-storage/codec');

// 자격 증명이 없는 전용 demo RTDB에서 실제 저장·승인 경계만 지연시킨다.
// 운영 Firebase 모듈, 사용자 계정 또는 기존 개발 서버에는 접근하지 않는다.
const connections = [];
function open() {
  const connection = createUserStorageConnection();
  connections.push(connection);
  return connection;
}
const main = open();
after(async () => { await Promise.all(connections.map(connection => connection.close())); });

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const headPath = uid => `inventories/${encodeKey(uid)}`;
const versionsPath = uid => `inventoryCardVersions/${encodeKey(uid)}`;
const operationsPath = uid => `inventoryOperations/${encodeKey(uid)}`;
const operationPath = (uid, id) => `${operationsPath(uid)}/${id}`;
const cardHash = number => `h${createHash('sha256').update(JSON.stringify(number)).digest('base64url')}`;
const raw = async path => (await main.database.ref(path).get()).val();
const rawHead = uid => raw(headPath(uid));
const versionPath = (uid, head, number) => {
  const hash = cardHash(number);
  return `${versionsPath(uid)}/${hash}/${head.payload.cards[hash].v}`;
};
const store = (database = main.database, options = {}) => createPartitionedInventoryStore({
  database, now: () => '합성 회복 검증 시각', ...options,
});
const card = (qty = 1) => ({
  name: '합성 카드', cid: '1', items: [{ rarity: 'N', qty, loc: '합성 위치', illustration: '1' }],
});
function summarize(value) {
  value.amount = 0;
  value.locations = {};
  value.rarities = {};
  for (const [number, entry] of Object.entries(value.cards || {})) {
    for (const item of entry.items || []) {
      value.amount += item.qty;
      value.rarities[item.rarity] = (value.rarities[item.rarity] || 0) + item.qty;
      if (!value.locations[item.loc]) value.locations[item.loc] = [];
      if (!value.locations[item.loc].includes(number)) value.locations[item.loc].push(number);
    }
  }
}
async function seed(uid) {
  return store().update(uid, value => { value.cards = { A: card(), B: card() }; summarize(value); });
}

function instrument(database, hook = (_event, invoke) => invoke()) {
  const events = [];
  const wrap = (ref, path) => new Proxy(ref, {
    get(target, key) {
      if (key === 'child') return child => wrap(target.child(child), [path, child].filter(Boolean).join('/'));
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['get', 'once', 'on', 'off', 'set', 'update', 'remove', 'transaction'].includes(key)) return value.bind(target);
      return (...args) => {
        const event = { method: key, path, args };
        events.push(event);
        return hook(event, () => value.apply(target, args));
      };
    },
  });
  return { events, database: new Proxy(database, {
    get(target, key) {
      if (key === 'ref') return (path = '') => wrap(target.ref(path), path.replace(/^\/|\/$/g, ''));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}
const writes = events => events.filter(event => ['set', 'update', 'remove', 'transaction'].includes(event.method));
const isStage = (event, uid) => event.path.startsWith(`${versionsPath(uid)}/`)
  && event.method === 'transaction';
const isDelete = (event, uid) => event.path.startsWith(`${versionsPath(uid)}/`)
  && (event.method === 'remove' || (event.method === 'set' && event.args[0] === null));
async function expectAmbiguous(pending) {
  try { await pending; assert.fail('승인 결과가 불명확한 저장을 성공으로 반환하면 안 된다'); }
  catch (error) {
    assert.equal(error.code, 'USER_STORAGE_WRITE_AMBIGUOUS');
    assert.match(error.operationId, /^[a-f0-9]{32}$/);
    return error;
  }
}

test('전체·선택·API 수정과 초기화는 저장 결과를 대조할 요청 ID와 확정 증거를 남긴다', { timeout: 30000 }, async () => {
  const uid = 'recovery-operation-contract-synthetic', instance = store();
  const saved = await seed(uid);
  const outcomes = [saved];
  outcomes.push(await instance.updateCards(uid, ['B'], cards => { cards.B.items[0].qty += 3; }));
  // low-level 부분 수정이 무효화한 API 집계는 전체 호환 경로에서 다시 만든다.
  outcomes.push(await instance.update(uid, value => { summarize(value); }));
  outcomes.push(await instance.updateApiCards(uid, ['A'], inventory => {
    inventory.cards.A.items[0].qty += 2;
    inventory.amount += 2;
    inventory.rarities.N += 2;
  }));
  outcomes.push(await instance.clear(uid));
  assert.equal(new Set(outcomes.map(outcome => outcome.operationId)).size, outcomes.length);
  for (const outcome of outcomes) {
    assert.match(outcome.operationId, /^[a-f0-9]{32}$/);
    const inspected = await instance.inspectOperation(uid, outcome.operationId);
    assert.equal(inspected.operationId, outcome.operationId);
    assert.equal(inspected.status, 'committed');
    assert.equal(inspected.cleanup, 'complete');
    const journal = await raw(operationPath(uid, outcome.operationId));
    assert.equal(journal.version, 1);
    assert.equal(journal.state, 'committed');
    assert.equal(journal.receipt.id, outcome.operationId);
    assert.equal(journal.receipt.outcome, 'committed');
    assert.equal(journal.receipt.digest, journal.digest);
  }
  assert.equal((await instance.read(uid)).exists, false);
});

test('head 승인 응답 유실 뒤 다른 수정·초기화를 거쳐도 원래 성공을 읽기만으로 대조한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-ack-followup-clear-synthetic';
  await seed(uid);
  let committed = false, mutatorCalls = 0;
  const tracked = instrument(open().database, (event, invoke) => {
    if (event.path === headPath(uid) && event.method === 'transaction') {
      return invoke().then(result => {
        if (!result.committed) return result;
        committed = true;
        return new Promise(() => {});
      });
    }
    return invoke();
  });
  const unknown = await expectAmbiguous(store(tracked.database, { timeoutMs: 700 }).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1;
    cards.A.items[0].qty += 4;
  }));
  assert.equal(committed, true);
  assert.equal(mutatorCalls, 1, '승인 불명확 요청의 업무 함수를 자동 재실행하지 않는다');
  const currentReceiptObserver = instrument(open().database);
  const currentReceipt = await store(currentReceiptObserver.database).inspectOperation(uid, unknown.operationId);
  assert.equal(currentReceipt.status, 'committed');
  assert.equal(writes(currentReceiptObserver.events).length, 0, '아직 현재 head에 있는 성공 증거도 쓰기 없이 대조한다');
  assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 5);
  const followup = store(open().database);
  await followup.updateCards(uid, ['B'], cards => { cards.B.items[0].qty += 2; });
  assert.equal((await followup.read(uid)).value.cards.A.items[0].qty, 5);
  await followup.clear(uid);
  const before = await rawHead(uid), observed = instrument(open().database);
  const inspected = await store(observed.database).inspectOperation(uid, unknown.operationId);
  assert.equal(inspected.status, 'committed');
  assert.equal(inspected.operationId, unknown.operationId);
  assert.equal(writes(observed.events).length, 0, '결과 조회 자체가 회복 또는 업무 쓰기를 실행하면 안 된다');
  assert.deepEqual(await rawHead(uid), before);
  assert.equal((await raw(operationPath(uid, unknown.operationId))).receipt.outcome, 'committed');
  const recovered = await followup.recoverOperation(uid, unknown.operationId);
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.cleanup, 'complete');
  assert.equal((await followup.read(uid)).exists, false);
  assert.deepEqual(await rawHead(uid), before, '성공 대조 뒤 정리는 과거 내용을 되살리지 않는다');
});

test('지연된 카드 제출은 기본 회복으로 보존하고 명시적 취소의 닫힘 표시가 늦은 쓰기를 막는다', { timeout: 30000 }, async () => {
  const uid = 'recovery-stage-delayed-synthetic';
  await seed(uid);
  const before = await rawHead(uid), entered = deferred(), resume = deferred(), late = deferred();
  let stagePath, mutatorCalls = 0;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (!stagePath && isStage(event, uid)) {
      stagePath = event.path;
      entered.resolve();
      await resume.promise;
      const result = await invoke();
      late.resolve(result);
      return result;
    }
    return invoke();
  });
  const pending = expectAmbiguous(store(tracked.database, { timeoutMs: 700 }).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 9;
  }));
  await entered.promise;
  try {
    const error = await pending;
    const recovery = store(open().database);
    const inspected = await recovery.inspectOperation(uid, error.operationId);
    assert.equal(inspected.status, 'prepared');
    assert.equal(inspected.cleanup, 'pending');
    const journalBefore = await raw(operationPath(uid, error.operationId));
    const observed = instrument(open().database);
    const unchanged = await store(observed.database).recoverOperation(uid, error.operationId);
    assert.equal(unchanged.status, 'prepared');
    assert.equal(writes(observed.events).length, 0, '명시적 취소가 없는 미확정 요청은 경로를 변경하지 않는다');
    assert.deepEqual(await raw(operationPath(uid, error.operationId)), journalBefore);
    assert.deepEqual(await rawHead(uid), before);
    assert.equal(await raw(stagePath), null, '아직 제출되지 않은 카드 경로를 재구성하지 않는다');
    const cancelled = await recovery.recoverOperation(uid, error.operationId, { cancelPending: true });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleanup, 'fenced');
    const marker = { type: 'inventory-stage-closed', version: 1, operationId: error.operationId };
    assert.deepEqual(await raw(stagePath), marker);
    resume.resolve();
    assert.equal((await late.promise).committed, false, '취소 뒤 늦게 도착한 create-only 제출은 저장되면 안 된다');
    assert.deepEqual(await raw(stagePath), marker, '닫힘 표시는 늦은 제출 뒤에도 영구 보존한다');
    assert.equal((await recovery.inspectOperation(uid, error.operationId)).status, 'cancelled');
    const readBack = await recovery.read(uid);
    assert.equal(readBack.value.cards.A.items[0].qty, 1);
    assert.equal(readBack.generation, 0);
    assert.equal(mutatorCalls, 1);
    assert.equal(tracked.events.some(event => event.path === headPath(uid) && event.method === 'transaction'), false);
  } finally { resume.resolve(); }
});

test('준비를 마친 head 제출 지연도 취소 fence 뒤 실패하고 업무 수정은 재시도하지 않는다', { timeout: 30000 }, async () => {
  const uid = 'recovery-head-delayed-synthetic';
  await seed(uid);
  const before = await rawHead(uid), entered = deferred(), resume = deferred(), late = deferred();
  let blocked = false, mutatorCalls = 0;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (!blocked && event.path === headPath(uid) && event.method === 'transaction') {
      blocked = true; entered.resolve(); await resume.promise;
      const result = await invoke(); late.resolve(result); return result;
    }
    return invoke();
  });
  const pending = expectAmbiguous(store(tracked.database, { timeoutMs: 700 }).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 8;
  }));
  await entered.promise;
  try {
    const error = await pending, recovery = store(open().database);
    assert.equal((await recovery.inspectOperation(uid, error.operationId)).status, 'ready');
    const staged = tracked.events.filter(event => isStage(event, uid)).map(event => event.path);
    assert.ok(staged.length > 0);
    for (const path of staged) assert.notEqual(await raw(path), null);
    const cancelled = await recovery.recoverOperation(uid, error.operationId, { cancelPending: true });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleanup, 'complete');
    for (const path of staged) assert.equal(await raw(path), null, '승인된 제출은 취소 뒤 안전하게 정리한다');
    const fenced = await rawHead(uid);
    assert.equal(fenced.revision, before.revision + 1);
    assert.equal(fenced.generation, before.generation);
    assert.deepEqual(fenced.payload, before.payload);
    resume.resolve();
    assert.equal((await late.promise).committed, false);
    assert.deepEqual(await rawHead(uid), fenced);
    assert.equal(mutatorCalls, 1);
    assert.equal((await recovery.read(uid)).value.cards.A.items[0].qty, 1);
  } finally { resume.resolve(); }
});

test('아직 실행 중인 카드 제출의 명시적 취소도 늦은 업무 재시도를 차단한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-active-stage-cancel-synthetic';
  const seedResult = await seed(uid), before = await rawHead(uid), entered = deferred(), resume = deferred();
  let stagedPath, mutatorCalls = 0;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (!stagedPath && isStage(event, uid)) {
      stagedPath = event.path; entered.resolve(); await resume.promise;
    }
    return invoke();
  });
  const pending = store(tracked.database, { timeoutMs: 15000 }).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 20;
  }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try {
    const operations = await raw(operationsPath(uid));
    const ids = Object.keys(operations).filter(id => id !== seedResult.operationId);
    assert.equal(ids.length, 1);
    const operationId = ids[0];
    const recovered = await Promise.all([store(open().database), store(open().database)]
      .map(instance => instance.recoverOperation(uid, operationId, { cancelPending: true })));
    for (const result of recovered) {
      assert.equal(result.status, 'cancelled');
      assert.equal(result.cleanup, 'fenced');
    }
    resume.resolve();
    const result = await pending;
    assert.ok(result.error, '취소된 업무 요청을 새 시도로 자동 저장하면 안 된다');
    assert.equal(result.error.operationId, operationId);
    assert.equal(mutatorCalls, 1);
    const current = await rawHead(uid);
    assert.equal(current.revision, before.revision + 1, '같은 요청의 동시 취소는 한 번만 fence를 기록한다');
    assert.equal(current.generation, before.generation);
    assert.deepEqual(current.payload, before.payload);
    assert.deepEqual(await raw(stagedPath), { type: 'inventory-stage-closed', version: 1, operationId });
    assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 1);
  } finally { resume.resolve(); }
});

test('정리 실패는 확정 저장을 유지하고 동시 회복도 해당 요청의 퇴역 버전만 멱등 정리한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-cleanup-idempotent-synthetic';
  await seed(uid);
  const before = await rawHead(uid), retiredPath = versionPath(uid, before, 'A');
  const tracked = instrument(open().database, (event, invoke) => {
    if (isDelete(event, uid)) return Promise.reject(Object.assign(new Error('합성 정리 실패'), { code: 'SYNTHETIC_CLEANUP_FAILURE' }));
    return invoke();
  });
  let mutatorCalls = 0;
  const outcome = await store(tracked.database).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 6;
  });
  assert.equal(outcome.cleanupPending, true);
  assert.equal((await store().inspectOperation(uid, outcome.operationId)).status, 'committed');
  assert.equal((await store().inspectOperation(uid, outcome.operationId)).cleanup, 'pending');
  const committed = await rawHead(uid), currentPath = versionPath(uid, committed, 'A');
  const currentValue = await raw(currentPath), unrelatedPath = `${versionsPath(uid)}/${cardHash('UNKNOWN')}/${'a'.repeat(32)}`;
  await main.database.ref(unrelatedPath).set({ synthetic: '어떤 기록에도 없는 보존 대상' });
  const results = await Promise.all([store(open().database), store(open().database)]
    .map(instance => instance.recoverOperation(uid, outcome.operationId)));
  for (const result of results) {
    assert.equal(result.status, 'committed');
    assert.equal(result.cleanup, 'complete');
  }
  assert.equal(await raw(retiredPath), null);
  assert.deepEqual(await raw(currentPath), currentValue);
  assert.deepEqual(await raw(unrelatedPath), { synthetic: '어떤 기록에도 없는 보존 대상' });
  assert.notEqual(await raw(versionPath(uid, committed, 'B')), null, '다른 요청/선택 밖 카드의 현재 버전을 보존한다');
  assert.deepEqual(await rawHead(uid), committed);
  assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 7);
  assert.equal(mutatorCalls, 1, '정리 재실행은 카드 수량 변경을 재실행하지 않는다');
  const again = await store().recoverOperation(uid, outcome.operationId);
  assert.equal(again.status, 'committed');
  assert.equal(again.cleanup, 'complete');
});

test('성공 영수증 보관 응답 실패는 성공을 유지하고 이전 증거를 보관하지 못한 후속 쓰기는 차단한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-archive-failure-synthetic';
  await seed(uid);
  const before = await rawHead(uid), retiredPath = versionPath(uid, before, 'A');
  let committedId, archiveAcknowledged = false, mutatorCalls = 0;
  const first = instrument(open().database, async (event, invoke) => {
    if (event.path === headPath(uid) && event.method === 'transaction') {
      const result = await invoke();
      if (result.committed) committedId = result.snapshot.val().commitReceipt.id;
      return result;
    }
    if (committedId && event.path === operationPath(uid, committedId) && event.method === 'transaction') {
      await invoke();
      archiveAcknowledged = true;
      throw Object.assign(new Error('합성 영수증 보관 응답 실패'), { code: 'SYNTHETIC_ARCHIVE_ACK_FAILURE' });
    }
    return invoke();
  });
  const firstStore = store(first.database);
  const success = await firstStore.updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 5; return '확정 저장';
  });
  assert.equal(archiveAcknowledged, true);
  assert.equal(success.result, '확정 저장');
  assert.equal(success.operationId, committedId);
  assert.equal(success.cleanupPending, true);
  assert.equal(mutatorCalls, 1);
  assert.equal((await firstStore.read(uid)).value.cards.A.items[0].qty, 6,
    '후처리 실패는 같은 SDK의 확정 데이터 조회를 차단하지 않는다');
  const committedHead = await rawHead(uid);
  assert.equal((await raw(operationPath(uid, committedId))).state, 'committed');
  assert.notEqual(await raw(retiredPath), null, '영수증 후처리 실패 뒤 퇴역 버전을 다음 회복까지 보존한다');

  const second = instrument(open().database, (event, invoke) => {
    if (event.path === operationPath(uid, committedId) && event.method === 'transaction') {
      return Promise.reject(Object.assign(new Error('합성 이전 영수증 보관 실패'), { code: 'SYNTHETIC_PREVIOUS_ARCHIVE_FAILURE' }));
    }
    return invoke();
  });
  let rejectedCalls = 0, rejectedOperation;
  await assert.rejects(store(second.database).updateCards(uid, ['B'], cards => {
    rejectedCalls += 1; cards.B.items[0].qty += 10;
  }), error => {
    assert.equal(error.code, 'SYNTHETIC_PREVIOUS_ARCHIVE_FAILURE');
    assert.match(error.operationId, /^[a-f0-9]{32}$/);
    assert.equal(error.cleanupPending, true);
    rejectedOperation = error.operationId;
    return true;
  });
  assert.equal(rejectedCalls, 1);
  assert.equal(second.events.some(event => event.path === headPath(uid) && event.method === 'transaction'), false,
    '이전 성공 증거를 보관하지 못하면 업무 CAS나 취소 fence로 head를 교체하지 않는다');
  assert.deepEqual(await rawHead(uid), committedHead);
  const unchanged = await store().read(uid);
  assert.equal(unchanged.value.cards.A.items[0].qty, 6);
  assert.equal(unchanged.value.cards.B.items[0].qty, 1);

  const recovered = store(open().database);
  const prior = await recovered.recoverOperation(uid, committedId);
  assert.equal(prior.status, 'committed');
  assert.equal(prior.cleanup, 'complete');
  assert.equal(await raw(retiredPath), null);
  const pending = await recovered.inspectOperation(uid, rejectedOperation);
  assert.equal(pending.status, 'ready');
  const cancelled = await recovered.recoverOperation(uid, rejectedOperation, { cancelPending: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cleanup, 'complete');
  await recovered.updateCards(uid, ['B'], cards => { cards.B.items[0].qty += 2; });
  const final = await recovered.read(uid);
  assert.equal(final.value.cards.A.items[0].qty, 6);
  assert.equal(final.value.cards.B.items[0].qty, 3, '회복은 차단했던 +10 요청을 자동 재실행하지 않는다');
  assert.equal((await recovered.inspectOperation(uid, committedId)).status, 'committed');
});

for (const acknowledged of [false, true]) test(`준비 표시의 ${acknowledged ? '승인 응답' : '제출'} 지연은 확정 취소를 덮거나 업무를 다시 제출하지 않는다`, { timeout: 30000 }, async () => {
  const uid = `recovery-ready-delayed-${acknowledged}-synthetic`;
  await seed(uid);
  const before = await rawHead(uid), entered = deferred(), resume = deferred();
  let stageAcknowledged = false, readyPath, readyCommitted, mutatorCalls = 0;
  const stagedPaths = [];
  const tracked = instrument(open().database, async (event, invoke) => {
    if (isStage(event, uid)) {
      const result = await invoke();
      stageAcknowledged = true;
      stagedPaths.push(event.path);
      return result;
    }
    if (!readyPath && stageAcknowledged && event.path.startsWith(`${operationsPath(uid)}/`) && event.method === 'transaction') {
      readyPath = event.path;
      let result;
      if (acknowledged) result = await invoke();
      entered.resolve();
      await resume.promise;
      if (!acknowledged) result = await invoke();
      readyCommitted = result.committed;
      return result;
    }
    return invoke();
  });
  const pending = store(tracked.database, { timeoutMs: 15000 }).updateCards(uid, ['A'], cards => {
    mutatorCalls += 1; cards.A.items[0].qty += 30;
  }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try {
    const operationId = readyPath.split('/').at(-1), recovery = store(open().database);
    const waiting = await recovery.inspectOperation(uid, operationId);
    assert.equal(waiting.status, acknowledged ? 'ready' : 'prepared');
    const cancelled = await recovery.recoverOperation(uid, operationId, { cancelPending: true });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cleanup, acknowledged ? 'complete' : 'fenced');
    const terminal = await raw(operationPath(uid, operationId));
    resume.resolve();
    const settled = await pending;
    assert.ok(settled.error, '늦은 준비 표시가 취소된 업무를 성공으로 전환하면 안 된다');
    assert.equal(settled.error.code, 'USER_STORAGE_OPERATION_CANCELLED');
    assert.equal(settled.error.operationId, operationId);
    assert.equal(readyCommitted, acknowledged);
    assert.equal(mutatorCalls, 1);
    assert.deepEqual(await raw(operationPath(uid, operationId)), terminal,
      '늦은 ready 제출 또는 과거 승인 응답이 terminal 저널을 되돌리지 않는다');
    assert.equal(tracked.events.some(event => event.path === headPath(uid) && event.method === 'transaction'), false);
    const head = await rawHead(uid);
    assert.equal(head.revision, before.revision + 1);
    assert.equal(head.generation, before.generation);
    assert.deepEqual(head.payload, before.payload);
    for (const path of stagedPaths) {
      assert.deepEqual(await raw(path), acknowledged ? null : { type: 'inventory-stage-closed', version: 1, operationId });
    }
    assert.equal((await recovery.read(uid)).value.cards.A.items[0].qty, 1);
  } finally { resume.resolve(); }
});

test('초기화 승인 응답 유실도 후속 새 인벤토리와 구분하고 과거 카드만 정리한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-clear-ack-synthetic';
  await seed(uid);
  const before = await rawHead(uid), oldPaths = ['A', 'B'].map(number => versionPath(uid, before, number));
  const tracked = instrument(open().database, (event, invoke) => {
    if (event.path === headPath(uid) && event.method === 'transaction') {
      return invoke().then(result => result.committed ? new Promise(() => {}) : result);
    }
    return invoke();
  });
  const unknown = await expectAmbiguous(store(tracked.database, { timeoutMs: 700 }).clear(uid));
  assert.equal((await store().read(uid)).exists, false);
  const next = await store(open().database).updateCards(uid, ['A'], cards => { cards.A = card(12); });
  const current = await rawHead(uid), currentPath = versionPath(uid, current, 'A');
  assert.equal(next.record.generation, 1);
  const result = await store().recoverOperation(uid, unknown.operationId);
  assert.equal(result.status, 'committed');
  assert.equal(result.cleanup, 'complete');
  assert.deepEqual(await rawHead(uid), current);
  for (const path of oldPaths) assert.equal(await raw(path), null);
  assert.notEqual(await raw(currentPath), null);
  assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 12);
});

test('손상된 작업 기록은 조회·회복·취소 전에 거부하고 인벤토리와 카드 버전을 보존한다', { timeout: 30000 }, async () => {
  const uid = 'recovery-invalid-journal-synthetic';
  const saved = await seed(uid), valid = await raw(operationPath(uid, saved.operationId));
  const before = await rawHead(uid), versions = await raw(versionsPath(uid));
  const invalid = [
    { ...valid, version: 99 },
    { ...valid, digest: '0'.repeat(64) },
    { ...valid, state: 'future-state' },
    { ...valid, plan: { ...valid.plan, staged: { outside: 'b'.repeat(32) } } },
    { ...valid, receipt: { ...valid.receipt, id: 'c'.repeat(32) } },
  ];
  for (let index = 0; index < invalid.length; index++) {
    await main.database.ref(operationPath(uid, saved.operationId)).set(invalid[index]);
    try {
      const tracked = instrument(open().database), instance = store(tracked.database);
      await assert.rejects(instance.inspectOperation(uid, saved.operationId));
      await assert.rejects(instance.recoverOperation(uid, saved.operationId));
      await assert.rejects(instance.recoverOperation(uid, saved.operationId, { cancelPending: true }));
      assert.equal(writes(tracked.events).length, 0, '검증하지 못한 작업의 후보 주소로 쓰기를 실행하지 않는다');
      assert.equal(tracked.events.some(event => event.path.startsWith(`${versionsPath(uid)}/`)), false);
      assert.deepEqual(await rawHead(uid), before);
      assert.deepEqual(await raw(versionsPath(uid)), versions);
    } finally {
      await main.database.ref(operationPath(uid, saved.operationId)).set(valid);
    }
  }
});
