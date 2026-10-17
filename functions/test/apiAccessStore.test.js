'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createApiAccessStore } = require('../services/user-storage/apiAccessStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { newKey } = require('../services/card-service/services/cardApiAccess');
const { encodeKey, encodeValue, decodeValue } = require('../services/user-storage/codec');
const origin = 'https://synthetic.example', otherOrigin = 'https://other.example';
const clockTime = 1791760000123;
const options = overrides => ({ label: '합성 키', origins: [origin], minuteLimit: 3, dayLimit: 5, ...overrides });
const keyPath = id => `apiAccess/keys/${encodeKey(id)}`;
const indexPath = value => `apiAccess/origins/${createHash('sha256').update(value).digest('hex')}`;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 같은 서버를 공유하는 별도 SDK 객체의 충돌과 승인 유실을 재현한다.
function database() {
  const records = new Map(), listeners = new Map();
  const f = { records, refs: [], transactions: [], writes: [], beforeCommit: null, beforeGet: null, beforeSet: null, beforeAck: null, initialNull: false };
  function current(path) {
    if (records.has(path)) return clone(records.get(path));
    const children = [...records].filter(([key]) => key.startsWith(`${path}/`));
    if (!children.length) return null;
    return Object.fromEntries(children.map(([key, value]) => [key.slice(path.length + 1), clone(value)]));
  }
  const snapshot = value => ({ val: () => clone(value) });
  f.db = { ref(path) {
    f.refs.push(path);
    return {
      async get() { if (f.beforeGet) await f.beforeGet(path); return snapshot(current(path)); },
      async set(value) {
        if (f.beforeSet) await f.beforeSet(path, value);
        records.set(path, clone(value)); f.writes.push(path);
        if (f.beforeAck) await f.beforeAck(path);
      },
      on(event, callback) {
        assert.equal(event, 'value');
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(callback);
        queueMicrotask(() => { if (listeners.get(path)?.has(callback)) callback(snapshot(current(path))); });
      },
      off(event, callback) { assert.equal(event, 'value'); listeners.get(path)?.delete(callback); },
      async transaction(callback, completion, applyLocally) {
        assert.equal(completion, undefined); assert.equal(applyLocally, false);
        f.transactions.push(path);
        let observed = f.initialNull ? null : current(path);
        for (let retry = 0; retry < 20; retry++) {
          const proposed = callback(observed);
          if (proposed === undefined) return { committed: false, snapshot: snapshot(current(path)) };
          assert.equal(typeof proposed.then, 'undefined');
          if (f.beforeCommit) { const hook = f.beforeCommit; f.beforeCommit = null; await hook(path); }
          if (JSON.stringify(observed) !== JSON.stringify(current(path))) { observed = current(path); continue; }
          records.set(path, clone(proposed)); f.writes.push(path);
          if (f.beforeAck) await f.beforeAck(path);
          return { committed: true, snapshot: snapshot(proposed) };
        }
        throw new Error('합성 CAS 한도');
      },
    };
  } };
  f.other = () => ({ ref: f.db.ref });
  f.store = extra => createApiAccessStore({ database: f.db, clock: () => clockTime, ...extra });
  f.value = id => decodeValue(f.records.get(keyPath(id)).payload);
  f.corrupt = (id, change) => {
    const path = keyPath(id), record = records.get(path), value = f.value(id);
    change(value); records.set(path, { ...record, payload: encodeValue(value) });
  };
  return f;
}

test('API 키·사용량은 키별 경로에 보관하고 비밀 원문과 token은 저장하지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options());
  assert.deepEqual(await store.authenticate(key.token), { id: key.id, ...options(), expiresAt: null, scope: 'getCardInfo', enabled: true,
    secretHash: key.secretHash, createdAt: clockTime });
  assert.equal(f.value(key.id).usage, null);
  assert.equal(await store.allowsPreflight(origin), true);
  assert.equal(await store.allowsPreflight(otherOrigin), false);
  const serialized = JSON.stringify([...f.records]);
  assert.ok(!serialized.includes(key.token)); assert.ok(!serialized.includes(key.token.split('.')[1]));
  assert.ok(f.transactions.every(path => path === keyPath(key.id)));
  assert.ok(f.refs.every(path => path !== 'apiAccess' && path !== 'apiAccess/keys' && path !== 'apiAccess/origins'));
});

