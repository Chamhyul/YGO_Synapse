'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUserStorageConnection } = require('../config/userStorage');
const { createApiAccessStore } = require('../services/user-storage/apiAccessStore');
const { newKey } = require('../services/cardApiAccess');
const { encodeKey, decodeValue } = require('../services/user-storage/codec');

const connections = [];
const open = () => { const connection = createUserStorageConnection(); connections.push(connection); return connection; };
const inspector = open();
const keyPath = id => `apiAccess/keys/${encodeKey(id)}`;
const originPath = origin => `apiAccess/origins/${createHash('sha256').update(origin).digest('hex')}`;
const raw = async id => (await inspector.database.ref(keyPath(id)).get()).val();
const value = async id => decodeValue((await raw(id)).payload);
const clock = () => Date.UTC(2030, 0, 1, 0, 0, 30);
const create = database => createApiAccessStore({ database: database || open().database, clock, maxAttempts: 10 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
after(() => Promise.all(connections.map(connection => connection.close())));

function trackedDatabase(database, hook = (_event, invoke) => invoke()) {
  const events = [];
  return { events, database: new Proxy(database, { get(target, name) {
    if (name === 'ref') return path => {
      const ref = target.ref(path);
      return new Proxy(ref, { get(reference, method) {
        const result = Reflect.get(reference, method, reference);
        if (typeof result !== 'function') return result;
        if (!['get', 'on', 'off', 'transaction', 'set', 'update', 'remove'].includes(method)) return result.bind(reference);
        return (...args) => { const event = { method, path }; events.push(event); return hook(event, () => result.apply(reference, args)); };
      } });
    };
    const result = Reflect.get(target, name, target); return typeof result === 'function' ? result.bind(target) : result;
  } }) };
}

test('RTDB API 접근은 키별 고정 레코드·Origin 후보만 사용하며 원문 비밀과 전체 트리를 저장·조회하지 않는다', async () => {
  const tracked = trackedDatabase(open().database), store = create(tracked.database), key = newKey();
  const origin = `https://synthetic-store-${key.id}.invalid`;
  await store.register(key, { label: '합성 경로 검사', origins: [origin] });
  assert.equal((await store.authenticate(key.token)).id, key.id);
  assert.equal(await store.allowsPreflight(origin), true);
  await store.consume(key.token, origin);
  const record = await raw(key.id), item = decodeValue(record.payload);
  assert.equal(record.format, 1); assert.equal(record.tombstone, false);
  assert.equal(item.policy.expiresAt, null); assert.equal(item.usage.dayCount, 1);
  assert.ok(tracked.events.every(event => event.path === keyPath(key.id)
    || event.path === originPath(origin) || event.path === `${originPath(origin)}/${key.id}`));
  const stored = JSON.stringify(record);
  assert.equal(stored.includes(key.token), false); assert.equal(stored.includes(key.token.split('.')[1]), false);
});

test('RTDB API 독립 SDK 연결의 동시 소비는 하나의 공유 한도를 정확히 집행한다', async () => {
  const first = create(), second = create(), key = newKey();
  await first.register(key, { label: '합성 병렬 쿼터', minuteLimit: 3, dayLimit: 4 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : second).consume(key.token).then(result => ({ result }), error => ({ error }))));
  assert.equal(results.filter(item => item.result).length, 3);
  for (const item of results.filter(item => item.error)) assert.equal(item.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.deepEqual(results.filter(item => item.result).map(item => item.result.minuteRemaining).sort(), [0, 1, 2]);
  const usage = (await value(key.id)).usage;
  assert.equal(usage.minuteCount, 3); assert.equal(usage.dayCount, 3);
  const replacement = newKey(key.id); await second.rotate(replacement);
  await assert.rejects(first.consume(replacement.token), { status: 429, code: 'RATE_LIMIT_EXCEEDED' });
  assert.deepEqual((await value(key.id)).usage, usage);
});

for (const action of ['disable', 'rotate']) {
  test(`RTDB API 소비 직전 ${action}가 먼저 확정되면 독립 연결의 지연 요청은 최신 키를 재검사한다`, { timeout: 15000 }, async () => {
    const readReady = deferred(), release = deferred(); let pause = false;
    const tracked = trackedDatabase(open().database, (event, invoke) => {
      if (!pause || event.method !== 'get') return invoke();
      pause = false;
      return Promise.resolve(invoke()).then(async snapshot => { readReady.resolve(); await release.promise; return snapshot; });
    });
    const delayed = create(tracked.database), other = create(), key = newKey();
    await other.register(key, { label: '합성 키 변경 경쟁' });
    assert.equal((await delayed.authenticate(key.token)).id, key.id);
    pause = true;
    const consuming = delayed.consume(key.token);
    const rejected = assert.rejects(consuming, action === 'disable'
      ? { status: 403, code: 'API_KEY_DISABLED' } : { status: 401, code: 'API_KEY_INVALID' });
    try {
      await readReady.promise;
      if (action === 'disable') await other.disable(key.id); else await other.rotate(newKey(key.id));
    } finally { release.resolve(); }
    await rejected;
    assert.equal((await value(key.id)).usage, null);
  });
}

test('RTDB API 먼저 확정된 사용량은 중지·교체 뒤에도 보존한다', async () => {
  const first = create(), second = create(), key = newKey();
  await first.register(key, { label: '합성 확정 순서' });
  await first.consume(key.token);
  const used = (await value(key.id)).usage;
  const replacement = newKey(key.id); await second.rotate(replacement);
  await assert.rejects(first.consume(key.token), { status: 401 });
  assert.deepEqual((await value(key.id)).usage, used);
  await second.disable(key.id);
  await assert.rejects(first.consume(replacement.token), { status: 403 });
  assert.deepEqual((await value(key.id)).usage, used);
});

test('RTDB CORS 후보 인덱스는 단독 권한이 아니며 여러 키 중 마지막 활성 키 중지 후 거부한다', async () => {
  const store = create(), first = newKey(), second = newKey(), absent = newKey();
  const origin = `https://synthetic-origin-${first.id}.invalid`;
  await inspector.database.ref(`${originPath(origin)}/${absent.id}`).set(true);
  assert.equal(await store.allowsPreflight(origin), false);
  await store.register(first, { label: '합성 다른 Origin', origins: [] });
  await inspector.database.ref(`${originPath(origin)}/${first.id}`).set(true);
  assert.equal(await store.allowsPreflight(origin), false);
  await store.register(second, { label: '합성 활성 Origin', origins: [origin] });
  assert.equal(await store.allowsPreflight(origin), true);
  await store.disable(second.id);
  assert.equal(await store.allowsPreflight(origin), false);
  assert.equal(await store.allowsPreflight('null'), false);
});

test('RTDB CORS 후보 작성 뒤 키 등록 실패는 키를 활성화하거나 사전 요청을 허용하지 않는다', async () => {
  const tracked = trackedDatabase(open().database, (event, invoke) => {
    if (event.method === 'transaction') throw new Error('synthetic-registration-failure');
    return invoke();
  });
  const broken = create(tracked.database), other = create(), key = newKey();
  const origin = `https://synthetic-failed-register-${key.id}.invalid`;
  await assert.rejects(broken.register(key, { label: '합성 등록 실패', origins: [origin] }), /synthetic-registration-failure/);
  assert.equal(await raw(key.id), null);
  assert.equal(await other.allowsPreflight(origin), false);
  await assert.rejects(other.authenticate(key.token), { status: 401 });
});
