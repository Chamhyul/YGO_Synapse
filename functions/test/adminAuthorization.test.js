'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createWriterAdminOperations } = require('../services/adminWriterOperations');
const { createAdminWriterRequests } = require('../services/adminWriterRequests');
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: 'a'.repeat(32),
  GCLOUD_PROJECT: 'demo-admin-security', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000',
  USER_DATABASE_URL: 'http://127.0.0.1:9000?ns=demo-admin-security-default-rtdb', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
function fixture() {
  const config = resolveProfileWriterConfig(env), events = [], state = { role: 'owner', disabled: false, revoked: false, expired: false };
  const transition = { runId: config.runId, async beginExternal() { events.push('begin'); await state.begin?.(); },
    async addExternalResources() { events.push('reserve'); await state.reserve?.(); }, async endExternal() { events.push('end'); await state.end?.(); } };
  const adminRequests = createAdminWriterRequests({ transition, initialize: async () => ({ backend: 'rtdb', epoch: 1, phase: 'accepting' }),
    initializeMissing: false, database: { ref() { assert.fail('실제 DB 접근 금지'); } }, db: {} });
  const auth = { async verifyIdToken(token, revoked) {
    events.push('token'); assert.equal(revoked, false);
    if (token !== 'synthetic-valid' || state.expired) throw Object.assign(Error('synthetic-token'), { code: 'auth/id-token-expired' });
    return { uid: 'synthetic-admin', auth_time: 100 };
  }, async getUser() {
    events.push('account'); if (state.authFailure) throw Error('synthetic-auth-down');
    return { uid: 'synthetic-admin', disabled: state.disabled, customClaims: { role: state.role },
      tokensValidAfterTime: new Date(state.revoked ? 200000 : 0).toISOString() };
  } };
  const ops = createWriterAdminOperations({ env, auth, writerBinding: { transition, adminRequests, claimsStorage: { config },
    notices: { async mutate() { events.push('business'); await state.business?.(); return { revision: '1' }; } }, membershipCsv: {} } });
  return { state, events, async call(operation = 'manageNotice', options = {}) {
    const res = { code: 200, set() { return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, send() { return this; } };
    await ops[operation]({ method: options.method || 'POST', headers: { authorization: 'Bearer synthetic-valid', ...options.headers }, body: options.body || {} }, res);
    return res;
  } };
}
const writes = events => events.filter(e => ['begin', 'reserve', 'business', 'end'].includes(e));
for (const operation of ['manageNotice', 'manageAdminRole', 'uploadMembershipCsv', 'checkAdminAccess']) {
  for (const problem of ['missing', 'forged', 'disabled', 'revoked', 'non-admin', 'auth-down', 'method']) test(`${operation}: ${problem} 거부 전에 writer·대상 잠금을 만들지 않는다`, async () => {
    const f = fixture(); let options = {}, expected = 401;
    if (problem === 'missing') options.headers = { authorization: undefined };
    if (problem === 'forged') options.headers = { authorization: 'Bearer forged' };
    if (problem === 'disabled') f.state.disabled = true;
    if (problem === 'revoked') f.state.revoked = true;
    if (problem === 'non-admin') { f.state.role = 'none'; expected = 403; }
    if (problem === 'auth-down') { f.state.authFailure = true; expected = 503; }
    if (problem === 'method') { options.method = 'GET'; expected = 405; }
    assert.equal((await f.call(operation, options)).code, expected); assert.deepEqual(writes(f.events), []);
  });
}
test('일반 관리자의 소유자 전용 요청은 대상 UID 잠금 전에 거부한다', async () => {
  for (const [operation, body] of [['manageAdminRole', { action: 'setAdmin', targetUid: 'synthetic-other', isAdmin: true }],
    ['checkAdminAccess', { scope: 'settings' }], ['manageAdminRole', { action: 'settingsList' }]]) {
    const f = fixture(); f.state.role = 'admin'; assert.equal((await f.call(operation, { body })).code, 403); assert.deepEqual(writes(f.events), []);
  }
});
test('정상 쓰기는 초기 현재 자격 뒤 잠금을 얻고 새 토큰·현재 Auth를 확인한 뒤 반영한다', async () => {
  const f = fixture(); assert.equal((await f.call()).code, 200);
  assert.deepEqual(f.events, ['token', 'account', 'begin', 'reserve', 'token', 'account', 'business', 'end']);
});
for (const problem of ['role', 'disabled', 'revoked', 'expired', 'auth-down']) test(`잠금 대기 중 ${problem} 변경은 재검사하고 업무를 실행하지 않는다`, async () => {
  const f = fixture(); f.state.reserve = () => {
    if (problem === 'role') f.state.role = 'none'; else if (problem === 'auth-down') f.state.authFailure = true; else f.state[problem] = true;
  };
  assert.equal((await f.call()).code, problem === 'role' ? 403 : problem === 'auth-down' ? 503 : 401);
  assert(!f.events.includes('business')); assert.equal(f.events.at(-1), 'end');
});
for (const phase of ['begin', 'reserve', 'business', 'end']) test(`${phase} 실패는 성공을 반환하지 않고 기존 정리 경계를 유지한다`, async () => {
  const f = fixture(); f.state[phase] = () => { throw Error('synthetic-failure'); };
  assert.equal((await f.call()).code, 503);
  if (['begin', 'reserve'].includes(phase)) assert(!f.events.includes('business'));
  if (phase !== 'begin') assert.equal(f.events.at(-1), 'end');
});
