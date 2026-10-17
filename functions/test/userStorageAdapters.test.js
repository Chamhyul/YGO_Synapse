'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeKey } = require('../services/user-storage/codec');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { createInventoryStore } = require('../services/user-storage/inventoryStore');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const inventory = () => ({ version: 1, amount: 3, updatedAt: 'legacy-time', locations: { '보관.함/#': 3 },
  rarities: { '미분류$': 3 }, cards: { '번호/[1]': { name: '합성 카드', cid: null,
    items: [{ qty: 3, loc: '보관.함/#', rarity: '미분류$', illustration: '알 수 없는 원문' }] } } });

// 서버 비교 후 콜백 재실행/승인하는 격리 모형. 실제 SDK/네트워크는 Docker 에뮬레이터에서 별도 검사한다.
function database() {
  const entries = new Map(), requested = [], listeners = new Map();
  const f = { entries, requested, initialNull: false, transactionCalls: 0, inCallback: false,
    beforeCommit: null, beforeAck: null, beforeGet: null, beforeListen: null, listenError: null,
    listenerAdds: 0, listenerRemoves: 0, listeners };
  const valueAt = path => clone(entries.get(path) ?? null);
  const snapshot = value => ({ val: () => clone(value) });
  f.db = { ref(path) {
    requested.push(path);
    return {
      async get() { if (f.beforeGet) await f.beforeGet(); return snapshot(valueAt(path)); },
      on(event, callback, cancel) {
        assert.equal(event, 'value');
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(callback); f.listenerAdds++;
        Promise.resolve().then(async () => {
          if (f.beforeListen) await f.beforeListen();
          if (!listeners.get(path)?.has(callback)) return;
          if (f.listenError) cancel(f.listenError);
          else callback(snapshot(valueAt(path)));
        }).catch(cancel);
        return callback;
      },
      off(event, callback) {
        assert.equal(event, 'value');
        assert.equal(typeof callback, 'function', '다른 요청의 listener를 지우면 안 된다');
        if (listeners.get(path)?.delete(callback)) f.listenerRemoves++;
      },
      async transaction(callback, completion, applyLocally) {
        assert.equal(completion, undefined);
        assert.equal(applyLocally, false);
        f.transactionCalls++;
        // get()만 호출한 ref에는 캐시가 남지 않는 실제 SDK 조건을 재현한다.
        let current = f.initialNull || !listeners.get(path)?.size ? null : valueAt(path);
        f.initialNull = false;
        for (let attempt = 0; attempt < 25; attempt++) {
          f.inCallback = true;
          let next;
          try { next = callback(clone(current)); } finally { f.inCallback = false; }
          assert.ok(!next || typeof next.then !== 'function', 'SDK 트랜잭션 콜백은 동기 함수여야 한다');
          if (next === undefined) return { committed: false, snapshot: snapshot(valueAt(path)) };
          if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = null; await hook(path); }
          if (JSON.stringify(current) !== JSON.stringify(valueAt(path))) { current = valueAt(path); continue; }
          entries.set(path, clone(next));
          if (f.beforeAck) await f.beforeAck(path);
          return { committed: true, snapshot: snapshot(next) };
        }
        throw new Error('합성 트랜잭션 재시도 한도');
      }
    };
  } };
  return f;
}

test('레코드는 위험 문자가 있는 식별자와 null/빈 값을 왕복하며 단일 경로만 접근한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  const id = '사용자.#[/]', value = { nullValue: null, empty: {}, items: [], nested: { '번호/#': '원문' } };
  assert.deepEqual(await store.read(id), { exists: false, value: undefined, revision: 0, generation: 0 });
  assert.deepEqual(await store.compareAndSet(id, 0, value), { exists: true, value, revision: 1, generation: 0 });
  assert.deepEqual((await store.read(id)).value, value);
  assert.ok(f.requested.every(path => path === `records/${encodeKey(id)}`));
});

