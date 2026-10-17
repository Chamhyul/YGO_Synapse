'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { encodeKey, encodeValue, decodeValue } = require('../services/user-storage/codec');
const { createProfilePayloadCodec } = require('../services/user-storage/profileCodec');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { createRecordStore } = require('../services/user-storage/recordStore');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 순수 CAS 모형이며 실제 .sv 처리/SDK 응답은 Docker RTDB 검사에서 별도로 확인한다.
function database() {
  const records = new Map(), listeners = new Map();
  const f = { records, writes: 0, transactions: 0, proposed: [], beforeCommit: null,
    beforeGet: null, beforeAck: null, now: 1791760000123 };
  const snapshot = value => ({ val: () => clone(value) });
  const valueAt = path => clone(records.get(path) ?? null);
  function resolveTimes(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && value['.sv'] === 'timestamp') return f.now;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTimes(child)]));
  }
  f.db = { ref(path) { return {
    async get() { if (f.beforeGet) await f.beforeGet(); return snapshot(valueAt(path)); },
    on(event, callback) {
      assert.equal(event, 'value');
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path).add(callback);
      queueMicrotask(() => { if (listeners.get(path)?.has(callback)) callback(snapshot(valueAt(path))); });
    },
    off(event, callback) { assert.equal(event, 'value'); listeners.get(path)?.delete(callback); },
    async transaction(callback, completion, applyLocally) {
      assert.equal(completion, undefined); assert.equal(applyLocally, false);
      f.transactions++;
      let current = valueAt(path);
      for (let retry = 0; retry < 20; retry++) {
        const next = callback(current);
        if (next === undefined) return { committed: false, snapshot: snapshot(valueAt(path)) };
        assert.equal(typeof next.then, 'undefined');
        f.proposed.push(clone(next));
        if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = null; await hook(path); }
        if (JSON.stringify(current) !== JSON.stringify(valueAt(path))) { current = valueAt(path); continue; }
        const resolved = resolveTimes(next);
        records.set(path, resolved); f.writes++;
        if (f.beforeAck) await f.beforeAck();
        return { committed: true, snapshot: snapshot(resolved) };
      }
      throw new Error('합성 CAS 한도');
    },
  }; } };
  return f;
}

test('프로필 merge는 빈 하위 map만 교체하고 형제·배열·null·Timestamp 원형을 보존한다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  const time = new Timestamp(1730000000, 123456789), date = new Date('2020-03-04T05:06:07.123Z');
  await store.update('synthetic', { settings: { theme: 'dark', local: { enabled: true } },
    membership: { tier: 'synthetic', expiresAt: time }, createdAt: time, date, tags: ['old'], nullable: 'old' });
  const result = await store.update('synthetic', { settings: { local: {} }, tags: [], nullable: null });
  assert.deepEqual(result.value.settings, { theme: 'dark', local: {} });
  assert.deepEqual(result.value.tags, []); assert.equal(result.value.nullable, null);
  assert.deepEqual(result.value.membership, { tier: 'synthetic', expiresAt: time });
  assert.ok(result.value.createdAt instanceof Timestamp);
  assert.equal(result.value.createdAt.nanoseconds, 123456789);
  assert.ok(result.value.date instanceof Date); assert.equal(result.value.date.getTime(), date.getTime());
  const empty = await store.update('synthetic', {});
  assert.deepEqual(empty.value, result.value, '최상위 빈 patch는 기존 필드를 지우지 않는다');
});

test('프로필 null 원형 map과 기존 범용 payload는 업데이트에서도 왕복한다', async () => {
  const f = database(), raw = createRecordStore({ database: f.db, path: 'users', suffix: 'profile' });
  const value = Object.assign(Object.create(null), { settings: Object.assign(Object.create(null), { theme: 'dark' }) });
  await raw.compareAndSet('synthetic', 0, value);
  const store = createProfileStore({ database: f.db });
  const result = await store.update('synthetic', { settings: { location: '합성 보관함' } });
  assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal(Object.getPrototypeOf(result.value.settings), null);
  assert.equal(result.value.settings.theme, 'dark');
});

test('객체가 아닌 손상된 프로필은 읽기·신규 가입·변경 모두 거부하고 원문을 보존한다', async () => {
  for (const value of [null, [], ['합성'], '합성', 7, false, new Date(0), new Timestamp(1, 2)]) {
    const f = database(), raw = createRecordStore({ database: f.db, path: 'users', suffix: 'profile' });
    await raw.compareAndSet('synthetic', 0, value);
    const before = clone(f.records.get(`users/${encodeKey('synthetic')}/profile`));
    const profiles = createProfileStore({ database: f.db });
    await assert.rejects(profiles.read('synthetic'), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });
    await assert.rejects(profiles.createIfAbsent('synthetic', { nickname: '교체 금지' }), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });
    await assert.rejects(profiles.update('synthetic', { settings: {} }), { code: 'USER_STORAGE_INVALID_PROFILE_PATCH' });
    assert.equal(f.writes, 1);
    assert.deepEqual(f.records.get(`users/${encodeKey('synthetic')}/profile`), before);
  }
});

