'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminSessionStore, IDLE_MS } = require('../services/user-storage/adminSessionStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const key = 'a'.repeat(64), secondKey = 'b'.repeat(64), uid = 'synthetic-admin';
const time = 1791760000123;
const value = overrides => ({ uid, lastActivity: time, expiresAt: time + 12 * 60 * 60 * 1000, ...overrides });
const clone = entry => entry === undefined ? undefined : JSON.parse(JSON.stringify(entry));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 서로 다른 SDK 연결의 CAS 충돌과 응답 유실을 재현한다. 실제 SDK/HTTP 검사는 별도 Docker 검사다.
function database() {
  const records = new Map(), listeners = new Map();
  const f = { records, writes: 0, refs: [], transactions: 0, beforeCommit: null, beforeAck: null, beforeGet: null };
  const snapshot = entry => ({ val: () => clone(entry) });
  const current = path => clone(records.get(path) ?? null);
  f.db = { ref(path) {
    f.refs.push(path);
    return {
      async get() { if (f.beforeGet) await f.beforeGet(path); return snapshot(current(path)); },
      on(event, callback) {
        assert.equal(event, 'value');
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(callback);
        queueMicrotask(() => { if (listeners.get(path)?.has(callback)) callback(snapshot(current(path))); });
      },
      off(event, callback) { assert.equal(event, 'value'); listeners.get(path)?.delete(callback); },
      async transaction(callback, completion, applyLocally) {
        assert.equal(completion, undefined); assert.equal(applyLocally, false);
        f.transactions++;
        let observed = current(path);
        for (let retry = 0; retry < 20; retry++) {
          const proposed = callback(observed);
          if (proposed === undefined) return { committed: false, snapshot: snapshot(current(path)) };
          assert.equal(typeof proposed.then, 'undefined');
          if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = null; await hook(path); }
          if (JSON.stringify(observed) !== JSON.stringify(current(path))) { observed = current(path); continue; }
          records.set(path, clone(proposed)); f.writes++;
          if (f.beforeAck) await f.beforeAck();
          return { committed: true, snapshot: snapshot(proposed) };
        }
        throw new Error('합성 CAS 한도');
      },
    };
  } };
  f.other = () => ({ ref: f.db.ref });
  return f;
}

test('관리자 세션은 해시 하나의 고정 경로와 세 가지 필드만 왕복한다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  assert.equal(await store.get(key), undefined);
  assert.equal(await store.set(key, value()), undefined);
  assert.deepEqual(await store.get(key), value());
  assert.ok(f.refs.every(path => path === `adminSessions/${encodeKey(key)}`));
  assert.equal(f.records.size, 1);
  const returned = await store.get(key); returned.uid = '합성 변경';
  assert.deepEqual(await store.get(key), value(), '조회 객체의 변경은 DB를 바꾸지 않는다');
});

test('쿠키 원문·잘못된 해시·비밀 필드를 입력하면 DB에 접근하지 않는다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  for (const bad of [undefined, '', 'cookie-synthetic', 'A'.repeat(64), 'a'.repeat(63), `${key}/child`]) {
    for (const call of [() => store.get(bad), () => store.set(bad, value()), () => store.remove(bad), () => store.touch(bad, uid, time)]) {
      await assert.rejects(call(), { code: 'USER_STORAGE_INVALID_SESSION_KEY' });
    }
  }
  for (const bad of [null, [], {}, value({ uid: '' }), value({ uid: 'u'.repeat(129) }), value({ uid: '\ud800' }),
    value({ lastActivity: -1 }), value({ lastActivity: 1.1 }), value({ expiresAt: NaN }),
    value({ expiresAt: Number.MAX_SAFE_INTEGER + 1 }), value({ expiresAt: time }), value({ cookie: 'synthetic-only' })]) {
    await assert.rejects(store.set(key, bad), { code: 'USER_STORAGE_INVALID_SESSION' });
  }
  const accessor = value(); Object.defineProperty(accessor, 'uid', { get() { throw new Error('getter must not run'); }, enumerable: true });
  await assert.rejects(store.set(key, accessor), { code: 'USER_STORAGE_INVALID_SESSION' });
  assert.equal(f.refs.length, 0);
});

