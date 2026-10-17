'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { createMembershipStore, membershipVersion } = require('../services/user-storage/membershipStore');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const uid = 'synthetic-member', time = 1791760000123, nonce = 'a'.repeat(64), secondNonce = 'b'.repeat(64);
const state = (overrides = {}) => ({ nonceHash: nonce, startedAt: time, expiresAt: time + 300000, localOnly: false, ...overrides });
const source = (provider = 'youtube', overrides = {}) => ({ status: 'active', type: provider === 'youtube' ? 'csv' : 'discord',
  levelName: '합성 회원', ...(provider === 'youtube' ? { userChannelId: `UC${'a'.repeat(22)}` } : { discordId: '12345678901234567' }),
  verificationVersion: 2, verificationProvider: provider, lastChecked: time + 1, ...overrides });

// UID 부모와 profile 자식 사이의 실제 RTDB transaction 충돌을 합성한다.
function fixture() {
  let root = {}, beforeCommit, beforeAck, nullSnapshot = false;
  const events = [], snapshot = value => ({ val: () => clone(value) });
  const get = path => path.split('/').reduce((value, key) => value?.[key], root) ?? null;
  const set = (path, value) => {
    const parts = path.split('/'); let node = root;
    for (const key of parts.slice(0, -1)) node = node[key] ??= {};
    node[parts.at(-1)] = clone(value);
  };
  const database = { ref(path) {
    events.push({ type: 'ref', path });
    return {
      async get() { return snapshot(get(path)); },
      on(_event, fn) { queueMicrotask(() => fn(snapshot(get(path)))); }, off() {},
      async transaction(fn, done, applyLocally) {
        assert.equal(done, undefined); assert.equal(applyLocally, false);
        events.push({ type: 'transaction', path });
        let observed = clone(get(path));
        if (nullSnapshot) { nullSnapshot = false; if (fn(null) === undefined) return { committed: false, snapshot: snapshot(get(path)) }; }
        for (let retry = 0; retry < 20; retry++) {
          const next = fn(clone(observed));
          if (next === undefined) return { committed: false, snapshot: snapshot(get(path)) };
          assert.equal(typeof next.then, 'undefined');
          if (beforeCommit) { const hook = beforeCommit; beforeCommit = undefined; await hook(path); }
          if (JSON.stringify(observed) !== JSON.stringify(get(path))) { observed = clone(get(path)); continue; }
          set(path, next);
          if (beforeAck) await beforeAck();
          return { committed: true, snapshot: snapshot(get(path)) };
        }
        throw new Error('합성 재시도 한도');
      },
    };
  } };
  return { database, events, get, set, get root() { return root; }, set root(value) { root = value; },
    set beforeCommit(value) { beforeCommit = value; }, set beforeAck(value) { beforeAck = value; },
    set nullSnapshot(value) { nullSnapshot = value; } };
}

