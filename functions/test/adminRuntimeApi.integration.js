'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const { getApps } = require('firebase-admin/app');
const { createUserStorageConnection } = require('../config/userStorage');
const runtime = require('../services/userStorageRuntime');
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const transport = require('../services/adminTransport');
const { IDLE_MS, ABSOLUTE_MS, PAGES } = require('../services/adminPageSession');
const { createNoticeService } = require('../services/noticeService');
const { createErrorSummaryService } = require('../services/adminErrorSummary');
const { createTrafficSummaryService } = require('../services/adminTrafficSummary');
const { encodeKey } = require('../services/user-storage/codec');
const { readSourceFile } = require('./sourceFile');

// 일반 관리자 export와 같은 라우팅 factory에서 실제 HTTP·RTDB 세션을 검사한다.
// Auth·공지 파일·Google 집계 입력은 합성이다. 운영 연결과 운영 프록시는 호출 즉시 실패한다.
const inspector = createUserStorageConnection(), servers = [];
let sequence = 0;
after(async () => {
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  })));
  await runtime.closeRtdbUserStorage();
  await inspector.close();
});
const template = name => fs.readFile(path.join(__dirname, '../templates/admin', `${name}.html`), 'utf8');
const noDocument = result => assert.doesNotMatch(result.text, /id="admin-content"/);
const backendOrigin = new URL(transport.BACKEND_URL).origin;

async function serve(handler) {
  const app = express(); app.use(express.json()); app.use(handler);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return `http://127.0.0.1:${server.address().port}`;
}

function dependencies() {
  const id = ++sequence, uid = `synthetic-admin-runtime-${id}`, issued = new Set();
  const counts = { token: 0, currentUser: 0, noticesRead: 0, noticesWrite: 0, errors: 0, traffic: 0, membership: 0 };
  let time = Date.UTC(2030, 0, 15, 3), role = 'owner', disabled = false, revoked = false, issue = 0;
  let noticeData = { notices: [] }, revision = '0';
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      counts.token++; assert.equal(checkRevoked, true);
      if (token !== 'synthetic-valid-token') throw Object.assign(new Error('synthetic-private-auth-token'), { code: 'auth/invalid-id-token' });
      return { uid, role: 'owner' };
    },
    async getUser(actual) { counts.currentUser++; assert.equal(actual, uid); return { uid, disabled, customClaims: { role } }; },
    async createSessionCookie(_, options) {
      assert.deepEqual(options, { expiresIn: ABSOLUTE_MS });
      const value = `synthetic-runtime-cookie:${id}:${++issue}`; issued.add(value); return value;
    },
    async verifySessionCookie(value, checkRevoked) {
      assert.equal(checkRevoked, true);
      if (revoked || !issued.has(value)) throw Object.assign(new Error('synthetic-private-revocation'), { code: 'auth/session-cookie-revoked' });
      return { uid };
    },
  };
  const notices = createNoticeService({ environment: 'synthetic', now: () => time, storage: {
    async read() { counts.noticesRead++; return { data: structuredClone(noticeData), revision }; },
    async write(value, expected) {
      assert.equal(expected, revision); counts.noticesWrite++; noticeData = structuredClone(value);
      revision = String(Number(revision) + 1); return revision;
    },
  } });
  const getErrorSummary = createErrorSummaryService({ now: () => time, async list(input) {
    counts.errors++; assert.deepEqual(input, { period: 'PERIOD_1_DAY', pageToken: undefined });
    return { timeRangeBegin: new Date(time - 86400000).toISOString(), errorGroupStats: [{
      count: '3', lastSeenTime: new Date(time).toISOString(),
      representative: { message: 'synthetic-private-error-user@example.invalid timeout' },
      affectedServices: [{ service: 'synthetic-card-service' }], group: { groupId: 'synthetic-private-group' },
    }] };
  } });
  const getTrafficSummary = createTrafficSummaryService({ now: () => time, async run(requests) {
    counts.traffic++; assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.dimensionFilter.andGroup.expressions.length === 2));
    return { reports: requests.map(request => ({ metadata: { timeZone: 'Asia/Seoul' }, rowCount: 0, rows: [],
      metricHeaders: request.metrics, dimensionHeaders: request.dimensions })) };
  } });
  const member = () => { counts.membership++; assert.fail('보류한 멤버십 저장소 접근 금지'); };
  return { uid, counts, options: { auth, template, now: () => time, notices, getErrorSummary, getTrafficSummary,
    // CSV 미주입 상황의 503 계약도 유지한다.
    membershipCsv: undefined },
    get time() { return time; }, advance(value) { time += value; }, setRole(value) { role = value; },
    disable() { disabled = true; }, revoke() { revoked = true; },
  };
}