test('삭제 tombstone은 revision을 유지하고 오래된 CAS가 초기화된 레코드를 복원하지 못한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  await store.compareAndSet('id', 0, { count: 4 });
  assert.deepEqual(await store.delete('id', 1), { exists: false, value: undefined, revision: 2, generation: 1 });
  await assert.rejects(store.compareAndSet('id', 1, { count: 5 }), { code: 'USER_STORAGE_CONFLICT' });
  await assert.rejects(store.compareAndSet('id', 0, { count: 5 }), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal((await store.compareAndSet('id', 2, { count: 1 })).revision, 3);
  assert.equal((await store.read('id')).generation, 1);
  assert.deepEqual((await store.read('id')).value, { count: 1 });
});

test('선택한 저장소만 삭제 후 ID 상한을 보존하며 삭제 준비는 트랜잭션 밖에서 수행한다', async () => {
  const f = database();
  const store = createRecordStore({ database: f.db, path: 'records', retainOnDelete: value => {
    assert.equal(f.inCallback, false);
    return { nextLocationId: value?.nextLocationId ?? 1 };
  } });
  await store.compareAndSet('id', 0, { nextLocationId: 9, cards: { synthetic: '삭제할 합성 데이터' } });
  const cleared = await store.delete('id', 1);
  assert.deepEqual(cleared, { exists: false, value: { nextLocationId: 9 }, revision: 2, generation: 1 });
  const again = await store.delete('id', 2);
  assert.deepEqual(again, { exists: false, value: { nextLocationId: 9 }, revision: 3, generation: 2 });
  const generic = createRecordStore({ database: f.db, path: 'records' });
  await assert.rejects(generic.read('id'), { code: 'USER_STORAGE_INVALID_RECORD' });
  const restored = await store.update('id', (value, metadata) => {
    assert.equal(metadata.exists, false);
    assert.equal(value.cards, undefined);
    return { value: { nextLocationId: value.nextLocationId + 1 }, result: value.nextLocationId };
  });
  assert.equal(restored.result, 9);
  assert.equal(restored.record.generation, 2);
  assert.equal(restored.record.value.nextLocationId, 10);
});

test('삭제 보존 함수 실패와 손상된 tombstone payload는 원본을 덮어쓰지 않는다', async () => {
  const f = database(), path = `records/${encodeKey('id')}`;
  const seed = createRecordStore({ database: f.db, path: 'records' });
  await seed.compareAndSet('id', 0, { nextLocationId: 4 });
  const before = clone(f.entries.get(path));
  const broken = createRecordStore({ database: f.db, path: 'records', retainOnDelete: () => { throw new Error('합성 실패'); } });
  await assert.rejects(broken.delete('id', 1), /합성 실패/);
  assert.deepEqual(f.entries.get(path), before);
  assert.equal(f.transactionCalls, 1);
  assert.equal(f.listenerAdds, f.listenerRemoves);
  const invalid = { format: 1, revision: 2, generation: 1, tombstone: true, payload: { version: 999 } };
  f.entries.set(path, invalid);
  await assert.rejects(broken.delete('id', 2));
  assert.deepEqual(f.entries.get(path), invalid);
  assert.equal(f.transactionCalls, 1);
});

