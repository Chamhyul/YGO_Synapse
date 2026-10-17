'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const { getApps } = require('firebase-admin/app');
const { readSourceFile } = require('./sourceFile');
const { createUserStorageConnection } = require('../config/userStorage');
const runtime = require('../services/userStorageRuntime');
const sessionModule = require('../services/adminPageSession');
const { encodeKey } = require('../services/user-storage/codec');
const { IDLE_MS, ABSOLUTE_MS, PAGES } = sessionModule;

// 실제 Express·설정 선택·공유 RTDB 연결·세션 저장소를 함께 검사한다.
// Auth는 합성이며 실제 관리자 HTML 템플릿을 렌더링한다.
// 운영 인증·프록시·Firestore·Storage는 사용하지 않는다.
const inspector = createUserStorageConnection(), servers = [];
let sequence = 0;
after(async () => {
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  })));
  await runtime.closeRtdbUserStorage();
  await inspector.close();
});
const hash = value => createHash('sha256').update(value).digest('hex');
const recordPath = key => `adminSessions/${encodeKey(key)}`;
const raw = async key => (await inspector.database.ref(recordPath(key)).get()).val();
const template = name => fs.readFile(path.join(__dirname, '../templates/admin', `${name}.html`), 'utf8');

function loadFactory() {
  const filename = path.join(__dirname, '../services/adminSessionRepository.js');
  const loaded = new Module(filename, module);
  const allowed = { './adminPageSession': sessionModule, './userStorageRuntime': runtime };
  loaded.filename = filename;
  loaded.require = name => {
    assert.ok(Object.hasOwn(allowed, name), `관리자 RTDB 시험의 외부 의존성 접근 금지: ${name}`);
    return allowed[name];
  };
  loaded._compile(readSourceFile(filename, 'utf8'), filename);
  return loaded.exports;
}

async function harness({ role = 'owner', disabled = false } = {}) {
  const id = ++sequence, uid = `synthetic-admin-http-${id}`;
  let time = 20000000, cookie = '', issue = 0, revoked = false, authFailure = false, decodedUid = uid;
  const authCalls = [], issued = new Set();
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      authCalls.push(['token', token, checkRevoked]);
      assert.equal(checkRevoked, true);
      if (token !== 'synthetic-valid-token') throw Object.assign(new Error('synthetic-private-invalid-token'), { code: 'auth/invalid-id-token' });
      return { uid, role: 'owner', admin: true };
    },
    async getUser(actualUid) {
      authCalls.push(['user', actualUid]);
      if (authFailure) throw new Error('synthetic-private-auth-secret');
      assert.equal(actualUid, uid);
      return { uid, disabled, customClaims: role === 'admin-flag' ? { admin: true } : { role } };
    },
    async createSessionCookie(token, options) {
      authCalls.push(['issue', token, options]);
      assert.deepEqual(options, { expiresIn: ABSOLUTE_MS });
      const value = `synthetic-admin-cookie:${id}:${++issue}`;
      issued.add(value); return value;
    },
    async verifySessionCookie(value, checkRevoked) {
      authCalls.push(['cookie', checkRevoked]);
      assert.equal(checkRevoked, true);
      if (authFailure) throw new Error('synthetic-private-auth-secret');
      if (revoked || !issued.has(value)) throw Object.assign(new Error('synthetic-private-revoked-cookie'), { code: 'auth/session-cookie-revoked' });
      return { uid: decodedUid };
    },
  };
  const forbidden = () => assert.fail('보류한 멤버십·운영 서비스 접근 금지');
  const factory = loadFactory();
  const handler = factory.createConfiguredAdminPageHandler({ auth, template, now: () => time,
    membershipCsv: { summary: forbidden, preview: forbidden, status: forbidden, apply: forbidden },
  });
  const app = express(); app.use(express.json()); app.use(handler);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route = '/admin', options = {}) {
    const method = options.method || 'GET';
    const headers = { 'Content-Type': 'application/json', Origin: base,
      ...(cookie ? { Cookie: cookie } : {}), ...options.headers };
    if (Object.hasOwn(options, 'cookie')) { if (options.cookie) headers.Cookie = options.cookie; else delete headers.Cookie; }
    if (options.secure) {
      headers['X-Forwarded-Host'] = 'synthetic-admin.invalid'; headers['X-Forwarded-Proto'] = 'https';
      headers.Origin = 'https://synthetic-admin.invalid';
    }
    if (options.noOrigin) delete headers.Origin;
    const response = await fetch(base + route, { method, headers, signal: AbortSignal.timeout(15000),
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(options.body || {}) }),
    });
    const text = await response.text();
    const result = { status: response.status, headers: response.headers, text,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
    if (options.expected !== undefined) assert.equal(result.status, options.expected, text);
    return result;
  }
  async function signIn(options = {}) {
    const result = await call('/admin/session', { method: 'POST', ...options,
      headers: { Authorization: 'Bearer synthetic-valid-token', ...options.headers } });
    if (result.status === 200) cookie = result.headers.get('set-cookie').split(';')[0];
    return result;
  }
  return { call, signIn, authCalls, uid, store: factory.getAdminSessionStore(),
    get cookie() { return cookie; }, get key() { return hash(decodeURIComponent(cookie.slice('__session='.length))); },
    get time() { return time; }, advance(ms) { time += ms; }, role(value) { role = value; },
    disable() { disabled = true; }, revoke() { revoked = true; }, failAuth() { authFailure = true; },
    mismatchUid() { decodedUid = 'synthetic-other-admin'; },
  };
}

