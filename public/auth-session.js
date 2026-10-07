/** 일반 서비스와 관리자 화면이 공유하는 계정별 30분 비활동 세션. */
(function (root) {
    'use strict';
    const TIMEOUT_MS = 30 * 60 * 1000;
    const EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];

    root.createAuthSession = function ({ onExpire }) {
        let user = null;
        let key = null;
        let lastActivity = 0;
        let lastWrite = 0;
        let timer = null;

        function read() {
            try {
                const saved = Number(root.localStorage.getItem(key));
                if (Number.isFinite(saved) && saved > 0 && saved <= Date.now()) {
                    lastActivity = Math.max(lastActivity, saved);
                }
            } catch (_) { /* 저장소 제한 시 현재 탭의 타이머를 유지한다. */ }
            return lastActivity;
        }

        function write() {
            try { root.localStorage.setItem(key, String(lastActivity)); } catch (_) {}
            lastWrite = Date.now();
        }

        function stop() {
            if (timer) root.clearTimeout(timer);
            timer = null;
            EVENTS.forEach(event => root.removeEventListener(event, activity));
            root.removeEventListener('storage', storageChanged);
            root.removeEventListener('focus', check);
            root.document.removeEventListener('visibilitychange', check);
            user = null;
        }

        function check() {
            if (!user) return false;
            if (timer) root.clearTimeout(timer);
            const remaining = TIMEOUT_MS - (Date.now() - read());
            if (remaining <= 0) {
                stop();
                onExpire();
                return false;
            }
            timer = root.setTimeout(check, remaining);
            return true;
        }

        function activity() {
            // 백그라운드 타이머가 지연되어도 만료된 세션을 활동으로 되살리지 않는다.
            if (!check()) return;
            lastActivity = Date.now();
            root.adminSession?.activity();
            if (Date.now() - lastWrite >= 1000) write();
            check();
        }

        function storageChanged(event) {
            if (event.key === key || event.key === null) check();
        }

        return {
            start(nextUser) {
                if (user && user.uid === nextUser.uid) return check();
                stop();
                user = nextUser;
                key = 'ygo_auth_activity:' + user.uid;
                lastActivity = 0;
                lastWrite = 0;
                read();
                // 이 공유 타이머 도입 전부터 살아 있던 세션은 최초 관찰 시각부터 추적한다.
                if (!lastActivity) lastActivity = Date.now();
                // 명시적으로 다시 로그인한 경우에만 오래된 활동 시각을 갱신한다.
                const signedInAt = Date.parse(user.metadata?.lastSignInTime || '');
                if (Number.isFinite(signedInAt) && signedInAt <= Date.now()) {
                    lastActivity = Math.max(lastActivity, signedInAt);
                }
                write();
                EVENTS.forEach(event => root.addEventListener(event, activity, { passive: true }));
                root.addEventListener('storage', storageChanged);
                root.addEventListener('focus', check);
                root.document.addEventListener('visibilitychange', check);
                return check();
            },
            stop,
            reset: activity,
            check
        };
    };
})(window);
