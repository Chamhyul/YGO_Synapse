'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const { createUserStorageConnection } = require('../config/userStorage');
const { createMembershipCsvStore } = require('../services/user-storage/membershipCsvStore');
const { createMembershipCsvService } = require('../services/membershipCsvService');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const runtime = require('../services/userStorageRuntime');
const { BACKEND_URL } = require('../services/adminTransport');
const servers = [], connections = [];
after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); })));
  await Promise.all([runtime.closeRtdbUserStorage(), ...connections.map(connection => connection.close())]);
});
async function harness(surface) {
  const connection = createUserStorageConnection(); connections.push(connection);
  const unique = randomBytes(16).toString('hex'), uid = `synthetic-csv-admin-${unique}`, session = `synthetic-csv-cookie-${unique}`;
  const store = createMembershipCsvStore({ database: connection.database, path: `membershipCsvHttp/${unique}` });
  const service = createMembershipCsvService({ store }); let role = 'admin';
  const handlers = createAdminRouteHandlers({ emulatorDependencies: {
    auth: {
      async verifyIdToken(token, revoked) { assert.equal(token, 'synthetic-token'); assert.equal(revoked, false); return { uid, auth_time: 1 }; },
      async getUser() { return { uid, disabled: false, tokensValidAfterTime: new Date(0).toISOString(), customClaims: { role } }; },
      async createSessionCookie() { return session; },
      async verifySessionCookie(cookie, revoked) { assert.equal(cookie, session); assert.equal(revoked, false); return { uid, auth_time: 1 }; },
    }, membershipCsv: service, template: async () => '<html></html>',
  }, productionDependencies() { assert.fail('운영 서비스 생성 금지'); }, proxy() { assert.fail('운영 proxy 호출 금지'); } });
  const app = express(); app.use(express.json()); app.use(handlers[surface]);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, origin = surface === 'adminBackend' ? new URL(BACKEND_URL).origin : base;
  let cookie;
  async function call(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + (surface === 'adminBackend' ? '/adminBackend?route=' + encodeURIComponent(route) : route), {
      method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { code: response.status, body: await response.json(), headers: response.headers };
  }
  return { call, store, service, role(value) { role = value; }, async login() {
    const result = await call('/admin/session', { method: 'POST', headers: { Authorization: 'Bearer synthetic-token' }, body: {} });
    assert.equal(result.code, 200); cookie = result.headers.get('set-cookie').split(';')[0];
  } };
}
const csvText = '회원,프로필에 연결,현재 등급\n합성 회원,https://youtube.com/channel/UC' + 'a'.repeat(22) + ',합성 등급';
for (const surface of ['adminPages', 'adminBackend']) {
  test(`${surface} RTDB CSV는 현재 권한·미리보기·적용·완료 상태와 기존 응답을 유지한다`, async () => {
    const f = await harness(surface);
    assert.equal((await f.call('/admin/api/membership-csv')).code, 401);
    await f.login();
    assert.equal((await f.call('/admin/api/membership-csv')).body.count, 0);
    const preview = await f.call('/admin/api/membership-csv/preview', { method: 'POST', body: { csvText } });
    assert.equal(preview.code, 200); assert.equal(preview.body.count, 1);
    assert.equal((await f.service.summary()).count, 0);
    const body = { csvText, revision: preview.body.revision, fingerprint: preview.body.fingerprint, operationId: randomBytes(16).toString('hex') };
    const applied = await f.call('/admin/api/membership-csv', { method: 'POST', body });
    assert.equal(applied.code, 200); assert.equal(applied.body.count, 1);
    const status = await f.call('/admin/api/membership-csv/status', { method: 'POST', body: { operationId: body.operationId } });
    assert.equal(status.code, 200); assert.equal(status.body.status, 'completed');
    assert.deepEqual(status.body.result, { count: applied.body.count, tiers: applied.body.tiers, revision: applied.body.revision, updatedAt: applied.body.updatedAt });
    assert.equal((await f.call('/admin/api/membership-csv', { method: 'POST', body })).code, 200);
    assert.equal((await f.call('/admin/api/membership-csv/preview', { method: 'POST', body: { members: [] } })).code, 400);
    assert.equal((await f.call('/admin/api/membership-csv', { method: 'POST', body, headers: { Origin: 'https://outside.invalid' } })).code, 403);
    f.role('user');
    assert.equal((await f.call('/admin/api/membership-csv')).code, 401);
    assert.equal((await f.service.summary()).revision, body.operationId);
  });
}
