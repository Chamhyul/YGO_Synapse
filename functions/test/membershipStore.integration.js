'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUserStorageConnection } = require('../config/userStorage');
const { createMembershipStore, membershipVersion } = require('../services/user-storage/membershipStore');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { encodeKey } = require('../services/user-storage/codec');
const connections = [];
const open = () => { const connection = createUserStorageConnection(); connections.push(connection); return connection; };
const main = open(), time = 1791760000123;
const nonce = name => createHash('sha256').update(`synthetic-membership:${name}`).digest('hex');
const state = (name, overrides = {}) => ({ nonceHash: nonce(name), startedAt: time, expiresAt: time + 300000, localOnly: false, ...overrides });
const membership = (provider = 'youtube') => ({ status: 'active', type: provider === 'youtube' ? 'csv' : 'discord', levelName: '합성 회원',
  ...(provider === 'youtube' ? { userChannelId: `UC${'z'.repeat(22)}` } : { discordId: '12345678901234567' }),
  verificationVersion: 2, verificationProvider: provider, lastChecked: time + 2 });
const raw = async uid => (await main.database.ref(`users/${encodeKey(uid)}`).get()).val();
after(() => Promise.all(connections.map(connection => connection.close())));

test('RTDB 멤버십은 인증 상태와 프로필을 같은 UID에서 원자 완료하고 원문 비밀을 저장하지 않는다', async () => {
  const uid = 'synthetic-membership-shape', store = createMembershipStore({ database: open().database });
  await store.start(uid, 'youtube', state('shape'));
  await store.consume(uid, 'youtube', nonce('shape'), time + 1);
  const result = await store.complete(uid, 'youtube', nonce('shape'), membership(), time + 2);
  assert.deepEqual(result, { membership: membership(), version: membershipVersion(membership()), stored: true });
  const saved = await raw(uid);
  assert.equal(saved.verification.youtube.consumed, true); assert.equal(saved.verification.youtube.completed, true);
  assert.equal(saved.profile.format, 1); assert.equal(saved.profile.revision, 1);
  assert.doesNotMatch(JSON.stringify(saved), /accessToken|verificationId|clientSecret|"code"/);
  await assert.rejects(store.complete(uid, 'youtube', nonce('shape'), membership(), time + 3), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
});

test('RTDB 독립 연결의 동시 소비는 한 번만 성공한다', async () => {
  const uid = 'synthetic-membership-consume', first = createMembershipStore({ database: open().database });
  const second = createMembershipStore({ database: open().database });
  await first.start(uid, 'youtube', state('consume'));
  const results = await Promise.allSettled([first.consume(uid, 'youtube', nonce('consume'), time + 1), second.consume(uid, 'youtube', nonce('consume'), time + 1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'MEMBERSHIP_VERIFICATION_EXPIRED');
  assert.equal((await raw(uid)).verification.youtube.consumed, true);
});

test('RTDB 프로필 설정과 멤버십 동시 저장은 설정·서버 시각·프로필 revision을 보존한다', async () => {
  const uid = 'synthetic-membership-settings', profiles = createProfileStore({ database: open().database, maxAttempts: 10 });
  const store = createMembershipStore({ database: open().database });
  await profiles.update(uid, { displayName: '합성 계정', createdAt: null, settings: { theme: 'light', membership: membership('discord') } }, { serverTimestampPaths: [['createdAt']] });
  const before = await profiles.read(uid);
  await store.start(uid, 'youtube', state('settings'));
  await store.consume(uid, 'youtube', nonce('settings'), time + 1);
  await Promise.all([profiles.update(uid, { settings: { theme: 'dark' } }), store.complete(uid, 'youtube', nonce('settings'), membership(), time + 2)]);
  const after = await profiles.read(uid);
  assert.equal(after.value.settings.theme, 'dark'); assert.equal(after.value.displayName, '합성 계정');
  assert.deepEqual(after.value.createdAt, before.value.createdAt);
  assert.deepEqual(after.value.settings.membership, membership());
  assert.equal(after.revision, before.revision + 2); assert.equal(after.generation, before.generation);
  assert.equal(Object.hasOwn(after.value.settings.membership, 'discordId'), false);
});

test('RTDB 새 nonce는 이전 완료를 막으며 localOnly는 기존 프로필을 그대로 보존한다', async () => {
  const uid = 'synthetic-membership-local', store = createMembershipStore({ database: open().database });
  const profiles = createProfileStore({ database: open().database });
  await profiles.update(uid, { settings: { membership: membership('discord') } });
  const before = (await raw(uid)).profile;
  await store.start(uid, 'youtube', state('local'));
  await store.consume(uid, 'youtube', nonce('local'), time + 1);
  await store.start(uid, 'youtube', state('local-new', { startedAt: time + 3000, expiresAt: time + 303000, localOnly: true }));
  await assert.rejects(store.complete(uid, 'youtube', nonce('local'), membership(), time + 3001), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  await store.consume(uid, 'youtube', nonce('local-new'), time + 3001);
  assert.equal((await store.complete(uid, 'youtube', nonce('local-new'), membership(), time + 3002)).stored, false);
  assert.deepEqual((await raw(uid)).profile, before);
});

test('RTDB 인증은 다른 UID·provider와 분리되고 5분 만료 경계를 지킨다', async () => {
  const uid = 'synthetic-membership-isolation', other = 'synthetic-membership-isolation-other';
  const store = createMembershipStore({ database: open().database });
  await store.start(uid, 'youtube', state('isolation'));
  await store.start(other, 'youtube', state('isolation'));
  await store.start(uid, 'discord', state('discord', { redirectUri: 'https://ygo-synapse.web.app/' }));
  await assert.rejects(store.consume(uid, 'youtube', nonce('isolation'), time + 300000), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  await store.consume(uid, 'discord', nonce('discord'), time + 1);
  await store.complete(uid, 'discord', nonce('discord'), membership('discord'), time + 2);
  assert.equal((await raw(other)).verification.youtube.consumed, false);
  assert.equal((await raw(uid)).verification.youtube.consumed, false);
  assert.deepEqual((await store.read(uid)).membership, membership('discord'));
});
