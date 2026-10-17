'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUserStorageConnection } = require('../config/userStorage');
const { createAdminSessionStore, IDLE_MS } = require('../services/user-storage/adminSessionStore');
const { encodeKey } = require('../services/user-storage/codec');

// 합성 세션만 별도 demo RTDB 연결에 저장한다. 실제 쿠키·계정은 사용하지 않는다.
const connections = [];
const open = () => { const connection = createUserStorageConnection(); connections.push(connection); return connection; };
const main = open();
after(() => Promise.all(connections.map(connection => connection.close())));
const hash = name => createHash('sha256').update(`synthetic-admin-store:${name}`).digest('hex');
const rawPath = key => `adminSessions/${encodeKey(key)}`;
const raw = async key => (await main.database.ref(rawPath(key)).get()).val();
const session = (now = 10000000, uid = 'synthetic-admin') => ({ uid, lastActivity: now, expiresAt: now + 12 * 60 * 60 * 1000 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function trackedDatabase(database, hook = (_event, invoke) => invoke()) {
  const events = [];
  return { events, database: new Proxy(database, { get(target, name) {
    if (name === 'ref') return refPath => {
      const ref = target.ref(refPath);
      return new Proxy(ref, { get(reference, method) {
        const value = Reflect.get(reference, method, reference);
        if (typeof value !== 'function') return value;
        if (!['get', 'on', 'off', 'transaction', 'set', 'update', 'remove'].includes(method)) return value.bind(reference);
        return (...args) => { const event = { method, path: refPath }; events.push(event); return hook(event, () => value.apply(reference, args)); };
      } });
    };
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

const isWrite = event => ['transaction', 'set', 'update', 'remove'].includes(event.method);

test('RTDB 관리자 세션은 쿠키 해시별 고정 경로만 저장하며 원문 쿠키나 부수 데이터가 없다', async () => {
  const tracked = trackedDatabase(open().database);
  const store = createAdminSessionStore({ database: tracked.database });
  const key = hash('shape');
  await store.set(key, session());
  assert.deepEqual(await store.get(key), session());
  const record = await raw(key);
  assert.equal(record.format, 1); assert.equal(record.tombstone, false);
  assert.ok(tracked.events.length > 0);
  assert.ok(tracked.events.every(event => event.path === rawPath(key)));
  assert.doesNotMatch(JSON.stringify(record), /synthetic-admin-store|customClaims|membership|cookie|token/);
});

test('RTDB 관리자 세션 활동은 UID·유휴·절대 만료를 검사하고 늦게 도착한 시간이 역행하지 않는다', async () => {
  const store = createAdminSessionStore({ database: open().database });
  const key = hash('activity'), initial = session();
  await store.set(key, initial);
  assert.equal(await store.touch(key, 'other-admin', initial.lastActivity + 1), false);
  assert.equal(await store.touch(key, initial.uid, initial.lastActivity + 1000), true);
  assert.equal(await store.touch(key, initial.uid, initial.lastActivity + 500), true);
  assert.equal((await store.get(key)).lastActivity, initial.lastActivity + 1000);
  assert.equal(await store.touch(key, initial.uid, initial.lastActivity + 1000 + IDLE_MS), false);
  assert.equal(await store.touch(key, initial.uid, initial.expiresAt), false);
  assert.equal((await store.get(key)).expiresAt, initial.expiresAt);
});

test('RTDB 관리자 세션 동시 활동은 독립 연결에서도 가장 최신 시각을 보존한다', async () => {
  const first = createAdminSessionStore({ database: open().database });
  const second = createAdminSessionStore({ database: open().database });
  const key = hash('parallel-touch'), initial = session();
  await first.set(key, initial);
  assert.deepEqual(await Promise.all([
    first.touch(key, initial.uid, initial.lastActivity + 100),
    second.touch(key, initial.uid, initial.lastActivity + 200),
  ]), [true, true]);
  assert.equal((await first.get(key)).lastActivity, initial.lastActivity + 200);
});

test('RTDB 관리자 세션은 조회 후 로그아웃한 세션을 지연 활동 요청이 되살리지 못한다', async () => {
  const firstRead = deferred(), release = deferred();
  let pause = false;
  const tracked = trackedDatabase(open().database, async (event, invoke) => {
    const result = await invoke();
    if (pause && event.method === 'get') { pause = false; firstRead.resolve(); await release.promise; }
    return result;
  });
  const delayed = createAdminSessionStore({ database: tracked.database });
  const other = createAdminSessionStore({ database: open().database });
  const key = hash('logout-race'), initial = session();
  await other.set(key, initial);
  pause = true;
  const touching = delayed.touch(key, initial.uid, initial.lastActivity + 100);
  await firstRead.promise;
  assert.equal(await other.remove(key), true);
  release.resolve();
  assert.equal(await touching, false);
  assert.equal(await other.get(key), undefined);
  const removed = await raw(key);
  assert.equal(removed.tombstone, true);
  assert.equal(Object.hasOwn(removed, 'payload'), false);
});

test('RTDB 관리자 세션 조건부 삭제는 오래된 관측으로 갱신되거나 다시 발급된 세션을 제거하지 않는다', async () => {
  const first = createAdminSessionStore({ database: open().database });
  const second = createAdminSessionStore({ database: open().database });
  const key = hash('stale-remove'), initial = session();
  await first.set(key, initial);
  const observed = await first.get(key);
  await second.touch(key, initial.uid, initial.lastActivity + 100);
  assert.equal(await first.remove(key, observed), false);
  assert.equal((await second.get(key)).lastActivity, initial.lastActivity + 100);
  const renewedObservation = await first.get(key);
  await second.remove(key);
  const renewed = session(initial.lastActivity + 200, 'synthetic-new-admin');
  await second.set(key, renewed);
  assert.equal(await first.remove(key, renewedObservation), false);
  assert.deepEqual(await second.get(key), renewed);
  await assert.rejects(first.remove(key, { ...renewed }), { code: 'USER_STORAGE_INVALID_SESSION_OBSERVATION' });
  const latest = await first.get(key);
  assert.equal(await first.remove(key, latest), true);
  assert.equal(await second.get(key), undefined);
});

test('RTDB 관리자 세션은 로그아웃 뒤 새로 인증한 동일 해시 로그인을 새 세대로 저장한다', async () => {
  const first = createAdminSessionStore({ database: open().database });
  const second = createAdminSessionStore({ database: open().database });
  const key = hash('same-hash-reissue'), initial = session();
  await first.set(key, initial);
  const before = await raw(key);
  await first.remove(key);
  const deleted = await raw(key);
  assert.equal(deleted.generation, before.generation + 1);
  const reissued = session(initial.lastActivity + 1000);
  await second.set(key, reissued);
  assert.deepEqual(await second.get(key), reissued);
  const current = await raw(key);
  assert.equal(current.tombstone, false);
  assert.equal(current.generation, deleted.generation);
  assert.equal(current.revision, deleted.revision + 1);
});

test('RTDB 관리자 세션 지연 로그인 저장은 관측 후 발생한 로그아웃 경계를 넘지 못한다', async () => {
  const readReady = deferred(), release = deferred();
  let pause = false;
  const tracked = trackedDatabase(open().database, async (event, invoke) => {
    const result = await invoke();
    if (pause && event.method === 'get') { pause = false; readReady.resolve(); await release.promise; }
    return result;
  });
  const delayed = createAdminSessionStore({ database: tracked.database });
  const other = createAdminSessionStore({ database: open().database });
  const key = hash('login-logout-race'), initial = session();
  await other.set(key, initial);
  pause = true;
  const pending = delayed.set(key, session(initial.lastActivity + 100));
  const rejected = assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
  await readReady.promise;
  assert.equal(await other.remove(key), true);
  const deleted = await raw(key);
  release.resolve();
  await rejected;
  assert.equal(await other.get(key), undefined);
  assert.deepEqual(await raw(key), deleted);
});

test('RTDB 관리자 세션 임의 해시 로그아웃은 부재 조회만 하고 삭제 표식을 만들지 않는다', async () => {
  const tracked = trackedDatabase(open().database), store = createAdminSessionStore({ database: tracked.database });
  const key = hash('missing');
  assert.equal(await store.remove(key), false);
  assert.equal(await store.touch(key, 'synthetic-admin', 100), false);
  assert.equal(await store.get(key), undefined);
  assert.equal(await raw(key), null);
  assert.equal(tracked.events.some(isWrite), false);
  assert.ok(tracked.events.every(event => event.path === rawPath(key)));
});

test('RTDB 관리자 세션 손상 레코드는 읽기·활동·삭제에서 원본을 보존한다', async () => {
  const store = createAdminSessionStore({ database: open().database }), key = hash('corrupt');
  const corrupt = { format: 999, synthetic: 'do-not-delete' };
  await main.database.ref(rawPath(key)).set(corrupt);
  for (const work of [() => store.get(key), () => store.touch(key, 'synthetic-admin', 100), () => store.remove(key)]) {
    await assert.rejects(work(), { code: 'USER_STORAGE_UNSUPPORTED_FORMAT' });
    assert.deepEqual(await raw(key), corrupt);
  }
});