const noDocument = result => assert.doesNotMatch(result.text, /id="admin-content"/);

test('HTTP 관리자 RTDB 로그인은 현재 권한과 철회를 검사하고 기존 세션 쿠키 계약을 유지한다', async () => {
  const app = await harness();
  const before = await app.call('/admin/cards', { expected: 200 }); noDocument(before);
  assert.equal(app.authCalls.length, 0);
  const login = await app.signIn();
  assert.equal(login.status, 200); assert.deepEqual(login.body, { success: true, role: 'owner' });
  assert.match(login.headers.get('set-cookie'), /Path=\/admin; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(login.headers.get('set-cookie'), /Secure|Expires|Max-Age/);
  assert.deepEqual(await app.store.get(app.key), { uid: app.uid, lastActivity: app.time, expiresAt: app.time + ABSOLUTE_MS });
  assert.doesNotMatch(JSON.stringify(await raw(app.key)), /synthetic-admin-cookie|synthetic-valid-token|customClaims|membership/);
  const secure = await (await harness()).signIn({ secure: true });
  assert.match(secure.headers.get('set-cookie'), /; Secure$/);
  assert.ok(getApps().every(application => application.name.startsWith('user-storage-test-')));
});

test('HTTP RTDB 관리자 여섯 문서는 owner에게 제공하며 GET·HEAD가 활동 시각을 갱신하지 않는다', async () => {
  const app = await harness(); await app.signIn();
  const initial = await raw(app.key); app.advance(IDLE_MS - 1);
  for (const route of PAGES.keys()) {
    const response = await app.call(route, { expected: 200 });
    assert.match(response.text, /data-admin-role="owner"/);
    assert.doesNotMatch(response.text, /id="admin-settings"[^>]*hidden/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  }
  const head = await app.call('/admin', { method: 'HEAD', expected: 200 }); assert.equal(head.text, '');
  assert.deepEqual(await raw(app.key), initial);
});

test('HTTP RTDB 일반 관리자는 설정 문서 권한이 없고 일반·조작·비활성 계정은 로그인하지 못한다', async () => {
  for (const role of ['admin', 'admin-flag']) {
    const app = await harness({ role }); await app.signIn();
    const home = await app.call('/admin', { expected: 200 });
    assert.match(home.text, /data-admin-role="admin"/);
    assert.match(home.text, /id="admin-settings"[^>]*hidden/);
    noDocument(await app.call('/admin/settings', { expected: 403 }));
  }
  const user = await harness({ role: 'user' });
  assert.equal((await user.signIn({ body: { role: 'owner', admin: true, uid: 'owner' } })).status, 403);
  assert.equal((await (await harness({ disabled: true })).signIn()).status, 401);
  const forged = await harness();
  assert.equal((await forged.signIn({ headers: { Authorization: 'Bearer forged' } })).status, 401);
  assert.equal((await forged.call('/admin/session', { method: 'POST' })).status, 401);
});

test('HTTP RTDB 관리자 쓰기는 기존 Origin·JSON·메서드 검사를 통과해야 한다', async () => {
  const app = await harness();
  for (const options of [{ headers: { Origin: 'https://other.invalid' } }, { noOrigin: true },
    { headers: { 'Content-Type': 'text/plain' } }]) {
    assert.equal((await app.signIn(options)).status, 403);
  }
  assert.equal(app.authCalls.length, 0);
  for (const route of ['/admin/session', '/admin/session/activity', '/admin/session/logout']) await app.call(route, { expected: 405 });
  await app.call('/admin.html', { expected: 404 });
});

test('HTTP RTDB 관리자 활동은 같은 UID만 갱신하며 유휴 30분 경계 이후에는 세션이 되살아나지 않는다', async () => {
  const app = await harness(); await app.signIn(); const key = app.key;
  app.advance(IDLE_MS - 1);
  const wrong = await app.call('/admin/session/activity', { method: 'POST', body: { uid: 'other' }, expected: 401 });
  assert.match(wrong.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.store.get(key)).lastActivity, app.time - IDLE_MS + 1);
  await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 204 });
  assert.equal((await app.store.get(key)).lastActivity, app.time);
  app.advance(IDLE_MS);
  const expired = await app.call('/admin', { expected: 200 }); noDocument(expired);
  assert.match(expired.text, /data-admin-expired="true"/);
  assert.equal(await app.store.get(key), undefined);
  await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 401 });
  assert.equal((await raw(key)).tombstone, true);
});