test('잘못된 token·ID·origin·설정은 DB 접근 없이 거부한다', async () => {
  const f = database(), store = f.store(), key = newKey();
  for (const token of [undefined, '', 'ygo_bad.secret', key.token.toUpperCase()]) {
    await assert.rejects(store.authenticate(token), { code: 'API_KEY_INVALID', status: 401 });
    await assert.rejects(store.consume(token), { code: 'API_KEY_INVALID', status: 401 });
  }
  for (const id of [undefined, '', '../bad', 'a'.repeat(25)]) {
    await assert.rejects(store.disable(id), { code: 'INVALID_KEY_ID' });
    await assert.rejects(store.rotate({ id, secretHash: key.secretHash }), { code: 'INVALID_KEY_ID' });
  }
  for (const bad of ['null', '*', 'https://synthetic.example/path']) assert.equal(await store.allowsPreflight(bad), false);
  await assert.rejects(store.register(key, options({ origins: ['*'] })), { code: 'INVALID_KEY_OPTIONS' });
  await assert.rejects(store.register({ ...key, secretHash: 'wrong' }, options()), { code: 'INVALID_KEY_ID' });
  assert.equal(f.refs.length, 0);
});

test('미등록과 비밀값 불일치는 401이며 폐기·만료는 기존 403이다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await assert.rejects(store.authenticate(key.token), { code: 'API_KEY_INVALID', status: 401 });
  await store.register(key, options());
  await assert.rejects(store.consume(newKey(key.id).token), { code: 'API_KEY_INVALID', status: 401 });
  f.corrupt(key.id, value => { value.policy.expiresAt = clockTime; });
  await assert.rejects(store.authenticate(key.token), { code: 'API_KEY_DISABLED', status: 403 });
  await assert.rejects(store.consume(key.token), { code: 'API_KEY_DISABLED', status: 403 });
  assert.equal(await store.allowsPreflight(origin), true, '만료 여부는 실제 GET에서 판정하는 기존 OPTIONS 계약');
  await store.disable(key.id);
  assert.equal(await store.allowsPreflight(origin), false);
});

test('origin 거부와 쿼터 초과는 사용량을 늘리지 않고 분·일 제한을 유지한다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options({ minuteLimit: 2, dayLimit: 3 }));
  await assert.rejects(store.consume(key.token, otherOrigin), { code: 'ORIGIN_NOT_ALLOWED', status: 403 });
  assert.equal(f.value(key.id).usage, null);
  assert.deepEqual(await store.consume(key.token, origin), { minuteLimit: 2, minuteRemaining: 1, dayLimit: 3, dayRemaining: 2 });
  await store.consume(key.token);
  const before = clone(f.records.get(keyPath(key.id)));
  await assert.rejects(store.consume(key.token), error => error.code === 'RATE_LIMIT_EXCEEDED' && error.status === 429
    && error.retryAfter === Math.ceil(((Math.floor(clockTime / 60000) + 1) * 60000 - clockTime) / 1000));
  assert.deepEqual(f.records.get(keyPath(key.id)), before);
  const nextMinute = f.store({ clock: () => clockTime + 60000 });
  assert.equal((await nextMinute.consume(key.token)).dayRemaining, 0);
  await assert.rejects(nextMinute.consume(key.token), error => error.code === 'RATE_LIMIT_EXCEEDED'
    && error.retryAfter === Math.ceil(((Math.floor(clockTime / 86400000) + 1) * 86400000 - clockTime - 60000) / 1000));
});

