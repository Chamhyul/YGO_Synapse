'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function fixture() {
  const sandbox = { TextDecoder }, failures = [], recorded = [];
  vm.runInNewContext(fs.readFileSync('public/authentication-result.js', 'utf8'), sandbox);
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const response = new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
  const result = sandbox.YgoAuthenticationResult.read(response, { onRecorded: value => recorded.push(value), onFailure: () => failures.push(true) });
  const send = value => controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  return { result, recorded, failures, send, controller };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('회원·비회원 결과를 기록 종료 전에 반환하고 기록 결과는 별도로 회수한다', async () => {
  for (const status of ['active', 'none']) {
    const f = fixture(), result = { success: true, uid: 'synthetic', membership: { status } };
    f.send({ v: 1, type: 'result', result });
    assert.equal((await f.result).membership.status, status); assert.equal(f.recorded.length, 0);
    f.send({ v: 1, type: 'recorded', success: true, result }); f.controller.close(); await settle();
    assert.equal(f.recorded.length, 1); assert.equal(f.failures.length, 0);
  }
});
test('기록 실패·연결 종료는 이미 받은 인증 결과와 분리한다', async () => {
  for (const mode of ['failure', 'disconnect']) {
    const f = fixture(); f.send({ v: 1, type: 'result', result: { success: true } }); await f.result;
    if (mode === 'failure') f.send({ v: 1, type: 'recorded', success: false });
    f.controller.close(); await settle(); assert.equal(f.failures.length, 1); assert.equal(f.recorded.length, 0);
  }
});
test('인증 결과 없는 종료·위조 형식·중복 결과를 성공으로 적용하지 않는다', async () => {
  const f = fixture(); f.send({ v: 2, type: 'result', result: { success: true } }); f.controller.close(); await assert.rejects(f.result);
  const duplicate = fixture(); duplicate.send({ v: 1, type: 'result', result: { success: true, uid: 'a' } });
  assert.equal((await duplicate.result).uid, 'a'); duplicate.send({ v: 1, type: 'result', result: { success: true, uid: 'b' } });
  duplicate.controller.close(); await settle(); assert.equal(duplicate.failures.length, 1);
});
test('기존 JSON 서버의 응답 계약도 유지한다', async () => {
  const sandbox = { TextDecoder }; vm.runInNewContext(fs.readFileSync('public/authentication-result.js', 'utf8'), sandbox);
  const response = Response.json({ success: false, code: 'AUTH_INVALID' }, { status: 401 });
  assert.equal((await sandbox.YgoAuthenticationResult.read(response)).code, 'AUTH_INVALID');
});
test('다른 계정의 늦은 기록 종료는 현재 계정의 권한 확인을 갱신하지 않는다', async () => {
  const source = fs.readFileSync('public/script.js', 'utf8'), callbacks = [], updates = [], sent = [];
  const user = { uid: 'a', getIdToken: async () => 'synthetic' };
  const sandbox = { URL, authStateRevision: 1, UserStore: { user, inventorySyncStatus: 'ready' },
    FIREBASE_CONFIG: { ENDPOINTS: { verifyYoutubeMembership: 'https://synthetic.invalid/verify' } }, STORAGE_KEY: 'synthetic',
    localStorage: { getItem: () => null }, getApiAppCheckToken: async () => 'synthetic',
    firebase: { auth: () => ({ currentUser: sandbox.UserStore.user }) },
    window: { YgoAuthenticationResult: { read: async (_response, value) => { callbacks.push(value); return { success: true, uid: 'a' }; } } },
    fetch: async (_url, options) => { sent.push(options); return { ok: true }; }, console: { error() {} },
    refreshMembershipClaims: async () => { updates.push('refresh'); return true; }, followMembershipClaims: () => updates.push('follow'),
    setInventorySyncStatus: () => updates.push('status'), showToast: () => updates.push('toast') };
  const start = source.indexOf('function awaitApiPreparation('), end = source.indexOf('// 검색 시 최신 공통 목록', start);
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  assert.equal((await sandbox.requestApi('verifyYoutubeMembership', {}, { verificationId: 'synthetic' })).uid, 'a');
  assert.equal(sent[0].keepalive, true); assert.equal(JSON.parse(sent[0].body).authenticationResultStream, true);
  sandbox.authStateRevision++; sandbox.UserStore.user = { uid: 'b' };
  await callbacks[0].onRecorded({ success: true, uid: 'a', membershipClaims: { status: 'synced', version: 'synthetic' } });
  callbacks[0].onFailure(); assert.deepEqual(updates, []);
});