test('HTTP RTDB 관리자 세션은 활동해도 12시간 절대 만료를 연장하지 않는다', async () => {
  const app = await harness(); await app.signIn();
  const initial = await app.store.get(app.key);
  // 절대 만료 직전의 합성 활동 상태만 준비하고 실제 HTTP 요청으로 경계를 검사한다.
  app.advance(ABSOLUTE_MS - 1);
  await app.store.set(app.key, { ...initial, lastActivity: app.time - 1 });
  await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 204 });
  assert.equal((await app.store.get(app.key)).expiresAt, initial.expiresAt);
  app.advance(1);
  await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 401 });
  assert.equal(await app.store.get(app.key), undefined);
});

test('HTTP RTDB 관리자 로그아웃은 복사한 쿠키를 무효화하고 임의·부재 쿠키는 새 레코드를 만들지 않는다', async () => {
  const app = await harness(); await app.signIn(); const key = app.key;
  const logout = await app.call('/admin/session/logout', { method: 'POST', expected: 204 });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await app.store.get(key), undefined);
  noDocument(await app.call('/admin', { expected: 200 }));
  await app.call('/admin/session/activity', { method: 'POST', body: { uid: app.uid }, expected: 401 });
  await app.call('/admin/session/logout', { method: 'POST', cookie: '', expected: 204 });
  const fake = `synthetic-unissued-cookie-${app.uid}`;
  await app.call('/admin/session/logout', { method: 'POST', cookie: `__session=${fake}`, expected: 204 });
  assert.equal(await raw(hash(fake)), null);
});

test('HTTP RTDB 관리자 권한 회수·계정 비활성·서명 철회·UID 불일치를 다음 요청에 반영한다', async () => {
  for (const action of ['role', 'disable', 'revoke', 'mismatchUid']) {
    const app = await harness(); await app.signIn();
    if (action === 'role') app.role('user'); else app[action]();
    noDocument(await app.call('/admin', { expected: 200 }));
    await app.call('/admin/api/errors', { expected: 401 });
    if (action !== 'revoke') assert.equal(await app.store.get(app.key), undefined);
  }
  const app = await harness(); await app.signIn(); app.role('admin');
  noDocument(await app.call('/admin/settings', { expected: 403 }));
});

test('HTTP RTDB 관리자 미주입 기능과 보류한 멤버십 CSV는 인증 후에도 503이며 다른 저장소로 우회하지 않는다', async () => {
  const app = await harness(); await app.signIn();
  for (const route of ['/admin/api/errors', '/admin/api/traffic', '/admin/api/notices', '/admin/api/membership-csv']) {
    const result = await app.call(route, { expected: 503 }); assert.deepEqual(result.body, { success: false });
  }
  for (const route of ['/admin/api/notices', '/admin/api/notices/preview', '/admin/api/membership-csv',
    '/admin/api/membership-csv/preview', '/admin/api/membership-csv/status']) {
    const result = await app.call(route, { method: 'POST', expected: 503 }); assert.deepEqual(result.body, { success: false });
  }
});

test('HTTP RTDB 관리자 인증 장애·손상 세션은 503으로 차단하고 오류와 관리자 내용을 노출하지 않는다', async () => {
  const auth = await harness(); await auth.signIn(); auth.failAuth();
  const failed = await auth.call('/admin', { expected: 503 }); noDocument(failed);
  assert.match(failed.text, /data-admin-unavailable="true"/);
  assert.doesNotMatch(failed.text, /synthetic-private-auth-secret/);
  assert.deepEqual((await auth.call('/admin/session/activity', { method: 'POST', body: { uid: auth.uid }, expected: 503 })).body, { success: false });
  const damaged = await harness(); await damaged.signIn();
  const original = { format: 999, synthetic: 'synthetic-private-db-secret' };
  await inspector.database.ref(recordPath(damaged.key)).set(original);
  const document = await damaged.call('/admin', { expected: 503 }); noDocument(document);
  assert.doesNotMatch(document.text, /synthetic-private-db-secret|USER_STORAGE_/);
  const logout = await damaged.call('/admin/session/logout', { method: 'POST', expected: 503 });
  assert.deepEqual(logout.body, { success: false });
  assert.deepEqual(await raw(damaged.key), original);
});