test('신규 생성은 한 번만 저장하고 기존 프로필 재시도는 revision/시간/설정이 변하지 않는다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  const options = { serverTimestampPaths: [['createdAt'], ['registration', 'consent', 'acceptedAt']] };
  const initial = { nickname: '합성', createdAt: null, registration: { consent: { acceptedAt: null } }, settings: { theme: 'dark' } };
  const created = await store.createIfAbsent('synthetic', initial, options);
  assert.equal(created.created, true); assert.equal(created.record.revision, 1);
  assert.equal(created.record.value.createdAt.toMillis(), f.now);
  const stored = clone(f.records.get(`users/${encodeKey('synthetic')}/profile`));
  f.now += 10000;
  const repeated = await store.createIfAbsent('synthetic', { ...initial, nickname: '덮어쓰지 않음' }, options);
  assert.equal(repeated.created, false); assert.deepEqual(repeated.record, created.record);
  assert.deepEqual(f.records.get(`users/${encodeKey('synthetic')}/profile`), stored);
  assert.equal(f.writes, 1); assert.equal(f.transactions, 1);
});

test('서로 다른 연결의 동시 가입은 최종 승자만 저장하고 패자는 기존 값으로 반환한다', async () => {
  const f = database(), first = createProfileStore({ database: f.db });
  const second = createProfileStore({ database: { ref: f.db.ref } });
  let winner;
  f.beforeCommit = async () => { winner = await second.createIfAbsent('synthetic', { nickname: '승자', createdAt: null },
    { serverTimestampPaths: [['createdAt']] }); };
  const loser = await first.createIfAbsent('synthetic', { nickname: '패자', createdAt: null }, { serverTimestampPaths: [['createdAt']] });
  assert.equal(winner.created, true); assert.equal(loser.created, false);
  assert.deepEqual(loser.record, winner.record); assert.equal(f.writes, 1);
});

test('갱신 충돌 시 최신 설정과 멤버십을 병합하고 서버 시각은 승인된 저장 값으로 반환한다', async () => {
  const f = database(), first = createProfileStore({ database: f.db });
  const other = createProfileStore({ database: { ref: f.db.ref } });
  await first.createIfAbsent('synthetic', { settings: { theme: 'light' }, membership: { tier: 'base' } });
  f.beforeCommit = async () => { await other.update('synthetic', { settings: { theme: 'dark' }, membership: { tier: 'preserve' } }); };
  const result = await first.update('synthetic', { settings: { location: '합성' }, updatedAt: null }, { serverTimestampPaths: [['updatedAt']] });
  assert.deepEqual(result.value.settings, { theme: 'dark', location: '합성' });
  assert.deepEqual(result.value.membership, { tier: 'preserve' });
  assert.equal(result.value.updatedAt.toDate().getTime(), f.now);
  assert.equal(result.revision, 3);
  const proposed = f.proposed.at(-1).payload.value[encodeKey('updatedAt')];
  assert.deepEqual(proposed, { t: 'server-time', v: { '.sv': 'timestamp' } });
});

test('요청 중 patch와 서버 시간 경로 배열을 바꿔도 처음 검증한 값만 저장한다', async () => {
  const f = database(), entered = deferred(), gate = deferred();
  const store = createProfileStore({ database: f.db });
  f.beforeGet = () => { entered.resolve(); return gate.promise; };
  const patch = { settings: { theme: 'dark' }, updatedAt: null }, paths = [['updatedAt']];
  const pending = store.update('synthetic', patch, { serverTimestampPaths: paths });
  await entered.promise;
  patch.settings.theme = 'changed'; paths[0][0] = 'membership'; paths.push(['createdAt']);
  gate.resolve();
  const result = await pending;
  assert.equal(result.value.settings.theme, 'dark'); assert.equal(result.value.updatedAt.toMillis(), f.now);
});

test('서버 시간은 허용된 명시 null 필드만 받으며 누락·중복·유사 경로를 저장 전에 거부한다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  for (const [patch, paths] of [
    [{}, [['updatedAt']]], [{ updatedAt: 'client-time' }, [['updatedAt']]],
    [{ updatedAt: null }, [['updatedAt'], ['updatedAt']]], [{ membership: null }, [['membership']]],
    [{ 'registration.consent.acceptedAt': null }, [['registration.consent.acceptedAt']]],
    [{ updatedAt: null }, 'updatedAt'], [{ updatedAt: null }, [null]],
  ]) {
    await assert.rejects(store.update('synthetic', patch, { serverTimestampPaths: paths }), { code: 'USER_STORAGE_INVALID_SERVER_TIMESTAMP' });
    await assert.rejects(store.createIfAbsent('synthetic', patch, { serverTimestampPaths: paths }), { code: 'USER_STORAGE_INVALID_SERVER_TIMESTAMP' });
  }
  assert.equal(f.transactions, 0); assert.equal(f.records.size, 0);
});

