'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const express = require('express');
const { createUserStorageConnection } = require('../config/userStorage');
const { createEmulatorUserStorage } = require('../services/user-storage');
const { createMembershipCsvStore } = require('../services/user-storage/membershipCsvStore');
const { createDiscordMembershipHandlers } = require('../services/discordMembership');
const { createYoutubeMembershipHandlers } = require('../services/youtubeMembership');
const { encodeKey } = require('../services/user-storage/codec');

// HTTP·프로필·nonce·CSV는 실제 RTDB 에뮬레이터, Auth·OAuth·claims 쓰기는 합성 의존성이다.
const storage = createEmulatorUserStorage(), inspector = createUserStorageConnection(), servers = [];
// 같은 demo 에뮬레이터의 반복 실행에서도 고정 시각의 과거 nonce와 충돌하지 않는다.
const testRun = randomBytes(8).toString('hex');
let sequence = 0;
const channel = 'UC' + 'x'.repeat(22), discordId = '123456789012345678';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); })));
  await storage.close(); await inspector.close();
});

async function harness({ roles = ['1462257396020809800'], active = true, accountRole = 'user', claimsFail = false,
  localOnly = false, disabled = false, omitSync = false, csvFail = false, csvPinRefresh = false, disableAfterPin = false } = {}) {
  const id = ++sequence, uid = `synthetic-membership-http-${testRun}-${id}`;
  let time = 90000000, authCalls = 0, providerCalls = 0, claimsCalls = 0, providerHook;
  const secret = 'synthetic-sensitive-oauth-value';
  await storage.profile.createIfAbsent(uid, { uid, displayName: '합성 사용자', settings: { theme: 'dark', inventoryView: 'grid' } });
  const csv = createMembershipCsvStore({
    database: { ref: name => inspector.database.ref(`syntheticMembershipHttpCsv/${testRun}/${id}/${name}`) }, now: () => time,
  });
  const members = [{ channelId: active ? channel : 'UC' + 'z'.repeat(22), memberName: '합성 회원', levelName: '간부' }];
  const revision = (await csv.read()).revision, operation = randomBytes(16).toString('hex');
  await csv.begin(operation, digest([uid, revision, digest(members)]), revision, uid, time);
  await csv.stage(operation, members);
  await csv.commit(operation, revision, { revision: operation, count: 1, updatedAt: time, tiers: [{ levelName: '간부', count: 1 }] });
  const forbidden = () => assert.fail('운영 DB·프록시·실제 Auth 접근 금지');
  const auth = { async getUser(actual) { authCalls++; assert.equal(actual, uid); return { uid, disabled: disabled || (disableAfterPin && authCalls > 1), customClaims: { role: accountRole } }; } };
  const syncClaims = omitSync ? undefined : async actual => {
    claimsCalls++; assert.equal(actual, uid);
    if (claimsFail) throw new Error(secret);
    return { status: 'synced', version: (await storage.membership.read(uid)).version };
  };
  const common = { storage: { ...storage, membershipCsv: csvPinRefresh ? { withMember: async (key, action) => action(await csv.readMember(key), { refreshAccount: true }) } : csvFail ? { readMember: async () => { throw new Error(secret); } } : csv }, rtdbTestDependencies: true,
    auth, now: () => time, env: process.env, isLocal: forbidden, forward: forbidden,
    db: { collection: forbidden, runTransaction: forbidden }, syncClaims, setCors() {},
    verifyAppCheck: async (req, res) => { if (req.headers['x-synthetic-app'] === 'denied') { res.status(401).json({ success: false }); return false; } return true; },
    verifyRegisteredUser: async (req, res) => {
      if (req.headers['x-synthetic-registered'] === 'no') { res.status(403).json({ success: false, code: 'REGISTRATION_REQUIRED' }); return null; }
      return req.headers['x-synthetic-uid'] || uid;
    },
  };
  const discord = createDiscordMembershipHandlers({ ...common, clientId: 'synthetic-client', guildId: 'synthetic-guild',
    getClientSecret: () => secret, getMembership: async () => {
      providerCalls++; if (providerHook) await providerHook(); return { discordId, roles };
    } });
  const youtube = createYoutubeMembershipHandlers({ ...common, fetchImpl: async (_url, options) => {
    providerCalls++; assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    if (providerHook) await providerHook(); return { ok: true, json: async () => ({ items: [{ id: channel }] }) };
  } });
  const app = express(); app.use(express.json());
  for (const [name, handler] of Object.entries({ ...discord, ...youtube })) app.all('/' + name, handler);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(provider, operation, body, headers = {}) {
    const methodName = `${operation === 'start' ? 'start' : 'verify'}${provider === 'discord' ? 'Discord' : 'Youtube'}Membership${operation === 'start' ? 'Verification' : ''}`;
    const response = await fetch(`${base}/${methodName}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const result = { status: response.status, body: await response.json(), headers: response.headers };
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret)); return result;
  }
  const start = (provider, extra = {}, headers) => call(provider, 'start', {
    localOnly, ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}), ...extra,
  }, headers);
  const complete = (provider, verificationId, extra = {}, headers) => call(provider, 'complete', {
    verificationId, ...(provider === 'discord' ? { code: secret } : { accessToken: secret }), ...extra,
  }, headers);
  return { uid, start, complete, advance(ms) { time += ms; }, hook(value) { providerHook = value; },
    calls: () => ({ authCalls, providerCalls, claimsCalls }),
    profile: async () => (await storage.profile.read(uid)).value,
    raw: async () => (await inspector.database.ref(`users/${encodeKey(uid)}`).get()).val(),
  };
}

for (const provider of ['discord', 'youtube']) {
  test(`HTTP ${provider} RTDB 검증은 원본·등급·기존 설정을 보존하고 claims 상태를 반환한다`, async () => {
    const app = await harness(), started = await app.start(provider);
    assert.equal(started.status, 200); assert.equal(started.body.uid, app.uid);
    if (provider === 'discord') assert.equal(new URL(started.body.authorizationUrl).searchParams.get('state'), started.body.verificationId);
    const result = await app.complete(provider, started.body.verificationId);
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.body.sourceMembership.type, provider === 'discord' ? 'discord' : 'csv');
    assert.equal(result.body.sourceMembership.levelName, provider === 'discord' ? '유튜브 멤버십' : '간부');
    assert.equal(result.body.isMemberActive, true); assert.equal(result.body.claimsPending, false);
    assert.equal(result.body.membershipClaims.status, 'synced'); assert.match(result.body.membershipClaims.version, /^[a-f0-9]{64}$/);
    const profile = await app.profile(); assert.equal(profile.settings.theme, 'dark'); assert.equal(profile.settings.inventoryView, 'grid');
    assert.deepEqual(profile.settings.membership, result.body.sourceMembership);
    assert.doesNotMatch(JSON.stringify(await app.raw()), /synthetic-sensitive-oauth-value|verificationId/);
    assert.deepEqual(app.calls(), { authCalls: 1, providerCalls: 1, claimsCalls: 1 });
  });

  test(`HTTP ${provider} localOnly는 RTDB 프로필·Auth claims를 바꾸지 않는다`, async () => {
    const app = await harness({ localOnly: true }), before = await app.profile();
    const result = await app.complete(provider, (await app.start(provider)).body.verificationId);
    assert.equal(result.status, 200); assert.equal(result.body.isMemberActive, true);
    assert.equal(result.body.membershipClaims, undefined); assert.equal(app.calls().claimsCalls, 0);
    assert.deepEqual(await app.profile(), before);
  });

  test(`HTTP ${provider} 다른 계정·동시 재사용·만료·새 nonce는 제공자 재호출을 막는다`, async () => {
    const app = await harness(), id = (await app.start(provider)).body.verificationId;
    assert.equal((await app.start(provider)).status, 429);
    assert.equal((await app.complete(provider, id, {}, { 'x-synthetic-uid': 'synthetic-other' })).status, 403);
    const results = await Promise.all([app.complete(provider, id), app.complete(provider, id)]);
    assert.deepEqual(results.map(value => value.status).sort(), [200, 403]); assert.equal(app.calls().providerCalls, 1);
    app.advance(3001); const old = (await app.start(provider)).body.verificationId;
    app.advance(3001); const next = (await app.start(provider)).body.verificationId;
    assert.equal((await app.complete(provider, old)).status, 403);
    app.advance(300001); assert.equal((await app.complete(provider, next)).status, 403);
    assert.equal(app.calls().providerCalls, 1);
  });

  test(`HTTP ${provider} 검증 중 새 인증 시작은 오래된 결과 저장·claim 쓰기를 막는다`, async () => {
    const app = await harness(), id = (await app.start(provider)).body.verificationId;
    app.hook(async () => { app.advance(3001); assert.equal((await app.start(provider)).status, 200); });
    assert.equal((await app.complete(provider, id)).status, 403);
    assert.equal((await app.profile()).settings.membership, undefined); assert.equal(app.calls().claimsCalls, 0);
  });

  test(`HTTP ${provider} 비회원 원본과 관리자 혜택은 분리되며 등록·disabled 계정을 차단한다`, async () => {
    const app = await harness({ roles: [], active: false, accountRole: 'owner' });
    const result = await app.complete(provider, (await app.start(provider)).body.verificationId);
    assert.equal(result.body.membership.levelName, '소유자'); assert.equal(result.body.sourceMembership.status, 'none');
    assert.equal((await app.profile()).settings.membership.status, 'none');
    const denied = await harness({ disabled: true });
    assert.equal((await denied.start(provider, {}, { 'x-synthetic-registered': 'no' })).status, 403);
    assert.equal(denied.calls().providerCalls, 0);
    assert.equal((await denied.complete(provider, (await denied.start(provider)).body.verificationId)).status, 401);
    assert.equal((await denied.profile()).settings.membership, undefined); assert.equal(denied.calls().claimsCalls, 0);
  });

  test(`HTTP ${provider} claim 오류는 확정 원본을 보존하고 pending으로 응답한다`, async () => {
    for (const options of [{ claimsFail: true }, { omitSync: true }]) {
      const app = await harness(options), id = (await app.start(provider)).body.verificationId;
      const result = await app.complete(provider, id);
      assert.equal(result.status, 200); assert.equal(result.body.claimsPending, true);
      assert.equal(result.body.membershipClaims.status, 'pending'); assert.equal((await app.profile()).settings.membership.status, 'active');
      assert.equal((await app.complete(provider, id)).status, 403); assert.equal(app.calls().providerCalls, 1);
    }
  });

  test(`HTTP ${provider} AppCheck·외부 장애는 원본·claim을 변경하지 않고 비밀값을 숨긴다`, async () => {
    const app = await harness();
    assert.equal((await app.start(provider, {}, { 'x-synthetic-app': 'denied' })).status, 401);
    assert.deepEqual(app.calls(), { authCalls: 0, providerCalls: 0, claimsCalls: 0 });
    const id = (await app.start(provider)).body.verificationId;
    app.hook(async () => { throw new Error('synthetic-sensitive-oauth-value'); });
    assert.equal((await app.complete(provider, id)).status, 503);
    assert.equal((await app.profile()).settings.membership, undefined); assert.equal(app.calls().claimsCalls, 0);
    assert.equal((await app.complete(provider, id)).status, 403); assert.equal(app.calls().providerCalls, 1);
  });
}

test('HTTP YouTube RTDB CSV 조회 장애를 비회원 저장으로 바꾸지 않는다', async () => {
  const app = await harness({ csvFail: true });
  const result = await app.complete('youtube', (await app.start('youtube')).body.verificationId);
  assert.equal(result.status, 503); assert.equal((await app.profile()).settings.membership, undefined);
  assert.equal(app.calls().claimsCalls, 0);
});

test('HTTP RTDB 제공자 전환은 마지막 검증 원본을 저장하고 새 claims 버전을 반환한다', async () => {
  const app = await harness();
  const discord = await app.complete('discord', (await app.start('discord')).body.verificationId);
  const youtube = await app.complete('youtube', (await app.start('youtube')).body.verificationId);
  assert.equal(discord.status, 200); assert.equal(youtube.status, 200);
  assert.equal((await app.profile()).settings.membership.type, 'csv');
  assert.notEqual(discord.body.membershipClaims.version, youtube.body.membershipClaims.version);
  assert.equal(app.calls().claimsCalls, 2);
});

test('HTTP YouTube CSV 고정 대기 후 계정을 다시 확인하고 회수된 계정의 저장을 막는다', async () => {
  const good = await harness({ csvPinRefresh: true });
  const ok = await good.complete('youtube', (await good.start('youtube')).body.verificationId);
  assert.equal(ok.status, 200); assert.equal(good.calls().authCalls, 2);
  const denied = await harness({ csvPinRefresh: true, disableAfterPin: true });
  const no = await denied.complete('youtube', (await denied.start('youtube')).body.verificationId);
  assert.equal(no.status, 401); assert.equal(denied.calls().authCalls, 2);
  assert.equal((await denied.profile()).settings.membership, undefined);
  assert.equal(denied.calls().claimsCalls, 0);
});
