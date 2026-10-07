/** 서버가 검증한 Firebase 세션으로만 관리자 문서를 제공한다. */
const { createHash } = require('node:crypto');
const cheerio = require('cheerio');
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const PAGES = new Map([['/admin', 'home'], ['/admin/notices', 'notices'], ['/admin/cards', 'cards'],
  ['/admin/server-logs', 'server-logs'], ['/admin/admin-logs', 'admin-logs'], ['/admin/settings', 'settings']]);
const hash = cookie => createHash('sha256').update(cookie).digest('hex');
function cookieOf(req) {
  const values = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith('__session='));
  if (values.length !== 1) return '';
  try { return decodeURIComponent(values[0].slice(10)); } catch { return ''; }
}
function originOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${protocol}://${host}`;
}
function localHttp(origin) {
  try { const u = new URL(origin); return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }
  catch { return false; }
}
function roleOf(user) {
  const c = user.customClaims || {};
  return c.role === 'owner' ? 'owner' : c.admin === true || c.role === 'admin' ? 'admin' : null;
}
function createMemoryStore() {
  const entries = new Map();
  return {
    async get(key) { return entries.get(key); },
    async set(key, value) {
      for (const [id, entry] of entries) if (entry.expiresAt <= value.lastActivity || value.lastActivity - entry.lastActivity >= IDLE_MS) entries.delete(id);
      entries.set(key, value);
    },
    async remove(key) { entries.delete(key); },
    async touch(key, uid, now) {
      const value = entries.get(key);
      if (!value || value.uid !== uid || value.expiresAt <= now || now - value.lastActivity >= IDLE_MS) return false;
      entries.set(key, { ...value, lastActivity: now }); return true;
    }
  };
}
function createFirestoreStore(db) {
  const doc = key => db.collection('AdminWebSessions').doc(key);
  return {
    async get(key) { const s = await doc(key).get(); return s.exists ? s.data() : undefined; },
    async set(key, value) { await doc(key).set(value); },
    async remove(key) { await doc(key).delete(); },
    async touch(key, uid, now) {
      return db.runTransaction(async tx => {
        const ref = doc(key); const snapshot = await tx.get(ref); const value = snapshot.data();
        if (!value || value.uid !== uid || value.expiresAt <= now || now - value.lastActivity >= IDLE_MS) return false;
        tx.update(ref, { lastActivity: now }); return true;
      });
    }
  };
}
async function renderAdminDocument({ template, pathname, access, code = 200, expired = false }) {
  const $ = cheerio.load(await template(access ? PAGES.get(pathname) : 'home'));
  $('body').attr('data-admin-page', pathname);
  if (access) {
    const title = $('#admin-content').attr('data-admin-title');
    $('#admin-login').attr('hidden', '');
    $('#admin-content').removeAttr('hidden').attr('data-admin-uid', access.uid).attr('data-admin-role', access.role);
    if (access.role === 'owner') $('#admin-settings').removeAttr('hidden');
    $('title').text(`${title} · 관리자 · YGO Synapse`);
  } else {
    $('#admin-content').remove();
    if (code === 403) $('body').attr('data-admin-denied', 'true');
    if (code === 503) $('body').attr('data-admin-unavailable', 'true');
    if (expired) $('body').attr('data-admin-expired', 'true');
  }
  return $.html();
}
function createAdminPageHandler({ auth, store, template, getErrorSummary, getTrafficSummary, notices, now = Date.now }) {
  function setCookie(req, res, value) {
    const secure = !localHttp(originOf(req));
    // 쿠키 자체는 브라우저 세션 동안만 유지하고 만료는 서버에서 검사한다.
    res.set('Set-Cookie', `__session=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${value ? '' : '; Max-Age=0'}`);
  }
  async function checkedSession(req, currentClaims = true) {
    const cookie = cookieOf(req);
    if (!cookie) return null;
    let decoded;
    try { decoded = await auth.verifySessionCookie(cookie, true); }
    catch (error) {
      if (['auth/invalid-session-cookie', 'auth/session-cookie-expired', 'auth/session-cookie-revoked', 'auth/user-disabled', 'auth/user-not-found', 'auth/argument-error', 'auth/invalid-argument'].includes(error.code)) return null;
      throw error;
    }
    const key = hash(cookie); const value = await store.get(key); const time = now();
    if (!value || value.uid !== decoded.uid || value.expiresAt <= time || time - value.lastActivity >= IDLE_MS) {
      if (value) await store.remove(key);
      return null;
    }
    if (!currentClaims) return { uid: decoded.uid, key };
    const user = await auth.getUser(decoded.uid); const role = roleOf(user);
    if (user.disabled || !role) { await store.remove(key); return null; }
    return { uid: decoded.uid, role, key };
  }
  async function render(req, res, pathname, access, code = 200, expired = false) {
    return res.status(code).type('html').send(await renderAdminDocument({ template, pathname, access, code, expired }));
  }
  return async function adminPage(req, res) {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    const pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
    const errorApi = pathname === '/admin/api/errors' || pathname === '/admin/api/traffic';
    const getSummary = pathname === '/admin/api/traffic' ? getTrafficSummary : getErrorSummary;
    const noticeApi = pathname === '/admin/api/notices' || pathname === '/admin/api/notices/preview';
    const noticeWrite = noticeApi && req.method === 'POST';
    if (noticeApi && !['GET','POST'].includes(req.method)) return res.status(405).json({success:false});
    if (pathname.endsWith('/preview') && req.method !== 'POST') return res.status(405).json({success:false});
    const endpoint = ['/admin/session', '/admin/session/activity', '/admin/session/logout'].includes(pathname);
    if (errorApi && req.method !== 'GET') return res.status(405).json({ success: false });
    if (endpoint || noticeWrite) {
      if (req.method !== 'POST') return res.status(405).json({ success: false });
      const origin = originOf(req);
      if (req.headers.origin !== origin || !(origin.startsWith('https://') || localHttp(origin))
          || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return res.status(403).json({ success: false });
      }
    } else if (!errorApi && !noticeApi && !PAGES.has(pathname)) return res.status(404).send('페이지를 찾을 수 없습니다.');
    else if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).send('허용되지 않는 요청입니다.');
    try {
      if (noticeApi) {
        const access = await checkedSession(req);
        if (!access) return res.status(401).json({success:false});
        if (!notices) return res.status(503).json({success:false});
        if (new URL(req.originalUrl || req.url,'http://localhost').search) return res.status(400).json({success:false});
        const result = pathname.endsWith('/preview') ? await notices.preview(req.body)
          : req.method === 'GET' ? await notices.list() : await notices.mutate(req.body);
        return res.json({success:true,...result});
      }
      if (errorApi) {
        const access = await checkedSession(req);
        if (!access) {
          // 뒤이은 문서 요청이 만료 상태를 식별하여 공유 Firebase 로그인도 종료한다.
          return res.status(401).json({ success: false });
        }
        if (!getSummary || new URL(req.originalUrl || req.url, 'http://localhost').search) {
          return res.status(getSummary ? 400 : 503).json({ success: false });
        }
        return res.json({ success: true, ...(await getSummary()) });
      }
      if (pathname === '/admin/session/logout') {
        const cookie = cookieOf(req); if (cookie) await store.remove(hash(cookie));
        setCookie(req, res, ''); return res.status(204).send('');
      }
      if (pathname === '/admin/session') {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return res.status(401).json({ success: false });
        let decoded;
        try { decoded = await auth.verifyIdToken(header.slice(7), true); }
        catch { return res.status(401).json({ success: false }); }
        const user = await auth.getUser(decoded.uid); const role = roleOf(user);
        if (user.disabled) return res.status(401).json({ success: false });
        if (!role) return res.status(403).json({ success: false });
        const old = cookieOf(req); if (old) await store.remove(hash(old));
        const cookie = await auth.createSessionCookie(header.slice(7), { expiresIn: ABSOLUTE_MS });
        const time = now();
        await store.set(hash(cookie), { uid: decoded.uid, lastActivity: time, expiresAt: time + ABSOLUTE_MS });
        setCookie(req, res, cookie); return res.json({ success: true, role });
      }
      if (pathname === '/admin/session/activity') {
        const access = await checkedSession(req, false);
        if (!access || !await store.touch(access.key, req.body?.uid, now())) {
          setCookie(req, res, ''); return res.status(401).json({ success: false });
        }
        return res.status(204).send('');
      }
      const access = await checkedSession(req);
      if (!access) {
        const expired = !!cookieOf(req); if (expired) setCookie(req, res, '');
        return render(req, res, pathname, null, 200, expired);
      }
      if (pathname === '/admin/settings' && access.role !== 'owner') return render(req, res, pathname, null, 403);
      return render(req, res, pathname, access);
    } catch (error) {
      // 오류 원문이나 계정·쿠키·토큰은 출력하지 않는다.
      if (noticeApi && [400,404,409].includes(error.status)) return res.status(error.status).json({success:false,message:error.message});
      return endpoint || errorApi || noticeApi ? res.status(503).json({ success: false }) : render(req, res, pathname, null, 503);
    }
  };
}
module.exports = { createAdminPageHandler, createMemoryStore, createFirestoreStore, PAGES, IDLE_MS, ABSOLUTE_MS, cookieOf, originOf, localHttp, renderAdminDocument };