test('정확한 unlimited는 해당 기간만 제한하지 않고 모든 소비를 집계한다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options({ minuteLimit: 'unlimited', dayLimit: 2 }));
  assert.deepEqual(await store.consume(key.token), { minuteLimit: 'unlimited', minuteRemaining: 'unlimited', dayLimit: 2, dayRemaining: 1 });
  await store.consume(key.token);
  await assert.rejects(store.consume(key.token), { code: 'RATE_LIMIT_EXCEEDED' });
  assert.equal(f.value(key.id).usage.minuteCount, 2);
  const all = newKey(); await store.register(all, options({ minuteLimit: 'unlimited', dayLimit: 'unlimited' }));
  assert.deepEqual(await store.consume(all.token), { minuteLimit: 'unlimited', minuteRemaining: 'unlimited', dayLimit: 'unlimited', dayRemaining: 'unlimited' });
});

test('새 날짜는 두 기간 카운터를 초기화하고 서버 시각을 기준으로 소비한다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options()); await store.consume(key.token);
  const timestamp = (Math.floor(clockTime / 86400000) + 1) * 86400000;
  const next = f.store({ clock: () => timestamp });
  await next.consume(key.token);
  assert.deepEqual(f.value(key.id).usage, { minute: Math.floor(timestamp / 60000), day: Math.floor(timestamp / 86400000), minuteCount: 1, dayCount: 1 });
});

test('다른 연결의 소비가 먼저 확정되면 최신 사용량으로 재시도하며 제한을 넘지 않는다', async () => {
  const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey();
  await first.register(key, options({ minuteLimit: 1 }));
  f.beforeCommit = async () => { await second.consume(key.token); };
  await assert.rejects(first.consume(key.token), { code: 'RATE_LIMIT_EXCEEDED' });
  assert.equal(f.value(key.id).usage.minuteCount, 1);
});

test('소비 중 폐기가 먼저 확정되면 늦은 소비를 거부하고 키를 부활시키지 않는다', async () => {
  const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey();
  await first.register(key, options());
  f.beforeCommit = async () => { await second.disable(key.id); };
  await assert.rejects(first.consume(key.token), { code: 'API_KEY_DISABLED' });
  assert.equal(f.value(key.id).usage, null); assert.equal(f.value(key.id).policy.enabled, false);
});

test('키 교체가 먼저 확정되면 구 token 소비는 401이고 기존 사용량은 유지된다', async () => {
  const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey(), next = newKey(key.id);
  await first.register(key, options()); await first.consume(key.token);
  f.beforeCommit = async () => { await second.rotate(next); };
  await assert.rejects(first.consume(key.token), { code: 'API_KEY_INVALID' });
  assert.equal(f.value(key.id).usage.minuteCount, 1);
  assert.equal((await first.consume(next.token)).minuteRemaining, 1);
});

test('소비와 경합한 폐기·교체는 최신 사용량을 덮어쓰지 않는다', async () => {
  for (const operation of ['disable', 'rotate']) {
    const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey(), next = newKey(key.id);
    await first.register(key, options());
    f.beforeCommit = async () => { await second.consume(key.token); };
    await first[operation](operation === 'disable' ? key.id : next);
    assert.equal(f.value(key.id).usage.minuteCount, 1);
    assert.equal(f.value(key.id).policy.enabled, operation !== 'disable');
    if (operation === 'rotate') assert.equal(f.value(key.id).policy.secretHash, next.secretHash);
  }
});

test('폐기가 교체보다 먼저 확정되면 교체를 재적용하지 않는다', async () => {
  const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey();
  await first.register(key, options());
  f.beforeCommit = async () => { await second.disable(key.id); };
  await assert.rejects(first.rotate(newKey(key.id)), { code: 'API_KEY_DISABLED' });
  assert.equal(f.value(key.id).policy.secretHash, key.secretHash);
});

test('동일 ID 동시 등록은 한 키만 활성화하고 다른 origin 후보는 권한이 되지 않는다', async () => {
  const f = database(), first = f.store(), second = f.store({ database: f.other() }), key = newKey(), rival = newKey(key.id);
  f.beforeCommit = async () => { await second.register(rival, options({ origins: [otherOrigin] })); };
  await assert.rejects(first.register(key, options()), { code: 'KEY_ALREADY_EXISTS', status: 409 });
  assert.equal(await first.allowsPreflight(origin), false); assert.equal(await first.allowsPreflight(otherOrigin), true);
  await assert.rejects(first.authenticate(key.token), { code: 'API_KEY_INVALID' });
  assert.equal((await first.authenticate(rival.token)).id, key.id);
});

