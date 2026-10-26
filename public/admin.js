/** 서버 세션으로 제공된 화면을 유지하고, 최초 진입 때만 기존 Firebase 로그인을 세션으로 교환한다. */
(function () {
    'use strict';
    const login = document.getElementById('admin-login');
    const content = document.getElementById('admin-content');
    const status = document.getElementById('admin-status');
    const providers = document.getElementById('admin-providers');
    const retry = document.getElementById('admin-retry');
    const switchAccount = document.getElementById('admin-switch');
    const account = document.getElementById('admin-account');
    const settings = document.getElementById('admin-settings');
    const returnPath = document.body.dataset.adminPage || '/admin';
    const serverUid = content?.dataset.adminUid;
    const isLocal = ['localhost', '127.0.0.1', '192.168.0.22'].includes(location.hostname)
        || location.hostname.toLowerCase().endsWith('.local');
    const buttons = ['google', 'twitter'].map(name => document.getElementById('admin-' + name));
    let auth;
    let generation = 0;
    let expired = document.body.dataset.adminExpired === 'true';
    let expiryMessage = expired ? '관리자 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.'
        : '30분 동안 활동이 없어 로그아웃되었습니다. 다시 로그인해 주세요.';
    let redirectPending = true;
    let signingIn = false;
    let observedUid = null;
    let entry = null;
    function show(message, options = {}) {
        if (content) content.hidden = true;
        if (settings) settings.hidden = true;
        login.hidden = false;
        document.title = '관리자 로그인 · YGO Synapse';
        status.textContent = message;
        providers.hidden = !options.providers;
        retry.hidden = !options.retry;
        switchAccount.hidden = !options.switchAccount;
        buttons.forEach(button => { button.disabled = signingIn; });
    }
    async function signOut() {
        generation++;
        session.stop();
        show(expired ? expiryMessage : '로그아웃 중입니다.');
        // Firebase 공유 로그인과 HttpOnly 관리자 세션을 모두 종료한다.
        const results = await Promise.allSettled([window.adminSession.clear(), auth.signOut()]);
        if (results.some(r => r.status === 'rejected')) show('로그아웃을 완료하지 못했습니다. 다시 시도해 주세요.', { switchAccount: true });
    }
    const session = window.createAuthSession({ onExpire() {
        expired = true; expiryMessage = '30분 동안 활동이 없어 로그아웃되었습니다. 다시 로그인해 주세요.'; signOut();
    } });
    async function enter(user, manual = false) {
        if (redirectPending) return;
        // 최초 Auth 알림·리다이렉트 복원·재시도가 겹쳐도 같은 계정의 발급은 공유한다.
        if (user && entry?.uid === user.uid) return entry.promise;
        const current = ++generation;
        if (!user) {
            session.stop();
            show(expired ? expiryMessage : '관리자 계정으로 로그인해 주세요.', { providers: true });
            return;
        }
        if (document.body.dataset.adminExpired === 'true') {
            document.body.dataset.adminExpired = 'false'; expired = true; await signOut(); return;
        }
        if (!session.start(user)) return;
        if (!manual && document.body.dataset.adminDenied === 'true') {
            show('소유자 권한이 필요한 페이지입니다.', { switchAccount: true }); return;
        }
        if (!manual && document.body.dataset.adminUnavailable === 'true') {
            show('관리자 서버에 연결하지 못했습니다. 다시 시도해 주세요.', { retry: true, switchAccount: true }); return;
        }
        if (serverUid === user.uid && !manual && !content.hidden) {
            observedUid = user.uid;
            if (account) account.textContent = user.displayName || user.email || '관리자 계정';
            window.adminSession.mark(true);
            return;
        }
        show('관리자 권한을 확인하고 있습니다.');
        const previous = entry?.promise;
        const task = { uid: user.uid };
        entry = task;
        task.promise = (async () => {
            try {
                // 계정 변경 때 이전 발급의 쿠키 정리가 끝난 뒤 새 계정의 발급을 시작한다.
                await previous;
                if (current !== generation || auth.currentUser?.uid !== user.uid) return;
                const response = await window.adminSession.establish(user);
                if (current !== generation || auth.currentUser?.uid !== user.uid) {
                    await window.adminSession.clear(); return;
                }
                if (response.status === 401) { await signOut(); return; }
                if ([403, 503].includes(response.status)) {
                    let code;
                    try { code = (await response.json()).code; } catch (_) {}
                    const messages = { ADMIN_ROLE_REQUIRED: '관리자 권한이 없는 계정입니다.',
                        ADMIN_REQUEST_REJECTED: '요청 출처 또는 형식을 확인하지 못했습니다. 서비스 주소에서 다시 접속해 주세요.',
                        ADMIN_SESSION_BUSY: '관리자 세션 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.',
                        ADMIN_SESSION_RECOVERY_REQUIRED: '관리자 세션 복구가 필요합니다. 운영 담당자에게 문의해 주세요.' };
                    show((Object.hasOwn(messages, code) ? messages[code] : null) || (response.status === 403 ? '관리자 요청이 거부되었습니다. 접속 주소와 권한을 확인해 주세요.'
                        : '관리자 세션을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'), { retry: true, switchAccount: true }); return;
                }
                if (!response.ok) throw new Error('session-unavailable');
                // 다음 문서는 요청에 실린 세션을 서버가 검증한 뒤 완성해서 제공한다.
                location.replace(returnPath);
            } catch (_) {
                if (current === generation) show('관리자 서버에 연결하지 못했습니다. 다시 시도해 주세요.', { retry: true, switchAccount: true });
            } finally {
                if (entry === task) entry = null;
            }
        })();
        return task.promise;
    }
    async function signIn(name) {
        if (signingIn || !auth || auth.currentUser) return;
        signingIn = true; expired = false;
        show('로그인 중입니다.', { providers: true });
        const provider = name === 'google' ? new firebase.auth.GoogleAuthProvider() : new firebase.auth.TwitterAuthProvider();
        try { if (isLocal) await auth.signInWithPopup(provider); else await auth.signInWithRedirect(provider); }
        catch (_) { show('로그인을 완료하지 못했습니다. 다시 시도해 주세요.', { providers: true }); }
        finally { signingIn = false; buttons.forEach(button => { button.disabled = false; }); }
    }
    retry.addEventListener('click', () => enter(auth.currentUser, true));
    switchAccount.addEventListener('click', signOut);
    document.getElementById('admin-logout')?.addEventListener('click', signOut);
    buttons.forEach((button, index) => button.addEventListener('click', () => signIn(index ? 'twitter' : 'google')));
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    try {
        if (!isLocal) firebase.app().options.authDomain = location.hostname;
        auth = firebase.auth();
        auth.onAuthStateChanged(user => {
            if (observedUid && observedUid !== user?.uid && content) content.hidden = true;
            enter(user);
        });
        auth.getRedirectResult().then(() => { redirectPending = false; enter(auth.currentUser); })
            .catch(() => {
                redirectPending = false;
                if (auth.currentUser) enter(auth.currentUser);
                else show('로그인을 완료하지 못했습니다. 다시 시도해 주세요.', { providers: true });
            });
    } catch (_) { show('로그인 서비스를 불러오지 못했습니다. 페이지를 새로고침해 주세요.'); }
})();