async function harness(surface = 'adminPages', supplied = {}) {
  const fixture = dependencies(); const env = { ...process.env, ...supplied.env };
  const external = { production: 0, proxy: 0 };
  const handlers = createAdminRouteHandlers({ env, emulatorDependencies: fixture.options,
    productionDependencies() { external.production++; assert.fail('운영 관리자 의존성 생성 금지'); },
    proxy() { external.proxy++; assert.fail('운영 관리자 프록시 접근 금지'); },
  });
  const base = await serve(handlers[surface]); let cookie = '';
  async function call(route = '/admin', options = {}) {
    const method = options.method || 'GET';
    const origin = surface === 'adminBackend' ? backendOrigin : base;
    const headers = { 'Content-Type': 'application/json', Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}), ...options.headers };
    if (Object.hasOwn(options, 'cookie')) { if (options.cookie) headers.Cookie = options.cookie; else delete headers.Cookie; }
    const url = surface === 'adminBackend' ? '/adminBackend?route=' + encodeURIComponent(route) : route;
    const response = await fetch(base + url, { method, headers, signal: AbortSignal.timeout(15000),
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(options.body || {}) }) });
    const text = await response.text();
    const result = { status: response.status, headers: response.headers, text,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
    if (options.expected !== undefined) assert.equal(result.status, options.expected, `${surface}: ${text}`);
    return result;
  }
  async function signIn(options = {}) {
    const result = await call('/admin/session', { method: 'POST', ...options,
      headers: { Authorization: 'Bearer synthetic-valid-token', ...options.headers } });
    if (result.status === 200) cookie = result.headers.get('set-cookie').split(';')[0];
    return result;
  }
  return { ...fixture, call, signIn, env, external, base, surface,
    get time() { return fixture.time; }, get cookie() { return cookie; },
    get key() { return createHash('sha256').update(decodeURIComponent(cookie.slice('__session='.length))).digest('hex'); },
    get store() { return runtime.getRtdbUserStorage().adminSessions; },
  };
}

