'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createUserStorageConnection } = require('../config/userStorage');
const { createMembershipCsvStore, CONTROL_LIMIT } = require('../services/user-storage/membershipCsvStore');
const { createMembershipCsvService } = require('../services/membershipCsvService');
const { encodeKey, decodeValue, encodeValue } = require('../services/user-storage/codec');
const connections = [];
const open = () => { const value = createUserStorageConnection(); connections.push(value); return value.database; };
after(() => Promise.all(connections.map(value => value.close())));
const member = n => ({ channelId: 'UC' + String(n).padStart(22, '0'), memberName: '합성 회원', levelName: n % 2 ? 'A' : 'B' });
const id = () => randomBytes(16).toString('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function tracked(database, hook = (_event, call) => call()) {
  const events = [];
  return { events, database: new Proxy(database, { get(target, property) {
    if (property !== 'ref') return Reflect.get(target, property, target);
    return path => new Proxy(target.ref(path), { get(ref, method) {
      const value = Reflect.get(ref, method, ref);
      if (typeof value !== 'function') return value;
      if (!['get', 'on', 'off', 'transaction'].includes(method)) return value.bind(ref);
      return (...args) => { const event = { path, method }; events.push(event); return hook(event, () => value.apply(ref, args)); };
    } });
  } }) };
}
function fixture(options = {}) {
  const path = options.path || `membershipCsvSynthetic/${id()}`;
  const database = options.database || open(); let now = Date.now();
  const store = createMembershipCsvStore({ database, path, maxAttempts: 10, now: () => now, ...options });
  return { path, database, store, service: createMembershipCsvService({ store, now: () => now }), advance(value) { now += value; } };
}
const body = async (service, members) => ({ members, ...await service.preview({ members }), operationId: id() });
const rawControl = async f => (await f.database.ref(`${f.path}/control/${encodeKey('current')}`).get()).val();

test('RTDB CSV 빈 상태부터 미리보기·활성 전환·읽기·동일 요청 재전송과 관리자 경계를 유지한다', async () => {
  const trace = tracked(open()), f = fixture({ database: trace.database });
  assert.deepEqual((await f.service.summary()).count, 0);
  const request = await body(f.service, [member(1), member(2)]);
  assert.equal(await rawControl(f), null);
  const result = await f.service.apply(request, 'synthetic-admin');
  assert.equal(result.count, 2);
  assert.deepEqual(await f.service.apply(request, 'synthetic-admin'), result);
  assert.deepEqual(await f.store.readMember(member(1).channelId), member(1));
  assert.equal(await f.store.readMember(member(3).channelId), null);
  await assert.rejects(f.service.status({ operationId: request.operationId }, 'other-admin'), { status: 403 });
  await assert.rejects(f.service.apply(request, 'other-admin'), { status: 409 });
  const state = decodeValue((await rawControl(f)).payload);
  assert.equal(state.active.revision, request.operationId);
  assert.equal(state.operations[request.operationId].completedAt, result.updatedAt);
  assert.equal(state.operations[request.operationId].result, undefined);
  assert.equal(JSON.stringify(state).includes('합성 회원'), false);
  assert.ok(trace.events.every(event => event.path.startsWith(`${f.path}/`) && event.path.split('/').length === 4));
  assert.ok(trace.events.filter(event => event.method === 'transaction' && event.path.includes('/control/')).length > 0);
});

test('RTDB CSV 후보 전체가 저장되어도 control 전환 전에는 이전 목록을 반환한다', async () => {
  const f = fixture(); await f.service.apply(await body(f.service, [member(1)]), 'admin');
  const original = f.store.commit;
  f.store.commit = async (...args) => {
    assert.deepEqual((await f.store.read()).members, [member(1)]);
    return original(...args);
  };
  await f.service.apply(await body(f.service, [member(2)]), 'admin');
  assert.deepEqual((await f.store.read()).members, [member(2)]);
});

test('RTDB CSV 독립 SDK 동시 관리자는 같은 revision에서 하나만 전환한다', async () => {
  const first = fixture(), second = fixture({ path: first.path });
  const left = await body(first.service, [member(1)]), right = await body(second.service, [member(2)]);
  const results = await Promise.allSettled([first.service.apply(left, 'admin-1'), second.service.apply(right, 'admin-2')]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.status, 409);
  await assert.rejects(first.service.apply({ ...left, operationId: id() }, 'admin-1'), { status: 409 });
});

for (const damage of ['missing', 'fingerprint', 'content']) {
  test(`RTDB CSV 후보 ${damage} 손상은 활성화하지 않고 이전 목록을 유지한다`, async () => {
    const f = fixture(); await f.service.apply(await body(f.service, [member(1)]), 'admin');
    const original = f.store.commit;
    f.store.commit = async (...args) => {
      const ref = f.database.ref(`${f.path}/candidates/${encodeKey(args[0])}`);
      if (damage === 'missing') await ref.remove();
      else {
        const raw = (await ref.get()).val(), value = decodeValue(raw.payload);
        if (damage === 'fingerprint') value.fingerprint = 'f'.repeat(64); else value.members[0].levelName = 'changed';
        await ref.set({ ...raw, payload: encodeValue(value) });
      }
      return original(...args);
    };
    await assert.rejects(f.service.apply(await body(f.service, [member(2)]), 'admin'), { status: 503 });
    assert.deepEqual((await f.store.read()).members, [member(1)]);
  });
}