test('폐기·삭제 이력이 있는 ID는 다시 등록하지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options()); await store.disable(key.id);
  await assert.rejects(store.register(newKey(key.id), options()), { code: 'KEY_ALREADY_EXISTS' });
  const records = createRecordStore({ database: f.db, path: 'apiAccess/keys' });
  await records.delete(key.id, (await records.read(key.id)).revision);
  await assert.rejects(store.register(newKey(key.id), options()), { code: 'KEY_ALREADY_EXISTS' });
});

test('origin 후보 쓰기가 실패하면 실제 키를 활성화하지 않고 후보만으로 허용하지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey();
  f.beforeSet = async path => { if (path.startsWith(indexPath(otherOrigin))) throw Object.assign(new Error('합성 거부'), { code: 'PERMISSION_DENIED' }); };
  await assert.rejects(store.register(key, options({ origins: [origin, otherOrigin] })), { code: 'PERMISSION_DENIED' });
  assert.ok(!f.records.has(keyPath(key.id))); assert.equal(f.transactions.length, 0);
  assert.equal(await store.allowsPreflight(origin), false);
});

test('다른 origin·미등록·폐기 후보는 실제 키 정책 검사 없이 CORS를 허용하지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey(), absent = newKey();
  await store.register(key, options());
  f.records.set(`${indexPath(otherOrigin)}/${key.id}`, true);
  f.records.set(`${indexPath(otherOrigin)}/${absent.id}`, true);
  assert.equal(await store.allowsPreflight(otherOrigin), false);
  await store.disable(key.id); assert.equal(await store.allowsPreflight(origin), false);
  assert.ok(f.records.has(`${indexPath(origin)}/${key.id}`), '비활성 후보가 남더라도 허용하지 않는다');
});

test('같은 origin의 다른 활성 키는 유지하고 빈 origin 키는 서버 요청만 허용한다', async () => {
  const f = database(), store = f.store(), first = newKey(), second = newKey(), server = newKey();
  await store.register(first, options()); await store.register(second, options());
  await store.disable(first.id); assert.equal(await store.allowsPreflight(origin), true);
  await store.disable(second.id); assert.equal(await store.allowsPreflight(origin), false);
  await store.register(server, options({ origins: [] }));
  assert.deepEqual((await store.authenticate(server.token)).origins, []);
  assert.equal((await store.authenticate(server.token)).expiresAt, null);
  await store.consume(server.token);
  await assert.rejects(store.consume(server.token, origin), { code: 'ORIGIN_NOT_ALLOWED' });
  assert.equal(await store.allowsPreflight(origin), false);
});

test('한 키의 승인 대기 중에도 다른 키 소비는 별도 CAS로 완료한다', async () => {
  const f = database(), store = f.store(), first = newKey(), second = newKey(), ready = deferred(), release = deferred();
  await store.register(first, options()); await store.register(second, options());
  f.beforeCommit = async path => { assert.equal(path, keyPath(first.id)); ready.resolve(); await release.promise; };
  const pending = store.consume(first.token); await ready.promise;
  assert.equal((await store.consume(second.token)).minuteRemaining, 2);
  assert.equal(f.value(first.id).usage, null);
  release.resolve(); assert.equal((await pending).minuteRemaining, 2);
  assert.ok(f.transactions.every(path => [keyPath(first.id), keyPath(second.id)].includes(path)));
});

test('같은 SDK 연결을 공유하는 저장소의 동시 8개 소비는 FIFO로 모두 완료한다', async () => {
  const f = database(), first = f.store(), second = f.store({ maxAttempts: 1 }), key = newKey();
  await first.register(key, options({ minuteLimit: 60, dayLimit: 5000 }));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? second : first).consume(key.token)));
  assert.deepEqual(results.map(result => result.minuteRemaining), [59, 58, 57, 56, 55, 54, 53, 52]);
  assert.equal(f.value(key.id).usage.minuteCount, 8);
  assert.equal(f.value(key.id).usage.dayCount, 8);
  assert.equal(f.transactions.length, 9, '등록 1회와 소비 8회이며 자기 충돌 재시도가 없다');
});