test('시간 태그와 .sv를 흉내 낸 일반 사용자 객체는 서버 명령으로 해석하지 않는다', async () => {
  const f = database(), store = createProfileStore({ database: f.db });
  const value = { settings: { fake: { t: 'server-time', v: { '.sv': 'timestamp' } } }, updatedAt: { t: 'server-time', v: 123 } };
  assert.deepEqual((await store.update('synthetic', value)).value, value);
  const raw = f.proposed.at(-1).payload;
  assert.equal(JSON.stringify(raw).includes('".sv"'), false, '사용자 객체의 .sv 키는 범용 코덱으로 인코딩된다');
});

test('미확정/손상된 서버 시각 태그와 허용 필드 밖의 태그를 읽기/변경에서 거부한다', async () => {
  for (const [path, tag] of [
    [['updatedAt'], { t: 'server-time', v: { '.sv': 'timestamp' } }],
    [['updatedAt'], { t: 'server-time', v: 1.5 }],
    [['updatedAt'], { t: 'server-time', v: 253402300800000 }],
    [['updatedAt'], { t: 'server-time', v: 12, extra: true }],
    [['settings'], { t: 'server-time', v: 12 }],
    [['registration.consent.acceptedAt'], { t: 'server-time', v: 12 }],
  ]) {
    const f = database(), payload = encodeValue({});
    payload.value[encodeKey(path[0])] = tag;
    f.records.set(`users/${encodeKey('synthetic')}/profile`, { format: 1, revision: 1, generation: 0, tombstone: false, payload });
    const store = createProfileStore({ database: f.db });
    await assert.rejects(store.read('synthetic'), { code: 'user-storage/invalid-format' });
    await assert.rejects(store.update('synthetic', { settings: {} }), { code: 'user-storage/invalid-format' });
    assert.equal(f.writes, 0);
  }
});

test('프로필 코덱은 기존 Timestamp 나노초/Date와 음수 서버 milliseconds를 구분한다', () => {
  const codec = createProfilePayloadCodec();
  const value = { createdAt: new Timestamp(1700000000, 123456789), old: new Date(-1), updatedAt: null };
  const encoded = codec.encode(codec.withServerTimestamps(value, [['updatedAt']]));
  encoded.value[encodeKey('updatedAt')].v = -1;
  const result = codec.decode(encoded);
  assert.equal(result.updatedAt.toMillis(), -1); assert.equal(result.updatedAt.nanoseconds, 999000000);
  assert.deepEqual(result.createdAt, value.createdAt); assert.deepEqual(result.old, value.old);
});

test('서버 시각 sentinel의 실제 경로 한도와 숨김/접근자 payload를 검증한다', () => {
  const codec = createProfilePayloadCodec(), value = codec.withServerTimestamps({ updatedAt: null }, [['updatedAt']]);
  assert.throws(() => codec.encode(value, { baseDepth: 29 }), { code: 'user-storage/depth-exceeded' });
  const encoded = encodeValue({});
  let accessed = false;
  Object.defineProperty(encoded.value, encodeKey('updatedAt'), { enumerable: true, get() { accessed = true; return 0; } });
  assert.throws(() => codec.decode(encoded), { code: 'user-storage/invalid-format' });
  assert.equal(accessed, false);
});

test('custom payloadCodec는 기존 호출 계약을 유지하고 비표준 코덱 서버 시각은 명시 거부한다', async () => {
  const f = database(), calls = { encode: 0, decode: 0 };
  const custom = { encode(value, options) { calls.encode++; return encodeValue(value, options); },
    decode(value, options) { calls.decode++; return decodeValue(value, options); } };
  const store = createProfileStore({ database: f.db, payloadCodec: custom });
  assert.equal((await store.createIfAbsent('synthetic', { nickname: '합성' })).created, true);
  assert.equal((await store.update('synthetic', { settings: {} })).value.nickname, '합성');
  assert.ok(calls.encode > 0 && calls.decode > 0);
  await assert.rejects(store.update('synthetic', { updatedAt: null }, { serverTimestampPaths: [['updatedAt']] }),
    { code: 'USER_STORAGE_INVALID_SERVER_TIMESTAMP' });
  assert.equal(f.writes, 2);
});

test('신규 생성은 삭제 generation 경계를 넘어 재적용하지 않는다', async () => {
  const f = database(), profiles = createProfileStore({ database: f.db });
  const raw = createRecordStore({ database: { ref: f.db.ref }, path: 'users', suffix: 'profile' });
  f.beforeCommit = async () => { await raw.delete('synthetic', 0); };
  await assert.rejects(profiles.createIfAbsent('synthetic', { nickname: '늦은 가입' }), { code: 'USER_STORAGE_CONFLICT' });
  const read = await profiles.read('synthetic');
  assert.equal(read.exists, false); assert.equal(read.generation, 1); assert.equal(f.writes, 1);
});

test('생성 승인 시간초과는 결과 미확정이며 동일 연결에서 자동 재시도하지 않는다', async () => {
  const f = database(), gate = deferred();
  f.beforeAck = () => gate.promise;
  const store = createProfileStore({ database: f.db, timeoutMs: 15 });
  await assert.rejects(store.createIfAbsent('synthetic', { nickname: '합성' }), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.createIfAbsent('synthetic', { nickname: '덮어쓰기 금지' }), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  gate.resolve(); assert.equal(f.writes, 1);
});
