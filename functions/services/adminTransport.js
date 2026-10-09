/** 로컬은 요청을 전달하고 운영 서버만 계정 권한과 데이터 접근을 결정한다. */
const { PAGES, cookieOf, originOf, localHttp, renderAdminDocument } = require('./adminPageSession');
const cheerio = require('cheerio');
const BACKEND_URL = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net/adminBackend';
const BACKEND_HEADER = 'X-YGO-Admin-Backend';
const ROUTES = new Set([...PAGES.keys(), '/admin/api/errors', '/admin/api/traffic',
  '/admin/api/notices', '/admin/api/notices/preview', '/admin/session',
  '/admin/api/membership-csv', '/admin/api/membership-csv/preview', '/admin/api/membership-csv/status',
  '/admin/session/activity', '/admin/session/logout']);
function routeOf(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.length > 4096) return null;
  const parsed = new URL(route, 'https://admin.invalid');
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  return ROUTES.has(pathname) ? { pathname, route: pathname + parsed.search } : null;
}
function unavailable(res, pathname) {
  if (pathname.startsWith('/admin/api/') || pathname.startsWith('/admin/session')) {
    return res.status(503).json({ success: false });
  }
  return res.status(503).type('html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><title>관리자 서버 연결 오류</title><p>운영 관리자 서버에 연결할 수 없습니다. 운영 API 배포 상태를 확인한 뒤 새로고침해 주세요.</p></html>');
}
function emulatorConfigured(env) {
  return env.FUNCTIONS_EMULATOR === 'true' || !!env.FIREBASE_EMULATOR_HUB
    || !!env.FIRESTORE_EMULATOR_HOST || !!env.FIREBASE_STORAGE_EMULATOR_HOST || !!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function createAdminBackendHandler({ handler, env = process.env }) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    // 에뮬레이터에서 운영 권한 판정자나 직접 데이터 접근 경로를 실행하지 않는다.
    if (emulatorConfigured(env)) return res.status(503).json({ success: false });
    const query = new URL(req.originalUrl || req.url, BACKEND_URL).searchParams;
    if (query.getAll('route').length !== 1 || [...query.keys()].some(key => key !== 'route')) return res.status(404).json({ success: false });
    const selected = routeOf(query.get('route'));
    if (!selected) return res.status(404).json({ success: false });
    res.set(BACKEND_HEADER, '1');
    req.originalUrl = req.url = selected.route;
    // 직접 Functions 주소의 기준 출처는 운영 서버가 고정한다.
    req.headers['x-forwarded-host'] = new URL(BACKEND_URL).host;
    req.headers['x-forwarded-proto'] = 'https';
    return handler(req, res);
  };
}
function createLocalAdminRenderer(template) {
  return async (html, pathname, code) => {
    const $ = cheerio.load(html);
    const content = $('#admin-content');
    let access = null;
    if (content.length) {
      const uid = content.attr('data-admin-uid'), role = content.attr('data-admin-role');
      if (!uid || !['admin', 'owner'].includes(role)) throw Error('관리자 응답 형식이 올바르지 않습니다.');
      access = { uid, role };
    }
    // 운영에서 확인한 접근 결과로 로컬 템플릿을 렌더링한다. 데이터 권한은 계속 운영에서 검사한다.
    return renderAdminDocument({ template, pathname, access, code, expired: $('body').attr('data-admin-expired') === 'true' });
  };
}
function createAdminProxy({ fetchImpl = fetch, renderDocument } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const selected = routeOf(req.originalUrl || req.url);
    if (!selected) return res.status(404).send('페이지를 찾을 수 없습니다.');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.status(405).json({ success: false });
    const sourceOrigin = originOf(req);
    if (req.method === 'POST' && (req.headers.origin !== sourceOrigin
        || !(sourceOrigin.startsWith('https://') || localHttp(sourceOrigin))
        || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))) {
      return res.status(403).json({ success: false });
    }
    const headers = {};
    // 사용자 인증 정보만 전달한다. 로컬 서비스 계정 키·역할·UID 주장으로 인증하지 않는다.
    const cookie = cookieOf(req);
    if (cookie) headers.Cookie = '__session=' + encodeURIComponent(cookie);
    if (req.method === 'POST') {
      headers.Origin = new URL(BACKEND_URL).origin;
      headers['Content-Type'] = 'application/json';
      if (selected.pathname === '/admin/session' && typeof req.headers.authorization === 'string') {
        headers.Authorization = req.headers.authorization;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const target = new URL(BACKEND_URL); target.searchParams.set('route', selected.route);
      const response = await fetchImpl(target.toString(), {
        method: req.method, headers, redirect: 'error', signal: controller.signal,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body || {}) } : {})
      });
      // 미배포·이전 서버·로그인 리다이렉트 등을 관리자 인증 성공으로 해석하지 않는다.
      if (response.headers.get(BACKEND_HEADER) !== '1') return unavailable(res, selected.pathname);
      let body = await response.text();
      if (renderDocument && PAGES.has(selected.pathname) && String(response.headers.get('Content-Type') || '').includes('html')) {
        body = await renderDocument(body, selected.pathname, response.status);
      }
      for (const name of ['Content-Type', 'X-Robots-Tag', 'X-Content-Type-Options', 'Content-Security-Policy']) {
        const value = response.headers.get(name); if (value) res.set(name, value);
      }
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie && setCookie.startsWith('__session=')) {
        // 루프백 HTTP 개발에만 Secure를 제거하며 HttpOnly/SameSite/Path는 유지한다.
        res.set('Set-Cookie', localHttp(sourceOrigin) ? setCookie.replace(/;\s*Secure\b/gi, '') : setCookie);
      }
      return res.status(response.status).send(body);
    } catch (_) {
      return unavailable(res, selected.pathname);
    } finally { clearTimeout(timer); }
  };
}
module.exports = { createAdminProxy, createAdminBackendHandler, createLocalAdminRenderer, emulatorConfigured, BACKEND_URL, BACKEND_HEADER };