test('같은 연결의 등록·소비·교체·폐기는 호출 순서를 따르고 대기 입력을 다시 읽지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey(), next = newKey(key.id), stableNext = { ...next };
  const ready = deferred(), release = deferred();
  f.beforeCommit = async () => { ready.resolve(); await release.promise; };
  const registered = store.register(key, options()); await ready.promise;
  const operations = [store.consume(key.token), store.rotate(next), store.consume(stableNext.token), store.disable(key.id), store.consume(stableNext.token)];
  const outcomes = Promise.allSettled(operations);
  next.id = newKey().id; next.secretHash = 'bad';
  release.resolve(); await registered;
  const results = await outcomes;
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[4].reason.code, 'API_KEY_DISABLED');
  assert.equal(f.value(key.id).usage.minuteCount, 2);
  assert.equal(f.value(key.id).policy.secretHash, stableNext.secretHash);
  assert.equal(f.value(key.id).policy.enabled, false);
  assert.equal(f.records.has(keyPath(next.id)), false);
});

test('같은 키 대기 시간초과는 서버에 제출하지 않고 앞 작업 완료 후에도 늦게 실행하지 않는다', async () => {
  const f = database(), first = f.store({ timeoutMs: 1000 }), waiting = f.store({ timeoutMs: 20 }), key = newKey();
  const ready = deferred(), release = deferred();
  await first.register(key, options());
  f.beforeCommit = async () => { ready.resolve(); await release.promise; };
  const pending = first.consume(key.token); await ready.promise;
  const refsBefore = f.refs.length, transactionsBefore = f.transactions.length;
  const results = await Promise.allSettled([waiting.consume(key.token), waiting.disable(key.id), waiting.rotate(newKey(key.id)),
    waiting.register(newKey(key.id), options({ origins: [otherOrigin] }))]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'USER_STORAGE_QUEUE_TIMEOUT'));
  assert.equal(f.refs.length, refsBefore); assert.equal(f.transactions.length, transactionsBefore);
  release.resolve(); await pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.value(key.id).usage.minuteCount, 1);
  assert.equal(f.value(key.id).policy.enabled, true); assert.equal(f.value(key.id).policy.secretHash, key.secretHash);
  assert.equal(f.records.has(`${indexPath(otherOrigin)}/${key.id}`), false);
  assert.equal(f.transactions.length, transactionsBefore, '취소된 큐 항목은 나중에도 CAS를 제출하지 않는다');
  assert.equal((await waiting.consume(key.token)).minuteRemaining, 1, '대기 취소만으로 연결을 미확정 상태로 차단하지 않는다');
});

test('손상된 정책·사용량·후보 인덱스는 503이며 카운터를 0으로 덮어쓰지 않는다', async () => {
  for (const damage of [value => { value.usage.minuteCount = -1; }, value => { value.usage.dayCount = 1.5; },
    value => { delete value.usage.day; }, value => { value.policy.enabled = 'true'; }, value => { value.policy.origins = ['*']; }]) {
    const f = database(), store = f.store(), key = newKey();
    await store.register(key, options()); await store.consume(key.token); f.corrupt(key.id, damage);
    const before = clone(f.records.get(keyPath(key.id)));
    await assert.rejects(store.consume(key.token), { code: 'API_UNAVAILABLE', status: 503 });
    await assert.rejects(store.allowsPreflight(origin), { code: 'API_UNAVAILABLE', status: 503 });
    assert.deepEqual(f.records.get(keyPath(key.id)), before);
  }
  const f = database(), store = f.store(); f.records.set(`${indexPath(origin)}/bad`, true);
  await assert.rejects(store.allowsPreflight(origin), { code: 'API_UNAVAILABLE' });
});

