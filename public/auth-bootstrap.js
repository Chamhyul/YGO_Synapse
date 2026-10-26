/* 인증 준비만 먼저 수행한다. 계정·토큰·인증 결과 원문은 계측에 남기지 않는다. */
(function (root) {
    'use strict';
    if (root.YgoDiscordPopup?.isCallback) return;
    const timing = root.YgoLoginTiming;
    timing?.mark('auth_bootstrap_start');
    let ready, failed;
    const uiReady = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    uiReady.catch(() => {});
    const state = { auth: null, redirect: null, appCheckStarted: false };
    root.YgoAuthBootstrap = Object.freeze({ get auth() { return state.auth; }, get redirect() { return state.redirect; },
        get appCheckStarted() { return state.appCheckStarted; }, whenUiReady: () => uiReady,
        uiPrepared() { timing?.mark('ui_ready'); ready(); },
        uiFailed() { timing?.mark('ui_failed'); failed(new Error('화면 준비 실패')); },
    });
    try {
        const local = ['localhost', '127.0.0.1', '192.168.0.22'].includes(location.hostname)
            || location.hostname.toLowerCase().endsWith('.local');
        if (!local) firebase.app().options.authDomain = location.hostname;
        if (local) root.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        const check = firebase.appCheck();
        check.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider('6Le3FaksAAAAAFE9lMsuyGfgTkvNaVzrThMUthe3'), true);
        state.appCheckStarted = true;
        timing?.mark('app_check_start');
        // SDK의 같은 준비 작업을 앞당긴다. 토큰 값은 보관하지 않는다.
        Promise.resolve(timing?.appCheck ? timing.appCheck('bootstrap', false, () => check.getToken()) : check.getToken()).then(() => timing?.mark('app_check_ready'), () => timing?.mark('app_check_failed'));
        const auth = firebase.auth();
        state.auth = auth;
        timing?.mark('auth_created');
        auth.onAuthStateChanged(user => {
            timing?.mark('auth_state_ready');
            if (user) timing?.mark('auth_user_ready');
        });
        timing?.mark('redirect_result_start');
        const redirect = auth.getRedirectResult().then(() => { timing?.mark('redirect_result_ready'); }, error => {
            timing?.mark('redirect_result_failed'); throw error;
        });
        redirect.catch(() => {});
        state.redirect = redirect;
    } catch (_) { timing?.mark('auth_bootstrap_failed'); }
})(window);