test('SDK 초기 null 콜백은 기존 레코드의 부재 확정이나 덮어쓰기로 이어지지 않는다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  await store.compareAndSet('id', 0, { count: 7 });
  f.initialNull = true;
  await assert.rejects(store.compareAndSet('id', 1, { count: 99 }), { code: 'USER_STORAGE_CONFLICT' });
  assert.deepEqual((await store.read('id')).value, { count: 7 });
  f.initialNull = true;
  await assert.rejects(store.compareAndSet('id', 0, { count: 99 }), { code: 'USER_STORAGE_CONFLICT' });
  assert.deepEqual((await store.read('id')).value, { count: 7 });
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('짧은 listener는 새 연결의 기존 revision CAS를 지원하고 서버 승인 후 해당 listener만 해제한다', async () => {
  const f = database(), initial = createRecordStore({ database: f.db, path: 'records' });
  await initial.compareAndSet('id', 0, { count: 1 });
  const fresh = createRecordStore({ database: f.db, path: 'records' });
  assert.equal((await fresh.read('id')).revision, 1);
  assert.equal(f.listenerAdds, f.listenerRemoves, '일반 read는 listener를 남기지 않는다');
  const entered = deferred(), ack = deferred();
  f.beforeAck = () => { entered.resolve(); return ack.promise; };
  const pending = fresh.compareAndSet('id', 1, { count: 2 });
  await entered.promise;
  assert.equal(f.listenerAdds - f.listenerRemoves, 1, '서버 승인을 기다리는 동안 레코드 캐시를 유지한다');
  ack.resolve();
  assert.equal((await pending).revision, 2);
  assert.equal(f.listenerAdds, f.listenerRemoves);
  f.beforeAck = null;
  const ref = f.db.ref(`records/${encodeKey('id')}`), other = () => {};
  ref.on('value', other, () => {});
  await fresh.compareAndSet('id', 2, { count: 3 });
  assert.equal(f.listeners.get(`records/${encodeKey('id')}`).has(other), true);
  assert.equal(f.listenerAdds - f.listenerRemoves, 1, '다른 호출자가 소유한 listener는 보존한다');
  ref.off('value', other);
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('listener 권한 오류와 관측 revision 충돌은 쓰기 없이 해제하고 다음 연결 시도를 허용한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  f.listenError = Object.assign(new Error('권한 거부'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(store.compareAndSet('id', 0, {}), { code: 'PERMISSION_DENIED' });
  assert.equal(f.transactionCalls, 0);
  assert.equal(f.listenerAdds, f.listenerRemoves);
  f.listenError = null;
  await store.compareAndSet('id', 0, { count: 1 });
  const transactions = f.transactionCalls;
  await assert.rejects(store.compareAndSet('id', 0, {}), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal(f.transactionCalls, transactions);
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('동시 수정 재시도는 최신 값으로 다시 계산하고 최종 성공 시도의 결과만 반환한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  const independent = createRecordStore({ database: { ref: f.db.ref }, path: 'records' });
  await store.compareAndSet('id', 0, { count: 3 });
  f.beforeCommit = async () => { await independent.compareAndSet('id', 1, { count: 8 }); };
  const seen = [];
  const outcome = await store.update('id', async (value, metadata) => {
    assert.equal(f.inCallback, false);
    await Promise.resolve();
    seen.push(value.count);
    return { value: { count: value.count + 2 }, result: { previous: value.count, attempt: metadata.attempt } };
  });
  assert.deepEqual(seen, [3, 8]);
  assert.deepEqual(outcome.result, { previous: 8, attempt: 1 });
  assert.equal(outcome.record.value.count, 10);
  assert.equal(outcome.record.revision, 3);
});

test('같은 SDK 연결·레코드의 commit은 별도 store에서도 서버 승인 순서로 직렬화한다', async () => {
  const f = database(), first = createRecordStore({ database: f.db, path: 'records' });
  const second = createRecordStore({ database: f.db, path: 'records' });
  await first.compareAndSet('id', 0, { count: 1 });
  const entered = deferred(), ack = deferred();
  let held = false;
  f.beforeAck = () => { if (!held) { held = true; entered.resolve(); return ack.promise; } };
  const pending = first.compareAndSet('id', 1, { count: 2 });
  await entered.promise;
  const queued = second.compareAndSet('id', 2, { count: 3 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.transactionCalls, 2, '두 번째 store도 앞선 서버 승인 전에는 transaction을 시작하지 않는다');
  assert.equal(f.listenerAdds - f.listenerRemoves, 1);
  ack.resolve();
  assert.equal((await pending).revision, 2);
  assert.equal((await queued).revision, 3);
  assert.deepEqual((await first.read('id')).value, { count: 3 });
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('같은 경로라도 다른 DB 연결은 독립적이고 다른 레코드는 대기 없이 저장한다', async () => {
  const f = database(), first = createRecordStore({ database: f.db, path: 'records' });
  const independent = createRecordStore({ database: { ref: f.db.ref }, path: 'records' });
  await first.compareAndSet('id', 0, { count: 1 });
  const entered = deferred(), ack = deferred();
  let held = false;
  f.beforeAck = () => { if (!held) { held = true; entered.resolve(); return ack.promise; } };
  const pending = first.compareAndSet('id', 1, { count: 2 });
  await entered.promise;
  assert.equal((await first.compareAndSet('other', 0, { count: 7 })).revision, 1);
  assert.equal((await independent.compareAndSet('id', 2, { count: 3 })).revision, 3);
  ack.resolve();
  assert.equal((await pending).revision, 2);
  assert.deepEqual((await first.read('id')).value, { count: 3 });
});

test('queue 대기 시간초과는 미제출로 종료하고 선행 작업 완료 뒤에도 취소된 쓰기를 실행하지 않는다', async () => {
  const f = database(), first = createRecordStore({ database: f.db, path: 'records', timeoutMs: 1000 });
  const impatient = createRecordStore({ database: f.db, path: 'records', timeoutMs: 15 });
  const entered = deferred(), ack = deferred();
  let held = false;
  f.beforeAck = () => { if (!held) { held = true; entered.resolve(); return ack.promise; } };
  const pending = first.compareAndSet('id', 0, { count: 1 });
  await entered.promise;
  await assert.rejects(impatient.compareAndSet('id', 1, { count: 99 }), { code: 'USER_STORAGE_QUEUE_TIMEOUT' });
  assert.equal(f.transactionCalls, 1);
  ack.resolve();
  assert.equal((await pending).revision, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.transactionCalls, 1, '취소된 queue 작업은 나중에도 제출하지 않는다');
  assert.deepEqual((await impatient.read('id')).value, { count: 1 }, '미제출 timeout은 연결을 poison하지 않는다');
  assert.equal((await impatient.compareAndSet('id', 1, { count: 2 })).revision, 2, 'queue 종료 후 새 작업을 허용한다');
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('비동기 처리 중 삭제 뒤 재생성되어도 이전 요청은 세대 변경을 감지해 중단한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  await store.compareAndSet('id', 0, { count: 3 });
  const entered = deferred(), resume = deferred();
  let mutations = 0;
  const pending = store.update('id', async value => {
    mutations++;
    entered.resolve(); await resume.promise;
    return { value: { count: value.count + 50 } };
  });
  await entered.promise;
  await store.delete('id', 1);
  await store.compareAndSet('id', 2, { count: 1 });
  resume.resolve();
  await assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
  assert.equal(mutations, 1);
  assert.deepEqual((await store.read('id')).value, { count: 1 });
});

test('잘못된 경로·미래 형식·손상 envelope를 거부하고 원본을 보존한다', async () => {
  const f = database();
  for (const path of ['', '/', '/users', 'users/', 'users//nested', 'users/.hidden']) {
    assert.throws(() => createRecordStore({ database: f.db, path }), { code: 'USER_STORAGE_INVALID_PATH' });
  }
  const store = createRecordStore({ database: f.db, path: 'records' });
  const path = `records/${encodeKey('id')}`;
  f.entries.set(path, { format: 2, revision: 1 });
  await assert.rejects(store.read('id'), { code: 'USER_STORAGE_UNSUPPORTED_FORMAT' });
  await assert.rejects(store.compareAndSet('id', 0, {}), { code: 'USER_STORAGE_UNSUPPORTED_FORMAT' });
  assert.deepEqual(f.entries.get(path), { format: 2, revision: 1 });
  f.entries.set(path, { format: 1, revision: 1, generation: 0, tombstone: true });
  await assert.rejects(store.read('id'), { code: 'USER_STORAGE_INVALID_RECORD' });
  assert.equal(f.transactionCalls, 0);
});

test('각 키가 짧아도 실제 레코드·payload 전체 경로가 길면 저장 전에 거부한다', async () => {
  const f = database(), store = createRecordStore({ database: f.db, path: 'records' });
  await assert.rejects(store.compareAndSet('a'.repeat(570), 0, {}), { code: 'USER_STORAGE_INVALID_PATH' });
  assert.equal(f.requested.length, 0);
  const path = 'p'.repeat(400), longPayloadKey = '필'.repeat(70);
  const nested = createRecordStore({ database: f.db, path });
  await assert.rejects(nested.compareAndSet('a'.repeat(100), 0, { [longPayloadKey]: '원문' }),
    { code: 'user-storage/path-too-long' });
  assert.equal(f.transactionCalls, 0); assert.equal(f.listenerAdds, 0);
});

test('프로필 patch는 형제 설정·가입 시각·명시적 null을 보존한다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  const time = new Timestamp(123, 456789012);
  await store.update('uid', { settings: { theme: 'dark', membership: { status: 'active' }, nested: { a: 1, b: 2 } },
    createdAt: time, absentConsent: null });
  const saved = await store.update('uid', { settings: { theme: 'light', nested: { a: 3 } }, Nickname: '합성' });
  assert.deepEqual(saved.value.settings, { theme: 'light', membership: { status: 'active' }, nested: { a: 3, b: 2 } });
  assert.equal(saved.value.createdAt.seconds, 123);
  assert.equal(saved.value.createdAt.nanoseconds, 456789012);
  assert.equal(saved.value.absentConsent, null);
  assert.equal(saved.value.Nickname, '합성');
  assert.ok(f.requested.every(path => path === `users/${encodeKey('uid')}/profile`));
});

test('프로필 patch의 prototype 주입과 접근자 실행을 저장 전에 거부한다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  for (const patch of [JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"settings":{"constructor":{"prototype":{"polluted":true}}}}'),
    JSON.parse('{"settings":{"rows":[{"prototype":{"polluted":true}}]}}')]) {
    await assert.rejects(store.update('uid', patch), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });
  }
  let invoked = false;
  const getter = Object.defineProperty({}, 'settings', { enumerable: true, get() { invoked = true; return {}; } });
  await assert.rejects(store.update('uid', getter), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });
  assert.equal(invoked, false);
  assert.equal({}.polluted, undefined);
  assert.equal(f.requested.length, 0);
});

test('인벤토리 준비·변경은 트랜잭션 밖에서 실행하고 기존 값·수량·미확정 CID를 보존한다', async () => {
  const f = database(), prepared = [];
  const seed = createRecordStore({ database: f.db, path: 'inventories' });
  await seed.compareAndSet('uid', 0, inventory());
  const store = createInventoryStore({ database: f.db, now: () => 'fixed-time', prepare: async value => {
    assert.equal(f.inCallback, false); await Promise.resolve(); prepared.push(value.amount); value.version = 3;
  } });
  const outcome = await store.update('uid', async value => {
    assert.equal(f.inCallback, false); await Promise.resolve();
    value.amount++; value.cards['번호/[1]'].items[0].qty++;
    return { added: 1 };
  });
  assert.deepEqual(prepared, [3]);
  assert.deepEqual(outcome.result, { added: 1 });
  const actual = outcome.record.value;
  assert.equal(actual.version, 3); assert.equal(actual.amount, 4); assert.equal(actual.updatedAt, 'fixed-time');
  assert.equal(actual.cards['번호/[1]'].cid, null);
  assert.equal(actual.cards['번호/[1]'].items[0].illustration, '알 수 없는 원문');
  assert.deepEqual(actual.locations, inventory().locations);
});

test('인벤토리 초기화는 프로필을 보존하고 대기 중 보정이 이전 보유량을 복원하지 못한다', async () => {
  const f = database(), profiles = createProfileStore({ database: f.db });
  await profiles.update('uid', { Nickname: '보존', settings: { theme: 'dark' } });
  const seed = createRecordStore({ database: f.db, path: 'inventories' });
  await seed.compareAndSet('uid', 0, inventory());
  const entered = deferred(), resume = deferred();
  const store = createInventoryStore({ database: f.db, prepare: async value => {
    entered.resolve(); await resume.promise; value.version = 3;
  } });
  const pending = store.update('uid', value => { value.amount += 10; });
  await entered.promise;
  await store.clear('uid');
  resume.resolve();
  await assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
  const cleared = await store.read('uid');
  assert.equal(cleared.exists, false); assert.equal(cleared.revision, 2); assert.equal(cleared.generation, 1);
  assert.equal(cleared.value.amount, 0); assert.deepEqual(cleared.value.cards, {});
  assert.deepEqual((await profiles.read('uid')).value, { Nickname: '보존', settings: { theme: 'dark' } });
});

test('미래 인벤토리 형식은 읽기·수정에서 모두 거부하며 저장된 내용을 바꾸지 않는다', async () => {
  const f = database(), raw = createRecordStore({ database: f.db, path: 'inventories' });
  await raw.compareAndSet('uid', 0, { ...inventory(), version: 4 });
  const store = createInventoryStore({ database: f.db });
  await assert.rejects(store.read('uid'), { code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION' });
  await assert.rejects(store.update('uid', value => { value.amount = 0; }), { code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION' });
  assert.equal((await raw.read('uid')).value.amount, 3);
  assert.equal((await raw.read('uid')).revision, 1);
});

test('저장 승인 시간초과는 미확정으로 처리하고 같은 저장소의 후속 작업·자동 재시도를 금지한다', async () => {
  const f = database(), ack = deferred();
  f.beforeAck = () => ack.promise;
  let cleanupCalls = 0;
  const store = createRecordStore({ database: f.db, path: 'records', timeoutMs: 15,
    onAmbiguousWrite: async error => { assert.equal(error.code, 'USER_STORAGE_WRITE_AMBIGUOUS'); cleanupCalls++; } });
  await assert.rejects(store.update('id', () => ({ value: { count: 1 } })), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.read('id'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.compareAndSet('id', 1, {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(cleanupCalls, 1); assert.equal(f.transactionCalls, 1);
  assert.equal(f.listenerAdds, f.listenerRemoves, '저장 승인 시간초과에도 listener를 해제한다');
  ack.resolve();
  const sameConnection = createRecordStore({ database: f.db, path: 'records' });
  await assert.rejects(sameConnection.read('id'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  const fresh = createRecordStore({ database: { ref: f.db.ref }, path: 'records' });
  assert.deepEqual((await fresh.read('id')).value, { count: 1 }, '시간초과는 미반영 또는 롤백을 보장하지 않는다');
});

test('선행 쓰기가 미확정이면 같은 연결의 queue 대기 작업도 서버에 제출하지 않는다', async () => {
  const f = database(), entered = deferred(), ack = deferred();
  f.beforeAck = () => { entered.resolve(); return ack.promise; };
  const first = createRecordStore({ database: f.db, path: 'records', timeoutMs: 15 });
  const second = createRecordStore({ database: f.db, path: 'records', timeoutMs: 1000 });
  const pending = first.compareAndSet('id', 0, { count: 1 });
  const rejected = assert.rejects(pending, { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await entered.promise;
  const queued = second.compareAndSet('id', 1, { count: 99 });
  await Promise.all([rejected, assert.rejects(queued, { code: 'USER_STORAGE_WRITE_AMBIGUOUS' })]);
  assert.equal(f.transactionCalls, 1);
  assert.equal(f.listenerAdds, f.listenerRemoves);
  ack.resolve();
  const fresh = createRecordStore({ database: { ref: f.db.ref }, path: 'records' });
  assert.deepEqual((await fresh.read('id')).value, { count: 1 });
});

test('최초 listener 조회 시간초과에는 쓰기를 시작하지 않고 listener를 해제한다', async () => {
  const f = database(), read = deferred();
  f.beforeListen = () => read.promise;
  const store = createRecordStore({ database: f.db, path: 'records', timeoutMs: 15 });
  await assert.rejects(store.compareAndSet('id', 0, {}), { code: 'USER_STORAGE_READ_TIMEOUT' });
  assert.equal(f.transactionCalls, 0);
  assert.equal(f.listenerAdds, f.listenerRemoves);
  f.beforeListen = null; read.resolve();
  assert.equal((await store.read('id')).exists, false);
  assert.equal((await store.compareAndSet('id', 0, { recovered: true })).revision, 1);
  assert.equal(f.listenerAdds, f.listenerRemoves);
});

test('일반 get 조회 시간초과는 listener나 쓰기를 시작하지 않는다', async () => {
  const f = database(), read = deferred();
  f.beforeGet = () => read.promise;
  const store = createRecordStore({ database: f.db, path: 'records', timeoutMs: 15 });
  await assert.rejects(store.read('id'), { code: 'USER_STORAGE_READ_TIMEOUT' });
  assert.equal(f.transactionCalls, 0); assert.equal(f.listenerAdds, 0);
  f.beforeGet = null; read.resolve();
  assert.equal((await store.read('id')).exists, false);
});