test('RTDB CSV 활성 후보 손상은 비회원 또는 옛 목록으로 대체하지 않는다', async () => {
  const f = fixture(), request = await body(f.service, [member(1)]); await f.service.apply(request, 'admin');
  await f.database.ref(`${f.path}/candidates/${encodeKey(request.operationId)}`).remove();
  await assert.rejects(f.store.readMember(member(1).channelId), { status: 503 });
});

test('RTDB CSV 만료 확인 뒤 지연된 후보 저장은 활성 포인터를 바꾸지 못한다', async () => {
  const f = fixture(), request = await body(f.service, [member(1)]), entered = deferred(), release = deferred();
  const stage = f.store.stage; f.store.stage = async (...args) => { await stage(...args); entered.resolve(); await release.promise; };
  const pending = f.service.apply(request, 'admin'); const rejected = assert.rejects(pending, { status: 409 });
  await entered.promise; f.advance(120001);
  assert.equal((await f.service.status({ operationId: request.operationId }, 'admin')).status, 'failed');
  release.resolve(); await rejected;
  assert.equal((await f.service.summary()).count, 0);
});

test('RTDB CSV 활성 전환 응답 유실은 완료 기록을 확인하며 중복 반영하지 않는다', async () => {
  let controlTransactions = 0;
  const trace = tracked(open(), async (event, call) => {
    const result = await call();
    if (event.method === 'transaction' && event.path.includes('/control/') && ++controlTransactions === 2) throw Error('synthetic-lost-response');
    return result;
  });
  const f = fixture({ database: trace.database }), request = await body(f.service, [member(1)]);
  const result = await f.service.apply(request, 'admin');
  assert.equal(result.count, 1); assert.equal(controlTransactions, 2);
  assert.equal((await f.service.status({ operationId: request.operationId }, 'admin')).status, 'completed');
});

test('RTDB CSV control 크기를 제한하면서 이전 완료 결과와 동일 작업 재전송을 보존한다', { timeout: 60000 }, async () => {
  const f = fixture(), first = await body(f.service, [member(1)]), firstResult = await f.service.apply(first, 'admin');
  // 고정 시험 시각의 동률을 제거해 가장 오래된 작업의 아카이브를 명확히 검사한다.
  for (let n = 0; n < CONTROL_LIMIT + 1; n++) {
    f.advance(1);
    await f.service.apply(await body(f.service, [member(n + 2)]), 'admin');
  }
  const state = decodeValue((await rawControl(f)).payload);
  assert.equal(Object.keys(state.operations).length, CONTROL_LIMIT);
  assert.equal(state.operations[first.operationId], undefined);
  assert.deepEqual(await f.service.apply(first, 'admin'), firstResult);
  assert.equal((await f.service.status({ operationId: first.operationId }, 'admin')).status, 'completed');
  assert.deepEqual((await f.store.read()).members, [member(CONTROL_LIMIT + 2)]);
});

test('RTDB CSV 전환 승인 시간초과는 현재 연결을 닫고 새 연결에서만 반영 여부를 확인한다', { timeout: 15000 }, async () => {
  let transactions = 0, ambiguous = 0;
  const path = `membershipCsvSynthetic/${id()}`;
  const trace = tracked(open(), async (event, call) => {
    const result = await call();
    if (event.method === 'transaction' && event.path.includes('/control/') && ++transactions === 2) return new Promise(() => {});
    return result;
  });
  const f = fixture({ path, database: trace.database, timeoutMs: 1000, onAmbiguousWrite: () => { ambiguous++; } });
  const request = await body(f.service, [member(1)]);
  await assert.rejects(f.service.apply(request, 'admin'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(f.store.read(), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(ambiguous, 1);
  const fresh = fixture({ path });
  assert.equal((await fresh.service.status({ operationId: request.operationId }, 'admin')).status, 'completed');
  assert.equal((await fresh.service.summary()).count, 1);
});

test('RTDB CSV 작업 슬롯을 모두 점유한 중단 요청도 만료 후 다음 적용을 영구 차단하지 않는다', { timeout: 60000 }, async () => {
  const { createHash } = require('node:crypto');
  const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const f = fixture(), revision = (await f.store.read()).revision, firstId = id();
  for (let n = 0; n < CONTROL_LIMIT; n++) {
    await f.store.begin(n === 0 ? firstId : id(), hash(['admin', revision, hash([member(1)])]), revision, 'admin', 0);
  }
  await f.service.apply(await body(f.service, [member(2)]), 'admin');
  assert.equal((await f.service.status({ operationId: firstId }, 'admin')).status, 'failed');
  assert.deepEqual((await f.store.read()).members, [member(2)]);
});
