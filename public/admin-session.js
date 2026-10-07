/** 로그인·활동·로그아웃을 관리자 서버 세션과 연결한다. 브라우저 저장값은 권한 근거가 아니다. */
(function (root) {
    'use strict';
    const MARKER = 'ygo_admin_server_session';
    let auth;
    let lastActivity = 0;
    let clearing = null;
    function marked() { try { return root.localStorage.getItem(MARKER) === 'active'; } catch { return true; } }
    function mark(active) {
        try { if (active) root.localStorage.setItem(MARKER, 'active'); else root.localStorage.removeItem(MARKER); } catch (_) {}
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
        const response = await post('/admin/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
        if (response.ok) mark(true);
        return response;
    }
    function activity() {
        if (!auth?.currentUser || !marked() || Date.now() - lastActivity < 10000) return;
        lastActivity = Date.now();
        post('/admin/session/activity', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: auth.currentUser.uid })
        }).then(response => { if (response.status === 401) mark(false); }).catch(() => {});
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
