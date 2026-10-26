'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { respondMembershipReadiness } = require('../services/membershipReadiness');
const { createYoutubeMembershipHandlers } = require('../services/youtubeMembership');
const { createDiscordMembershipHandlers } = require('../services/discordMembership');
const { withLoginRequestTiming, withMembershipRequestTiming } = require('../services/inventoryRequestTiming');
const vm = require('node:vm'), fs = require('node:fs');
const body = { warmup: 'true', membershipPrepare: true, ssId: null };
const response = () => ({ statusCode: 200, set() {}, status(n) { this.statusCode = n; return this; },
  json(value) { this.body = value; return this; }, send() { return this; } });

for (const target of ['getUserData', 'verifyYoutubeMembership', 'verifyDiscordMembership', 'startYoutubeMembershipVerification']) {
  test(`${target} 준비는 허용된 모듈만 로드하고 계정/권한/인벤토리를 반환하지 않는다`, () => {
    const loads = [], res = response();
    respondMembershipReadiness({ method: 'POST', body }, res, target, { load: name => loads.push(name) });
    assert.deepEqual(res.body, { success: true, membershipPreparation: { version: 1, target, ready: true } });
    assert(loads.length); assert(loads.every(name => name.startsWith('./')));
  });
}
test('준비에 업무 필드·위조 권한·시작 요청·GET을 섞으면 모듈 준비도 실행하지 않는다', () => {
  for (const [method, value, target] of [
    ['GET', body, 'getUserData'], ['POST', { membershipPrepare: true }, 'getUserData'],
    ['POST', { ...body, verificationId: 'synthetic' }, 'verifyYoutubeMembership'],
    ['POST', { ...body, accessToken: 'synthetic' }, 'verifyYoutubeMembership'],
    ['POST', { ...body, ready: true, role: 'owner' }, 'getUserData'],
    ['POST', body, 'startDiscordMembershipVerification'],
  ]) {
    const res = response(); respondMembershipReadiness({ method, body: value }, res, target,
      { load: () => assert.fail('잘못된 요청은 준비 금지') });
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'MEMBERSHIP_PREPARATION_INVALID');
  }
});

for (const provider of ['Youtube', 'Discord']) {
  for (const denied of ['app', 'account', 'registration']) test(`${provider} 준비도 ${denied} 거부 후 성공을 반환하지 않는다`, async () => {
    const forbidden = () => assert.fail('거부된 준비에서 업무/외부 요청 금지');
    const dependencies = { env: {}, db: { collection: forbidden, runTransaction: forbidden }, auth: { getUser: forbidden },
      isLocal: forbidden, setCors() {}, forward: forbidden, getClientSecret: forbidden, getMembership: forbidden,
      verifyAppCheck: async (_req, res) => { if (denied === 'app') { res.status(401).json({ success: false }); return false; } return true; },
      verifyRegisteredUser: async (_req, res) => { res.status(denied === 'registration' ? 403 : 401).json({ success: false }); return null; } };
    const handlers = provider === 'Youtube' ? createYoutubeMembershipHandlers(dependencies) : createDiscordMembershipHandlers(dependencies);
    const res = response(); await handlers[`verify${provider}Membership`]({ method: 'POST', body, query: {} }, res);
    assert.equal(res.statusCode, denied === 'registration' ? 403 : 401); assert.equal(res.body.success, false);
  });
}

for (const workerPrepare of [false, true]) for (const denied of ['app', 'account', 'registration', null]) test(`getUserData 준비(worker=${workerPrepare})의 ${denied || '성공'} 경로도 기존 인증 순서를 지킨다`, async () => {
  const events = [], exports = {}, forbidden = () => assert.fail('준비에서 인벤토리/업무 저장 금지');
  const mocks = {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/inventoryRequestTiming': { measure: (_name, action) => action(), withLoginRequestTiming: (_name, handler) => handler },
    '../services/userProfileRepository': { getUserProfileRepository: forbidden },
    '../utils/inventoryStorage': { deleteInventory: forbidden },
    '../utils/auth': { setCors() {}, verifyAppCheck: async (_req, res) => {
      events.push('app'); if (denied === 'app') { res.status(401).json({ success: false }); return false; } return true;
    }, verifyRegisteredUser: async (_req, res) => {
      events.push('account-registration'); if (denied) { res.status(denied === 'registration' ? 403 : 401).json({ success: false }); return null; } return 'synthetic';
    } },
    '../services/membershipReadiness': { respondMembershipReadiness: (req, res, target) =>
      respondMembershipReadiness(req, res, target, { load: name => events.push(name),
        prepareWorker: async () => { events.push('worker'); return { status: 'delivered' }; } }) },
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../routes/user.js'), 'utf8'), {
    exports, require(name) { assert(Object.hasOwn(mocks, name), name); return mocks[name]; },
  });
  const res = response(); await exports.getUserData({ method: 'POST', body: { ...body,
    ...(workerPrepare ? { workerPrepare: true } : {}) }, query: { warmup: 'true' } }, res);
  assert.equal(res.statusCode, denied ? denied === 'registration' ? 403 : 401 : 200);
  assert.equal(events[0], 'app');
  if (denied) { assert(!events.some(e => e.startsWith('./'))); assert(!events.includes('worker')); assert.equal(res.body.success, false); }
  else { assert.equal(events[1], 'account-registration'); assert.equal(res.body.membershipPreparation.ready, true); }
});

for (const [wrapper, operation] of [[withLoginRequestTiming, 'getUserData'], [withMembershipRequestTiming, 'verifyYoutubeMembership']]) {
  test(`${operation} 준비와 실제 요청의 첫 표본을 구분하고 준비 입력을 기록하지 않는다`, async () => {
    const lines = [], handler = wrapper(operation, (_req, res) => res.json({ success: true }), { emit: line => lines.push(JSON.parse(line)) });
    await handler({ method: 'POST', body: { ...body, ssId: 'synthetic-private-context' }, query: {} }, response());
    await handler({ method: 'POST', body: {}, query: {} }, response());
    assert.equal(lines[0].preparation, true); assert.equal(lines[0].firstTimedRequest, true);
    assert.equal(lines[1].preparation, undefined); assert.equal(lines[1].firstTimedRequest, true);
    assert.doesNotMatch(JSON.stringify(lines), /synthetic-private-context|ssId|membershipPrepare|warmed up/);
  });
}
