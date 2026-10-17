'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscordMembershipHandlers } = require('../services/discordMembership');
const { createYoutubeMembershipHandlers } = require('../services/youtubeMembership');

const providers = [
  ['Discord', createDiscordMembershipHandlers, 'startDiscordMembershipVerification', 'verifyDiscordMembership'],
  ['YouTube', createYoutubeMembershipHandlers, 'startYoutubeMembershipVerification', 'verifyYoutubeMembership'],
];
const response = () => ({ statusCode: 200, headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; }, send() { return this; } });

function fixture(factory, backend, { app = true, allowForward = false } = {}) {
  const calls = [];
  const forbidden = name => () => { calls.push(name); assert.fail(`${name} 접근 금지`); };
  const handlers = factory({
    env: { USER_STORAGE_BACKEND: backend }, setCors() {},
    verifyAppCheck: async (_, res) => {
      calls.push('appCheck');
      if (!app) res.status(401).json({ success: false, code: 'APPCHECK_INVALID' });
      return app;
    },
    verifyRegisteredUser: allowForward ? async () => { calls.push('registered'); return 'synthetic-user'; }
      : forbidden('registered'),
    isLocal: allowForward ? () => true : forbidden('local'),
    db: { collection: forbidden('db.collection'), runTransaction: forbidden('db.transaction') },
    auth: { getUser: forbidden('auth') }, getMembership: forbidden('discord'),
    getClientSecret: forbidden('secret'), fetchImpl: forbidden('youtube'),
    forward: allowForward ? async () => { calls.push('forward'); return { success: true, uid: 'synthetic-user' }; }
      : forbidden('forward'),
  });
  return { calls, async call(name, method = 'POST') {
    const res = response();
    await handlers[name]({ method, headers: {}, query: {}, body: {} }, res);
    return res;
  } };
}

for (const [label, factory, start, complete] of providers) {
  test(`${label} 시험 RTDB와 잘못된 backend는 가입 조회·DB·외부 인증 전에 거부한다`, async () => {
    for (const backend of ['rtdb', 'firestore', 'RTDB', ' storage ', null]) {
      for (const name of [start, complete]) {
        const f = fixture(factory, backend), res = await f.call(name);
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, 'USER_STORAGE_FEATURE_UNAVAILABLE');
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.deepEqual(f.calls, ['appCheck']);
      }
    }
  });

  test(`${label} 저장소 경계에서도 OPTIONS·POST·App Check 처리 순서를 유지한다`, async () => {
    for (const name of [start, complete]) {
      const f = fixture(factory, 'rtdb');
      assert.equal((await f.call(name, 'OPTIONS')).statusCode, 204);
      assert.equal((await f.call(name, 'GET')).statusCode, 405);
      assert.deepEqual(f.calls, []);
      const denied = fixture(factory, 'rtdb', { app: false }), res = await denied.call(name);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'APPCHECK_INVALID');
      assert.deepEqual(denied.calls, ['appCheck']);
    }
  });

  test(`${label} backend 미설정·빈 값·storage는 기존 가입 검증과 운영 전달을 유지한다`, async () => {
    for (const backend of [undefined, '', 'storage']) {
      const f = fixture(factory, backend, { allowForward: true }), res = await f.call(start);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(f.calls, ['appCheck', 'registered', 'forward']);
    }
  });
}