test('현재 기간의 안전 정수 카운터 한도에서는 무제한 키도 증가를 거부한다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await store.register(key, options({ minuteLimit: 'unlimited', dayLimit: 'unlimited' })); await store.consume(key.token);
  f.corrupt(key.id, value => { value.usage.minuteCount = Number.MAX_SAFE_INTEGER; });
  await assert.rejects(store.consume(key.token), { code: 'API_UNAVAILABLE' });
  assert.equal(f.value(key.id).usage.minuteCount, Number.MAX_SAFE_INTEGER);
});

test('SDK 최초 null은 이미 존재하는 키를 새 정책·빈 사용량으로 바꾸지 않는다', async () => {
  const f = database(), store = f.store({ maxAttempts: 1 }), key = newKey();
  await store.register(key, options()); await store.consume(key.token);
  const before = clone(f.records.get(keyPath(key.id))); f.initialNull = true;
  await assert.rejects(store.consume(key.token), { code: 'USER_STORAGE_CONFLICT' });
  assert.deepEqual(f.records.get(keyPath(key.id)), before);
});

test('await 이후 입력을 바꾸어도 검증한 ID·비밀 해시·origin으로만 등록한다', async () => {
  const f = database(), store = f.store(), key = newKey(), input = options(), ready = deferred(), release = deferred();
  const original = { ...key };
  f.beforeGet = async () => { ready.resolve(); await release.promise; };
  const pending = store.register(key, input); await ready.promise;
  key.id = newKey().id; key.secretHash = 'bad'; input.origins[0] = otherOrigin; input.label = '변경';
  release.resolve(); await pending;
  assert.equal((await store.authenticate(original.token)).label, '합성 키');
  assert.equal(await store.allowsPreflight(origin), true); assert.equal(await store.allowsPreflight(otherOrigin), false);
});

test('origin 후보 승인 유실은 키 활성화를 막고 공유 연결을 차단한다', async () => {
  const f = database(), ack = deferred(), key = newKey(); let ambiguous = 0;
  const store = f.store({ timeoutMs: 20, onAmbiguousWrite: () => { ambiguous++; } });
  const sibling = createRecordStore({ database: f.db, path: 'users', suffix: 'profile', timeoutMs: 20 });
  f.beforeAck = () => ack.promise;
  await assert.rejects(store.register(key, options()), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(f.transactions.length, 0); assert.equal(ambiguous, 1);
  await assert.rejects(store.allowsPreflight(origin), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(sibling.read('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  ack.resolve(); await new Promise(resolve => setImmediate(resolve));
  const replacement = f.store({ database: f.other() });
  assert.equal(await replacement.allowsPreflight(origin), false);
  await assert.rejects(replacement.authenticate(key.token), { code: 'API_KEY_INVALID' });
});

test('소비 승인 유실은 성공·자동 재시도하지 않고 새 연결에서 확정 사용량을 대조한다', async () => {
  const f = database(), ack = deferred(), store = f.store({ timeoutMs: 20 }), key = newKey();
  await store.register(key, options()); f.beforeAck = () => ack.promise;
  await assert.rejects(store.consume(key.token), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(f.value(key.id).usage.minuteCount, 1);
  await assert.rejects(store.consume(key.token), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.disable(key.id), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  ack.resolve(); await new Promise(resolve => setImmediate(resolve)); f.beforeAck = null;
  const replacement = f.store({ database: f.other() });
  assert.equal((await replacement.consume(key.token)).minuteRemaining, 1);
});

test('미등록 폐기·교체와 잘못된 시각은 새 키를 만들지 않는다', async () => {
  const f = database(), store = f.store(), key = newKey();
  await assert.rejects(store.disable(key.id), { code: 'KEY_NOT_FOUND', status: 404 });
  await assert.rejects(store.rotate(key), { code: 'KEY_NOT_FOUND', status: 404 });
  await assert.rejects(f.store({ clock: () => NaN }).register(key, options()), { code: 'API_UNAVAILABLE' });
  assert.equal(f.writes.length, 0);
});
