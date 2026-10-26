/** 서버가 검증한 Firebase 세션으로만 관리자 문서를 제공한다. */
const { createHash } = require('node:crypto');
const cheerio = require('cheerio');
const { currentAdminUser } = require('./adminSessionIdentity');
const { measure } = require('./adminRequestTiming');
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
async function renderAdminDocument({ template, source: preparedSource, pathname, access, code = 200, expired = false }) {
  return measure('admin.html', async () => {
  const source = preparedSource ?? await measure('admin.html.template', () => template(access ? PAGES.get(pathname) : 'home'));
  const $ = measure('admin.html.parse', () => cheerio.load(source));
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
  return measure('admin.html.serialize', () => $.html());
  });
}
function createAdminPageHandler({ auth, store, template, getErrorSummary, getTrafficSummary, notices, membershipCsv, now = Date.now }) {
  function setCookie(req, res, value) {
    const secure = !localHttp(originOf(req));
    // 쿠키 자체는 브라우저 세션 동안만 유지하고 만료는 서버에서 검사한다.
    res.set('Set-Cookie', `__session=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${value ? '' : '; Max-Age=0'}`);
  }
  async function verifiedSessionIdentity(req) {
    const cookie = cookieOf(req);
    if (!cookie) return null;
    try { return await measure('admin.auth.jwt', () => auth.verifySessionCookie(cookie, false)); }
    catch (error) {
      if (['auth/invalid-session-cookie', 'auth/session-cookie-expired', 'auth/session-cookie-revoked', 'auth/user-disabled', 'auth/user-not-found', 'auth/argument-error', 'auth/invalid-argument'].includes(error.code)) return null;
      throw error;
    }
  }
  async function prepareActivityIdentity(req) {
    const decoded = await verifiedSessionIdentity(req);
    if (!decoded) return null;
    const account = measure('admin.auth.account', () => currentAdminUser(auth, decoded, 'auth/session-cookie-revoked', req));
    // route 실패 시에도 아래 finally가 정리한다. 병렬 시작 중 unhandled rejection은 막는다.
    account.catch(() => {});
    return { decoded, account };
  }
  async function checkedSession(req, currentClaims = true, { readOnly = false, confirmSession = false, identityOnly = false, sessionObservation, preparedIdentity } = {}) {
    return measure(confirmSession ? 'admin.auth.final' : 'admin.auth.initial', async () => {
    const cookie = cookieOf(req);
    if (!cookie) return null;
    const prepared = preparedIdentity ? await preparedIdentity : null;
    const decoded = preparedIdentity ? prepared?.decoded : await verifiedSessionIdentity(req);
    if (!decoded) return null;
    const key = hash(cookie);
    // 세션 조회와 현재 Auth 조회는 독립 읽기다. 양쪽을 모두 정리한 뒤 판정한다.
    const [sessionRead, accountRead] = await Promise.allSettled([
      sessionObservation?.key === key ? Promise.resolve(sessionObservation.observedSession)
        : measure('admin.session.get', () => store.get(key)),
      prepared ? prepared.account : identityOnly ? Promise.resolve(null) : measure('admin.auth.account', () => currentAdminUser(auth, decoded,
        'auth/session-cookie-revoked', req, { fresh: confirmSession })),
    ]);
    if (sessionRead.status === 'rejected') throw sessionRead.reason;
    const value = sessionRead.value, time = now();
    if (!value || value.uid !== decoded.uid || value.expiresAt <= time || time - value.lastActivity >= IDLE_MS) {
      if (value && !readOnly) await store.remove(key, value);
      return null;
    }
    // 정적 템플릿 준비 전에는 세션 신원만 확인한다. 권한을 부여하거나 반환하지 않는다.
    if (identityOnly) return { uid: decoded.uid, key, observedSession: value };
    let user;
    try { if (accountRead.status === 'rejected') throw accountRead.reason; user = accountRead.value; }
    catch (error) {
      if (error.code === 'auth/user-disabled') { if (!readOnly) await store.remove(key, value); return null; }
      if (['auth/session-cookie-revoked', 'auth/user-not-found'].includes(error.code)) return null;
      throw error;
    }
    if (!currentClaims) return { uid: decoded.uid, key };
    const role = roleOf(user);
    if (user.disabled || !role) { if (!readOnly) await store.remove(key, value); return null; }
    if (confirmSession) {
      const latest = await measure('admin.session.confirm', () => store.get(key)), checkedAt = now();
      if (!latest || latest.uid !== decoded.uid || latest.expiresAt <= checkedAt
          || checkedAt - latest.lastActivity >= IDLE_MS) return null;
    }
    return { uid: decoded.uid, role, key };
    });
  }
  async function render(req, res, pathname, access, code = 200, expired = false) {
    return res.status(code).type('html').send(await renderAdminDocument({ template, pathname, access, code, expired }));
  }
  const handler = async function adminPage(req, res) {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    const pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
    const errorApi = pathname === '/admin/api/errors' || pathname === '/admin/api/traffic';
    const getSummary = pathname === '/admin/api/traffic' ? getTrafficSummary : getErrorSummary;
    const noticeApi = pathname === '/admin/api/notices' || pathname === '/admin/api/notices/preview';
    const noticeWrite = noticeApi && req.method === 'POST';
    const membershipApi = ['/admin/api/membership-csv', '/admin/api/membership-csv/preview', '/admin/api/membership-csv/status'].includes(pathname);
    if (membershipApi && (pathname !== '/admin/api/membership-csv' ? req.method !== 'POST' : !['GET','POST'].includes(req.method))) return res.status(405).json({success:false});
    if (noticeApi && !['GET','POST'].includes(req.method)) return res.status(405).json({success:false});
    if (pathname.endsWith('/preview') && req.method !== 'POST') return res.status(405).json({success:false});
    const endpoint = ['/admin/session', '/admin/session/activity', '/admin/session/logout'].includes(pathname);
    if (errorApi && req.method !== 'GET') return res.status(405).json({ success: false });
    if (endpoint || noticeWrite || membershipApi && req.method === 'POST') {
      if (req.method !== 'POST') return res.status(405).json({ success: false });
      const origin = originOf(req);
      if (req.headers.origin !== origin || !(origin.startsWith('https://') || localHttp(origin))
          || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return res.status(403).json({ success: false, code: 'ADMIN_REQUEST_REJECTED' });
      }
    } else if (!errorApi && !noticeApi && !membershipApi && !PAGES.has(pathname)) return res.status(404).send('페이지를 찾을 수 없습니다.');
    else if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).send('허용되지 않는 요청입니다.');
    let activityIdentity;
    try {
      // 결과 확인은 만료 처리 쓰기가 있을 수 있어 기존 쓰기 경로에 남긴다.
      const readApi = errorApi || noticeApi && (req.method === 'GET' || pathname.endsWith('/preview'))
        || membershipApi && (req.method === 'GET' || pathname.endsWith('/preview'));
      const readDocument = PAGES.has(pathname) && ['GET', 'HEAD'].includes(req.method) && store.withReadRequest;
      if ((readApi || readDocument) && cookieOf(req)) {
        const authorize = options => checkedSession(req, true, options);
        const read = async access => {
          if (readDocument) {
            // 로컬 정적 파일만 준비한다. 사용자별 HTML은 마지막 현재 권한 확정 뒤 조립한다.
            return { source: await measure('admin.html.template', () => template(PAGES.get(pathname))) };
          }
          if (new URL(req.originalUrl || req.url, 'http://localhost').search) return { code: 400, body: { success: false } };
          const service = errorApi ? getSummary : noticeApi ? notices : membershipCsv;
          if (!service) return { code: 503, body: { success: false } };
          const result = errorApi ? await getSummary()
            : pathname.endsWith('/preview') ? await service.preview(req.body) : await (noticeApi ? service.list() : service.summary());
          return { code: 200, body: { success: true, ...result } };
        };
        let outcome;
        if (store.withReadRequest) outcome = await store.withReadRequest(req, authorize, read, { document: readDocument });
        else {
          const gate = work => store.withRequest ? store.withRequest(req, work) : work();
          const access = await gate(authorize);
          if (access) {
            const result = await read(access), confirmed = await gate(() => authorize({ readOnly: true, confirmSession: true }));
            outcome = confirmed?.uid === access.uid && confirmed.role === access.role ? { access: confirmed, result } : { access: null };
          }
        }
        if (!outcome?.access) {
          if (readDocument) { setCookie(req, res, ''); return render(req, res, pathname, null, 200, true); }
          return res.status(401).json({ success: false });
        }
        if (readDocument) {
          const denied = pathname === '/admin/settings' && outcome.access.role !== 'owner';
          const code = denied ? 403 : 200;
          return res.status(code).type('html').send(await renderAdminDocument({ template,
            source: outcome.result.source, pathname, access: denied ? null : outcome.access, code }));
        }
        return res.status(outcome.result.code).json(outcome.result.body);
      }
      const processRequest = async () => {
      if (membershipApi) {
        const access = await checkedSession(req);
        if (!access) return res.status(401).json({success:false});
        if (!membershipCsv) return res.status(503).json({success:false});
        if (new URL(req.originalUrl || req.url, 'http://localhost').search) return res.status(400).json({success:false});
        const result = pathname.endsWith('/preview') ? await membershipCsv.preview(req.body)
          : pathname.endsWith('/status') ? await membershipCsv.status(req.body, access.uid)
          : req.method === 'GET' ? await membershipCsv.summary() : await membershipCsv.apply(req.body, access.uid);
        return res.json({success:true,...result});
      }
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
        let decoded, user;
        try { decoded = await auth.verifyIdToken(header.slice(7), false); }
        catch { return res.status(401).json({ success: false }); }
        try { user = await currentAdminUser(auth, decoded, 'auth/id-token-revoked'); }
        catch (error) {
          if (['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes(error.code)) return res.status(401).json({ success: false });
          throw error;
        }
        const role = roleOf(user);
        if (user.disabled) return res.status(401).json({ success: false });
        if (!role) return res.status(403).json({ success: false, code: 'ADMIN_ROLE_REQUIRED' });
        const old = cookieOf(req);
        if (store.beginLogin) await store.beginLogin(decoded.uid, old ? hash(old) : undefined);
        if (old) await store.remove(hash(old));
        const cookie = await auth.createSessionCookie(header.slice(7), { expiresIn: ABSOLUTE_MS });
        const time = now();
        require('./authenticationResult').prepareAuthenticationResult({ success: true, role }, () => setCookie(req, res, cookie));
        await store.set(hash(cookie), { uid: decoded.uid, lastActivity: time, expiresAt: time + ABSOLUTE_MS });
        require('./authenticationResult').publishAuthenticationResult();
        setCookie(req, res, cookie); return res.json({ success: true, role });
      }
      if (pathname === '/admin/session/activity') {
        const access = await checkedSession(req, false, { preparedIdentity: activityIdentity });
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
      };
      // 쿠키가 없는 로그인 문서·거부 응답은 세션 저장소를 조회하거나 변경하지 않는다.
      if (!store.withRequest || !cookieOf(req) && pathname !== '/admin/session') return await processRequest();
      if (pathname === '/admin/session/activity' && req.method === 'POST') {
        // Origin/메서드/JSON 검사 뒤, route와 현재 Auth 읽기만 겹친다.
        // 세션·계정 검사가 모두 끝나기 전에는 admission/native 쓰기를 시작하지 않는다.
        activityIdentity = prepareActivityIdentity(req);
        activityIdentity.catch(() => {});
      }
      const originalResponse = res, replies = [];
      const buffered = require('./authenticationResult').isAuthenticationResultRequest() ? originalResponse : new Proxy(originalResponse, { get(target, property) {
        if (['set', 'status', 'type', 'json', 'send'].includes(property)) return (...args) => { replies.push([property, args]); return buffered; };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      res = buffered;
      try { await store.withRequest(req, processRequest, { reuseJournal: PAGES.has(pathname) || pathname === '/admin/session/activity' && req.method === 'POST',
        activityOnly: pathname === '/admin/session/activity' && req.method === 'POST' }); }
      finally {
        res = originalResponse;
        if (activityIdentity) {
          const [identity] = await Promise.allSettled([activityIdentity]);
          if (identity.status === 'fulfilled' && identity.value) await Promise.allSettled([identity.value.account]);
        }
      }
      for (const [method, args] of replies) originalResponse[method](...args);
      return originalResponse;
    } catch (error) {
      // 오류 원문이나 계정·쿠키·토큰은 출력하지 않는다.
      if (noticeApi && [400,404,409].includes(error.status)) return res.status(error.status).json({success:false,message:error.message});
      if (membershipApi && typeof error.code === 'string' && error.code.startsWith('MEMBERSHIP_CSV_')) return res.status(error.status).json({success:false,code:error.code,message:error.message});
      const code = ['WRITER_RESOURCE_BUSY', 'WRITER_DRAINING', 'WRITER_FENCED'].includes(error.code) ? 'ADMIN_SESSION_BUSY'
        : ['WRITER_OUTCOME_UNRESOLVED'].includes(error.code) ? 'ADMIN_SESSION_RECOVERY_REQUIRED' : 'ADMIN_SESSION_UNAVAILABLE';
      return endpoint || errorApi || noticeApi || membershipApi ? res.status(503).json({ success: false, ...(endpoint ? { code } : {}) }) : render(req, res, pathname, null, 503);
    }
  };
  return (req, res) => new URL(req.originalUrl || req.url, 'http://localhost').pathname.replace(/\/$/, '') === '/admin/session'
    ? require('./authenticationResult').withAuthenticationResult(req, res, 'admin', response => handler(req, response))
    : handler(req, res);
}
module.exports = { createAdminPageHandler, createMemoryStore, createFirestoreStore, PAGES, IDLE_MS, ABSOLUTE_MS, cookieOf, originOf, localHttp, renderAdminDocument };