for (const surface of ['adminPages', 'adminBackend']) {
  test(`일반 ${surface} RTDB 경로는 로그인·여섯 문서·활동·로그아웃 계약을 유지한다`, async () => {
    const app = await harness(surface);
    noDocument(await app.call('/admin', { expected: 200 }));
    const login = await app.signIn({ expected: 200 });
    assert.deepEqual(login.body, { success: true, role: 'owner' });
    assert.match(login.headers.get('set-cookie'), /Path=\/admin; HttpOnly; SameSite=Strict/);
    assert.equal(login.headers.get('set-cookie').includes('; Secure'), surface === 'adminBackend');
    const initial = await app.store.get(app.key);
    assert.deepEqual(initial, { uid: app.uid, lastActivity: app.time, expiresAt: app.time + ABSOLUTE_MS });
    const record = (await inspector.database.ref(`adminSessions/${encodeKey(app.key)}`).get()).val();
    assert.doesNotMatch(JSON.stringify(record), /synthetic-runtime-cookie|synthetic-valid-token|customClaims|membership/);
    app.advance(1000);
    for (const route of PAGES.keys()) {
      const page = await app.call(route, { expected: 200 });
      assert.match(page.text, /data-admin-role="owner"/);
      assert.doesNotMatch(page.text, /id="admin-settings"[^>]*hidden/);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'");
      if (surface === 'adminBackend') assert.equal(page.headers.get('x-ygo-admin-backend'), '1');
    }
    assert.equal((await app.call('/admin', { method: 'HEAD', expected: 200 })).text, '');
    assert.deepEqual(await app.store.get(app.key), initial);
    await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 204 });
    assert.equal((await app.store.get(app.key)).lastActivity, app.time);
    await app.call('/admin/session/logout', { method: 'POST', expected: 204 });
    assert.equal(await app.store.get(app.key), undefined);
    noDocument(await app.call('/admin', { expected: 200 }));
    await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 401 });
    assert.deepEqual(app.external, { production: 0, proxy: 0 });
  });

  test(`일반 ${surface} RTDB 공지 목록·미리보기·등록·수정·삭제는 기존 응답과 충돌 검사를 유지한다`, async () => {
    const app = await harness(surface);
    await app.call('/admin/api/notices', { expected: 401 }); assert.equal(app.counts.noticesRead, 0);
    await app.signIn({ expected: 200 });
    const list = await app.call('/admin/api/notices', { expected: 200 });
    assert.deepEqual(list.body, { success: true, revision: '0', notices: [], environment: 'synthetic' });
    const preview = await app.call('/admin/api/notices/preview', { method: 'POST', expected: 200,
      body: { title: '합성 <b>공지</b>', content: '<p>합성 본문</p><script>private()</script>' } });
    assert.equal(preview.body.success, true); assert.doesNotMatch(preview.body.content, /script|private/);
    assert.equal(app.counts.noticesWrite, 0);
    const added = await app.call('/admin/api/notices', { method: 'POST', expected: 200,
      body: { action: 'add', revision: list.body.revision, title: '합성 공지', content: '<p>합성 내용</p>', isPinned: 2 } });
    assert.equal(added.body.action, 'add'); assert.equal(added.body.notices.length, 1);
    const id = added.body.notice.id;
    const updated = await app.call('/admin/api/notices', { method: 'POST', expected: 200,
      body: { action: 'update', id, revision: added.body.revision, title: '수정한 합성 공지' } });
    assert.equal(updated.body.notice.title, '수정한 합성 공지');
    await app.call('/admin/api/notices', { method: 'POST', expected: 409,
      body: { action: 'delete', id, revision: added.body.revision } });
    await app.call('/admin/api/notices', { method: 'POST', expected: 404,
      body: { action: 'delete', id: 'synthetic-missing', revision: updated.body.revision } });
    await app.call('/admin/api/notices', { method: 'POST', expected: 403,
      headers: { Origin: 'https://synthetic-other.invalid' }, body: { action: 'delete', id, revision: updated.body.revision } });
    assert.equal(app.counts.noticesWrite, 2);
    const deleted = await app.call('/admin/api/notices', { method: 'POST', expected: 200,
      body: { action: 'delete', id, revision: updated.body.revision } });
    assert.equal(deleted.body.deletedId, id); assert.deepEqual(deleted.body.notices, []);
    await app.call('/admin/api/notices?unknown=1', { expected: 400 });
    assert.equal(app.counts.noticesWrite, 3);
    assert.deepEqual(app.external, { production: 0, proxy: 0 });
  });

  test(`일반 ${surface} RTDB 오류·방문 집계는 인증 후 고정 요약만 반환하고 현재 권한을 재검사한다`, async () => {
    const app = await harness(surface);
    for (const route of ['/admin/api/errors', '/admin/api/traffic']) await app.call(route, { expected: 401 });
    assert.equal(app.counts.errors + app.counts.traffic, 0);
    await app.signIn({ expected: 200 });
    const errors = await app.call('/admin/api/errors', { expected: 200 });
    assert.equal(errors.body.success, true); assert.equal(errors.body.occurrenceCount, 3);
    assert.deepEqual(errors.body.topErrors, [{ description: '처리 시간 초과', feature: '카드 데이터 처리', count: 3,
      lastSeen: new Date(app.time).toISOString() }]);
    assert.doesNotMatch(errors.text, /synthetic-private|example.invalid|groupId/);
    const traffic = await app.call('/admin/api/traffic', { expected: 200 });
    assert.deepEqual(traffic.body.current, { activeUsers: 0, sessions: 0, screenPageViews: 0 });
    assert.equal(traffic.body.daily.length, 30); assert.equal(traffic.body.timeZone, 'Asia/Seoul');
    for (const route of ['/admin/api/errors', '/admin/api/traffic']) {
      await app.call(route, { expected: 200 });
      await app.call(route + '?uid=synthetic', { expected: 400 });
      await app.call(route, { method: 'POST', expected: 405 });
    }
    assert.equal(app.counts.errors, 1); assert.equal(app.counts.traffic, 1);
    app.setRole('user');
    await app.call('/admin/api/errors', { expected: 401 });
    await app.call('/admin/api/traffic', { expected: 401 });
    assert.equal(app.counts.errors, 1); assert.equal(app.counts.traffic, 1);
    assert.equal(await app.store.get(app.key), undefined);
  });

  test(`일반 ${surface} RTDB 멤버십 경로는 보류 상태를 유지하며 주입된 서비스에도 접근하지 않는다`, async () => {
    const app = await harness(surface); await app.signIn({ expected: 200 });
    for (const [route, method] of [['/admin/api/membership-csv', 'GET'], ['/admin/api/membership-csv', 'POST'],
      ['/admin/api/membership-csv/preview', 'POST'], ['/admin/api/membership-csv/status', 'POST']]) {
      assert.deepEqual((await app.call(route, { method, expected: 503 })).body, { success: false });
    }
    assert.equal(app.counts.membership, 0); assert.deepEqual(app.external, { production: 0, proxy: 0 });
  });
}