async function ready(store, provider = 'youtube', overrides = {}) {
  await store.start(uid, provider, state(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/', ...overrides } : overrides));
  await store.consume(uid, provider, overrides.nonceHash ?? nonce, time + 1);
}

test('인증 시작·소비·완료는 UID 부모만 변경하며 원문 token/code를 저장하지 않는다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  assert.deepEqual(await store.read(uid), { membership: undefined, version: '0' });
  await ready(store);
  const result = await store.complete(uid, 'youtube', nonce, source(), time + 2);
  assert.deepEqual(result, { membership: source(), version: membershipVersion(source()), stored: true });
  assert.deepEqual(await store.read(uid), { membership: source(), version: result.version });
  assert.ok(f.events.filter(event => event.type === 'transaction').every(event => event.path === `users/${encodeKey(uid)}`));
  assert.doesNotMatch(JSON.stringify(f.root), /accessToken|verificationId|clientSecret|"code"/);
  await assert.rejects(store.consume(uid, 'youtube', nonce, time + 3), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  await assert.rejects(store.complete(uid, 'youtube', nonce, source(), time + 3), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
});

test('provider 전환은 기존 멤버십을 전체 교체하고 다른 프로필 필드·서버 시각을 보존한다', async () => {
  const f = fixture(), profiles = createProfileStore({ database: f.database }), store = createMembershipStore({ database: f.database });
  await profiles.update(uid, { displayName: '합성 사용자', createdAt: new Timestamp(123, 456000000), settings: { theme: 'dark', membership: source('discord') } });
  const before = await profiles.read(uid);
  await ready(store);
  await store.complete(uid, 'youtube', nonce, source(), time + 2);
  const after = await profiles.read(uid);
  assert.deepEqual(after.value, { displayName: '합성 사용자', createdAt: new Timestamp(123, 456000000), settings: { theme: 'dark', membership: source() } });
  assert.equal(after.revision, before.revision + 1); assert.equal(after.generation, before.generation);
  assert.equal(Object.hasOwn(after.value.settings.membership, 'discordId'), false);
});

test('동시 설정 저장 후 콜백 재실행은 최신 설정을 보존하면서 멤버십을 기록한다', async () => {
  const f = fixture(), profiles = createProfileStore({ database: f.database }), store = createMembershipStore({ database: f.database });
  await profiles.update(uid, { settings: { theme: 'light' } });
  await ready(store);
  f.beforeCommit = () => profiles.update(uid, { settings: { theme: 'dark' } });
  await store.complete(uid, 'youtube', nonce, source(), time + 2);
  assert.deepEqual((await profiles.read(uid)).value.settings, { theme: 'dark', membership: source() });
  assert.equal((await profiles.read(uid)).revision, 3);
});

test('서로 다른 UID와 provider의 진행 상태는 독립적이다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  await store.start(uid, 'youtube', state());
  await store.start('synthetic-other', 'youtube', state());
  await store.start(uid, 'discord', state({ redirectUri: 'https://ygo-synapse.web.app/' }));
  await store.consume(uid, 'youtube', nonce, time + 1);
  assert.equal(f.get(`users/${encodeKey('synthetic-other')}/verification/youtube`).consumed, false);
  assert.equal(f.get(`users/${encodeKey(uid)}/verification/discord`).consumed, false);
});

test('3초 재시도 제한과 5분 만료 경계를 보존한다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  await store.start(uid, 'youtube', state());
  await assert.rejects(store.start(uid, 'youtube', state({ nonceHash: secondNonce, startedAt: time + 2999, expiresAt: time + 302999 })), { code: 'MEMBERSHIP_TOO_MANY_REQUESTS' });
  await store.start(uid, 'youtube', state({ nonceHash: secondNonce, startedAt: time + 3000, expiresAt: time + 303000 }));
  await assert.rejects(store.consume(uid, 'youtube', nonce, time + 3001), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  await assert.rejects(store.consume(uid, 'youtube', secondNonce, time + 303000), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
});

test('동시 소비는 정확히 하나만 성공하고 완료 직전 새 nonce와 만료도 재검사한다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  await store.start(uid, 'youtube', state());
  const consumed = await Promise.allSettled([store.consume(uid, 'youtube', nonce, time + 1), store.consume(uid, 'youtube', nonce, time + 1)]);
  assert.equal(consumed.filter(result => result.status === 'fulfilled').length, 1);
  f.beforeCommit = () => store.start(uid, 'youtube', state({ nonceHash: secondNonce, startedAt: time + 3000, expiresAt: time + 303000 }));
  await assert.rejects(store.complete(uid, 'youtube', nonce, source(), time + 2), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  assert.equal((await store.read(uid)).membership, undefined);
  await store.consume(uid, 'youtube', secondNonce, time + 3001);
  await assert.rejects(store.complete(uid, 'youtube', secondNonce, source(), time + 303000), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
});

test('localOnly 완료는 진행만 종료하고 기존 프로필과 다른 사용자를 변경하지 않는다', async () => {
  const f = fixture(), profiles = createProfileStore({ database: f.database }), store = createMembershipStore({ database: f.database });
  await profiles.update(uid, { settings: { membership: source('discord') } });
  const before = f.get(`users/${encodeKey(uid)}/profile`);
  await ready(store, 'youtube', { localOnly: true });
  const completed = await store.complete(uid, 'youtube', nonce, source(), time + 2);
  assert.equal(completed.stored, false);
  assert.deepEqual(f.get(`users/${encodeKey(uid)}/profile`), before);
  assert.deepEqual(completed.membership, source('discord'));
});

test('콜백 재실행 시 만료 시각을 다시 확인하여 늦은 완료를 저장하지 않는다', async () => {
  const f = fixture(), profiles = createProfileStore({ database: f.database });
  let currentTime = time + 2;
  const store = createMembershipStore({ database: f.database, now: () => currentTime });
  await ready(store);
  f.beforeCommit = async () => { await profiles.update(uid, { settings: { theme: 'dark' } }); currentTime = time + 300000; };
  await assert.rejects(store.complete(uid, 'youtube', nonce, source()), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  assert.equal((await store.read(uid)).membership, undefined);
  assert.equal((await profiles.read(uid)).value.settings.theme, 'dark');
});

test('삭제 세대가 바뀌면 이전 인증 완료가 새 프로필을 덮어쓰지 못한다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  await ready(store);
  f.set(`users/${encodeKey(uid)}/profile`, { format: 1, revision: 2, generation: 1, tombstone: false, payload: encodeValue({ settings: { theme: 'dark' } }) });
  await assert.rejects(store.complete(uid, 'youtube', nonce, source(), time + 2), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  assert.equal((await store.read(uid)).membership, undefined);
});

test('관측 후 최초 null snapshot을 받으면 기존 데이터를 지우지 않는다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  await store.start(uid, 'youtube', state());
  const before = clone(f.root); f.nullSnapshot = true;
  await assert.rejects(store.consume(uid, 'youtube', nonce, time + 1), { code: 'USER_STORAGE_CONFLICT' });
  assert.deepEqual(f.root, before);
});

test('형식이 잘못된 입력과 비밀 필드는 DB 접근 전에 거부한다', async () => {
  const f = fixture(), store = createMembershipStore({ database: f.database });
  for (const invalid of [state({ accessToken: 'synthetic' }), state({ nonceHash: 'token' }), state({ expiresAt: time + 1 }),
    state({ consumed: true }), state({ localOnly: 'true' })]) await assert.rejects(store.start(uid, 'youtube', invalid), { code: 'USER_STORAGE_INVALID_MEMBERSHIP_STATE' });
  for (const invalid of [source('discord'), source('youtube', { accessToken: 'synthetic' }), source('youtube', { verificationVersion: 1 })]) {
    await assert.rejects(store.complete(uid, 'youtube', nonce, invalid, time + 1), { code: 'USER_STORAGE_INVALID_MEMBERSHIP' });
  }
  for (const invalid of ['', undefined, 'x'.repeat(129), '\ud800']) await assert.rejects(store.read(invalid), { code: 'USER_STORAGE_INVALID_MEMBERSHIP_STATE' });
  const accessor = state(); Object.defineProperty(accessor, 'nonceHash', { enumerable: true, get() { assert.fail('접근자 실행 금지'); } });
  await assert.rejects(store.start(uid, 'youtube', accessor), { code: 'USER_STORAGE_INVALID_MEMBERSHIP_STATE' });
  assert.equal(f.events.length, 0);
});

test('손상된 프로필과 진행 상태는 복구한 것으로 취급하지 않고 보존한다', async () => {
  for (const broken of [{ profile: { format: 999 } }, { verification: { youtube: { nonceHash: nonce } } },
    { profile: { format: 1, revision: 1, generation: 0, tombstone: false, payload: encodeValue([]) } }]) {
    const f = fixture(), store = createMembershipStore({ database: f.database });
    f.set(`users/${encodeKey(uid)}`, broken); const before = clone(f.root);
    await assert.rejects(store.start(uid, 'youtube', state()));
    assert.deepEqual(f.root, before);
  }
});

test('멤버십 버전은 속성 순서에 무관하며 원본 변경을 구분한다', () => {
  assert.equal(membershipVersion(undefined), '0');
  assert.equal(membershipVersion(source()), membershipVersion(Object.fromEntries(Object.entries(source()).reverse())));
  assert.notEqual(membershipVersion(source()), membershipVersion(source('youtube', { status: 'none', levelName: '일반' })));
});

test('쓰기 응답 시간초과는 공유 저장소를 미확정 상태로 막고 지연 성공을 반환하지 않는다', async () => {
  const f = fixture(); let ambiguous = 0;
  const store = createMembershipStore({ database: f.database, timeoutMs: 10, onAmbiguousWrite: () => { ambiguous++; } });
  f.beforeAck = () => new Promise(() => {});
  await assert.rejects(store.start(uid, 'youtube', state()), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(createProfileStore({ database: f.database }).read(uid), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(store.read(uid), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(ambiguous, 1);
});