test('손상된 저장 세션은 조회·생성·갱신·삭제 모두 실패하고 원본을 보존한다', async () => {
  for (const payload of [null, [], 'synthetic', {}, value({ expiresAt: 1 }), value({ extra: true })]) {
    const f = database(), path = `adminSessions/${encodeKey(key)}`;
    const malformed = { format: 1, revision: 1, generation: 0, tombstone: false, payload: encodeValue(payload) };
    f.records.set(path, clone(malformed));
    const store = createAdminSessionStore({ database: f.db });
    for (const call of [() => store.get(key), () => store.set(key, value()), () => store.touch(key, uid, time), () => store.remove(key)]) {
      await assert.rejects(call(), { code: 'USER_STORAGE_INVALID_SESSION' });
    }
    assert.deepEqual(f.records.get(path), malformed); assert.equal(f.writes, 0);
  }
});

test('활동은 UID와 유휴·절대 만료를 확인하고 만료 경계에서는 저장하지 않는다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  await store.set(key, value());
  assert.equal(await store.touch(key, 'other-user', time + 1), false);
  assert.equal(await store.touch(key, undefined, time + 1), false);
  assert.equal(await store.touch(key, uid, time + IDLE_MS), false);
  assert.equal(await store.touch(secondKey, uid, time + 1), false);
  await assert.rejects(store.touch(key, uid, NaN), { code: 'USER_STORAGE_INVALID_SESSION_TIME' });
  assert.equal(f.writes, 1);
  assert.equal(await store.touch(key, uid, time + IDLE_MS - 1), true);
  assert.equal((await store.get(key)).lastActivity, time + IDLE_MS - 1);
  await store.set(secondKey, value({ expiresAt: time + 100 }));
  assert.equal(await store.touch(secondKey, uid, time + 100), false);
  assert.equal((await store.get(secondKey)).lastActivity, time);
});

test('늦게 도착한 활동과 동시 활동은 저장 시각을 뒤로 되돌리지 않는다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { assert.equal(await second.touch(key, uid, time + 2000), true); };
  assert.equal(await first.touch(key, uid, time + 1000), true);
  assert.equal((await first.get(key)).lastActivity, time + 2000);
  assert.equal(await first.touch(key, uid, time - 1), true);
  assert.equal((await first.get(key)).lastActivity, time + 2000);
});

test('진행 중 활동보다 logout이 먼저 확정되면 활동은 세션을 부활시키지 않는다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db, maxAttempts: 1 });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { assert.equal(await second.remove(key), true); };
  assert.equal(await first.touch(key, uid, time + 1), false);
  assert.equal(await first.get(key), undefined);
  assert.equal(f.writes, 2);
});

test('삭제 뒤 같은 해시로 새 로그인해도 진행 중 활동은 새 세션을 갱신하지 않는다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { await second.remove(key); await second.set(key, value({ lastActivity: time + 20 })); };
  assert.equal(await first.touch(key, uid, time + 1000), false);
  assert.deepEqual(await first.get(key), value({ lastActivity: time + 20 }));
});

test('삭제와 경합한 로그인 저장은 재적용하지 않고 후속 명시 로그인만 재생성한다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { await second.remove(key); };
  await assert.rejects(first.set(key, value({ lastActivity: time + 100 })), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal(await first.get(key), undefined);
  await first.set(key, value({ lastActivity: time + 200 }));
  assert.deepEqual(await first.get(key), value({ lastActivity: time + 200 }));
});

test('삭제가 활동과 경합하면 최신 상태를 재조회해 최종 삭제한다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { await second.touch(key, uid, time + 1); };
  assert.equal(await first.remove(key), true);
  assert.equal(await first.get(key), undefined);
});

test('알 수 없는 쿠키와 반복 logout은 영구 삭제 표식을 늘리지 않는다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  assert.equal(await store.remove(key), false); assert.equal(f.records.size, 0);
  await store.set(key, value()); assert.equal(await store.remove(key), true);
  const tombstone = clone(f.records.get(`adminSessions/${encodeKey(key)}`));
  assert.equal(await store.remove(key), false);
  assert.deepEqual(f.records.get(`adminSessions/${encodeKey(key)}`), tombstone);
  assert.equal(f.writes, 2);
});