test('일반 RTDB 관리자 경로는 관리자 권한·세션 철회·유휴 및 절대 만료를 유지한다', async () => {
  for (const surface of ['adminPages', 'adminBackend']) {
    const admin = await harness(surface); admin.setRole('admin'); await admin.signIn({ expected: 200 });
    assert.match((await admin.call('/admin', { expected: 200 })).text, /id="admin-settings"[^>]*hidden/);
    noDocument(await admin.call('/admin/settings', { expected: 403 }));
    for (const change of ['disable', 'revoke']) {
      const app = await harness(surface); await app.signIn({ expected: 200 }); app[change]();
      await app.call('/admin/api/notices', { expected: 401 });
      assert.equal(app.counts.noticesRead, 0);
    }
    const idle = await harness(surface); await idle.signIn({ expected: 200 }); idle.advance(IDLE_MS);
    const expired = await idle.call('/admin', { expected: 200 }); noDocument(expired);
    assert.match(expired.text, /data-admin-expired="true"/); assert.equal(await idle.store.get(idle.key), undefined);
    const absolute = await harness(surface); await absolute.signIn({ expected: 200 });
    const initial = await absolute.store.get(absolute.key); absolute.advance(ABSOLUTE_MS - 1);
    await absolute.store.set(absolute.key, { ...initial, lastActivity: absolute.time - 1 });
    await absolute.call('/admin/session/activity', { method: 'POST', body: { uid: absolute.uid }, expected: 204 });
    assert.equal((await absolute.store.get(absolute.key)).expiresAt, initial.expiresAt);
    absolute.advance(1);
    await absolute.call('/admin/session/activity', { method: 'POST', body: { uid: absolute.uid }, expected: 401 });
    assert.equal(await absolute.store.get(absolute.key), undefined);
  }
});

test('일반 RTDB 관리자 설정 오류·실행 도중 설정 변경은 운영 의존성과 프록시에 접근하기 전에 차단한다', async () => {
  const before = getApps().map(app => app.name).sort();
  for (const env of [{ NODE_ENV: 'production' }, { USER_STORAGE_BACKEND: 'unknown' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'synthetic-rtdb.invalid:9000' }, { USER_STORAGE_MODE: 'production' }]) {
    for (const surface of ['adminPages', 'adminBackend']) {
      const app = await harness(surface, { env });
      await app.signIn({ expected: 503 });
      assert.equal(app.counts.token, 0); assert.deepEqual(app.external, { production: 0, proxy: 0 });
    }
  }
  assert.deepEqual(getApps().map(app => app.name).sort(), before);
  const app = await harness(); await app.signIn({ expected: 200 });
  app.env.USER_DATABASE_URL = 'https://synthetic-rtdb.invalid';
  await app.call('/admin/api/notices', { expected: 503 });
  assert.equal(app.counts.noticesRead, 0); assert.deepEqual(app.external, { production: 0, proxy: 0 });
});

test('일반 관리자 실제 export는 합성 의존성 없는 RTDB 에뮬레이터에서 운영 SDK·프록시를 호출하지 않는다', async () => {
  const filename = path.join(__dirname, '../routes/admin/pages.js');
  const loaded = new Module(filename, module); const requested = [], registrations = [];
  const allowed = {
    'firebase-functions/v2/https': { onRequest(options, handler) { registrations.push(options); return handler; } },
    'node:fs/promises': fs, 'node:path': path,
    '../../services/adminPageRuntime': { createAdminRouteHandlers },
    '../../services/adminTransport': { ...transport, createAdminProxy() { return () => assert.fail('운영 프록시 접근 금지'); } },
  };
  loaded.filename = filename;
  loaded.require = name => {
    requested.push(name); assert.ok(Object.hasOwn(allowed, name), `일반 export의 운영 의존성 접근 금지: ${name}`);
    return allowed[name];
  };
  loaded._compile(readSourceFile(filename, 'utf8'), filename);
  assert.equal(registrations.length, 2);
  for (const surface of ['adminPages', 'adminBackend']) {
    const base = await serve(loaded.exports[surface]);
    const route = surface === 'adminBackend' ? '/adminBackend?route=%2Fadmin%2Fapi%2Fnotices' : '/admin/api/notices';
    const response = await fetch(base + route, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { success: false });
  }
  assert.ok(requested.every(name => !/config\/firebase|googleapis|membershipCsvService/.test(name)));
  assert.ok(getApps().every(app => app.name.startsWith('user-storage-test-')));
});
