/** 로그인·활동·로그아웃을 관리자 서버 세션과 연결한다. 브라우저 저장값은 권한 근거가 아니다. */
(function (root) {
    'use strict';
    const MARKER = 'ygo_admin_server_session';
    const ACTIVITY_PREFIX = 'ygo_admin_activity_sent:';
    const ACTIVITY_INTERVAL = 10000;
    let auth;
    let lastActivity = 0;
    let sessionGeneration = 0;
    let clearing = null;
    function marked() { try { return root.localStorage.getItem(MARKER) === 'active'; } catch { return true; } }
    function mark(active) {
        if (!active) { lastActivity = 0; sessionGeneration++; }
        try {
            if (active) root.localStorage.setItem(MARKER, 'active');
            else {
                root.localStorage.removeItem(MARKER);
                if (auth?.currentUser) root.localStorage.removeItem(ACTIVITY_PREFIX + auth.currentUser.uid);
            }
        } catch (_) {}
    }
    async function post(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try { return await fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timeout); }
    }
    async function clear() {
        mark(false);
        if (!clearing) clearing = post('/admin/session/logout', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true
        }).then(response => { if (!response.ok) throw new Error('session-clear'); }).finally(() => { clearing = null; });
        return clearing;
    }
    async function establish(user) {
        if (clearing) await clearing;
        const token = await user.getIdToken();
        let response = await post('/admin/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ authenticationResultStream: !!root.YgoAuthenticationResult }) });
        if (response.ok && root.YgoAuthenticationResult?.supported(response)) {
            const result = await root.YgoAuthenticationResult.read(response, {
                onFailure() { try { console.warn('[AdminSession] 작업 기록 확인이 필요합니다.'); } catch (_) {} }
            });
            response = { ok: result?.success === true, status: 200, json: async () => result };
        }
        if (response.ok) {
            const status = root.document?.getElementById?.('admin-status');
            if (status) status.textContent = '관리자 인증 완료';
            root.YgoAuthenticationResult?.displayed?.('admin');
            sessionGeneration++;
            try { root.localStorage.removeItem(ACTIVITY_PREFIX + user.uid); } catch (_) {}
            lastActivity = 0;
            mark(true);
        }
        return response;
    }
    function activity() {
        if (!auth?.currentUser || !marked()) return;
        const uid = auth.currentUser.uid, time = Date.now(), key = ACTIVITY_PREFIX + uid, generation = sessionGeneration;
        // 전송 제한용 시각은 인증 근거가 아니다. 미래값·손상값은 억제에 쓰지 않는다.
        let sent = lastActivity;
        try {
            const saved = Number(root.localStorage.getItem(key));
            if (Number.isSafeInteger(saved) && saved >= 0 && saved <= time) sent = Math.max(sent, saved);
        } catch (_) {}
        if (time >= sent && time - sent < ACTIVITY_INTERVAL) return;
        lastActivity = time;
        try { root.localStorage.setItem(key, String(time)); } catch (_) {}
        post('/admin/session/activity', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid })
        }).then(response => { if (response.status === 401 && auth?.currentUser?.uid === uid && generation === sessionGeneration) mark(false); }).catch(() => {});
    }
    root.adminSession = { clear, establish, activity, mark };
    try {
        const local = ['localhost', '127.0.0.1', '192.168.0.22'].includes(location.hostname) || location.hostname.toLowerCase().endsWith('.local');
        if (!local) firebase.app().options.authDomain = location.hostname;
        auth = firebase.auth();
        let observedUid;
        auth.onAuthStateChanged(user => {
            if (!user || (observedUid && observedUid !== user.uid)) clear().catch(() => {});
            observedUid = user?.uid || null;
        });
    } catch (_) { /* Firebase 미초기화는 해당 페이지의 로그인 UI가 처리한다. */ }
})(window);