test('최초 저장 전 아직 존재하지 않는 쿠키의 logout은 기존 계약처럼 no-op이다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  f.beforeCommit = async () => { assert.equal(await second.remove(key), false); };
  await first.set(key, value());
  assert.deepEqual(await first.get(key), value());
  assert.equal(f.writes, 1);
});

test('조회한 세션의 조건부 삭제는 최신 활동·새 로그인·다른 해시를 삭제하지 않는다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  await store.set(key, value());
  const old = await store.get(key);
  await store.touch(key, uid, time + 100);
  assert.equal(await store.remove(key, old), false);
  assert.deepEqual(await store.get(key), value({ lastActivity: time + 100 }));
  await assert.rejects(store.remove(secondKey, old), { code: 'USER_STORAGE_INVALID_SESSION_OBSERVATION' });
  await assert.rejects(store.remove(key, { ...old }), { code: 'USER_STORAGE_INVALID_SESSION_OBSERVATION' });
  const current = await store.get(key);
  assert.equal(await store.remove(key, current), true);
  await store.set(key, value({ lastActivity: time + 200 }));
  assert.equal(await store.remove(key, current), false);
  assert.deepEqual(await store.get(key), value({ lastActivity: time + 200 }));
});

test('조건부 삭제 CAS 도중 충돌해도 갱신된 세션을 다시 삭제하지 않는다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value()); const observed = await first.get(key);
  f.beforeCommit = async () => { await second.touch(key, uid, time + 100); };
  assert.equal(await first.remove(key, observed), false);
  assert.equal((await first.get(key)).lastActivity, time + 100);
  assert.equal(f.writes, 2);
});

test('생성 입력은 await 이후 호출자가 바꾸어도 최초 검증한 값만 저장한다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  const ready = deferred(), release = deferred();
  f.beforeGet = async () => { ready.resolve(); await release.promise; };
  const original = value(), pending = store.set(key, original);
  await ready.promise; original.uid = 'changed-synthetic'; original.expiresAt = -1; release.resolve();
  await pending; assert.deepEqual(await store.get(key), value());
});

test('활동 충돌 재시도 한도를 넘으면 성공으로 응답하지 않는다', async () => {
  const f = database(), first = createAdminSessionStore({ database: f.db, maxAttempts: 1 });
  const second = createAdminSessionStore({ database: f.other() });
  await first.set(key, value());
  f.beforeCommit = async () => { await second.touch(key, uid, time + 2); };
  await assert.rejects(first.touch(key, uid, time + 1), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal((await first.get(key)).lastActivity, time + 2);
});

test('읽기 오류는 전파하고 손상된 envelope는 덮어쓰지 않는다', async () => {
  const f = database(), store = createAdminSessionStore({ database: f.db });
  f.beforeGet = async () => { throw Object.assign(new Error('synthetic'), { code: 'PERMISSION_DENIED' }); };
  await assert.rejects(store.get(key), { code: 'PERMISSION_DENIED' }); assert.equal(f.writes, 0);
  f.beforeGet = null;
  f.records.set(`adminSessions/${encodeKey(key)}`, { format: 99 });
  await assert.rejects(store.set(key, value()), { code: 'USER_STORAGE_UNSUPPORTED_FORMAT' });
  assert.equal(f.writes, 0);
});

test('쓰기 응답 유실은 공용 DB 연결을 차단하고 자동 재시도·늦은 성공을 반환하지 않는다', async () => {
  const f = database(), ack = deferred(); let ambiguous = 0;
  const store = createAdminSessionStore({ database: f.db, timeoutMs: 20, onAmbiguousWrite: () => { ambiguous++; } });
  const sibling = createRecordStore({ database: f.db, path: 'users', suffix: 'profile', timeoutMs: 20 });
  f.beforeAck = () => ack.promise;
  await assert.rejects(store.set(key, value()), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(f.writes, 1); assert.equal(f.transactions, 1); assert.equal(ambiguous, 1);
  await assert.rejects(store.get(key), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.touch(key, uid, time + 1), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.remove(key), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(sibling.read('synthetic-admin'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  ack.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const replacement = createAdminSessionStore({ database: f.other() });
  assert.deepEqual(await replacement.get(key), value(), '새 연결에서 저장 결과를 대조한다');
  assert.equal(f.writes, 1);
});
