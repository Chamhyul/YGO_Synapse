/* Discord OAuth 창 통신. 서버의 인증·권한 판정은 기존 API가 수행한다. */
(function (root) {
    'use strict';
    const KEY = 'ygo_discord_popup_callback', TYPE = 'ygo.discord.oauth.result';
    const stateValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const callbackPage = root.location.pathname === '/discord-popup.html';
    if (!callbackPage && root.YgoDiscordPopup?.isCallback) return;
    let marker;
    try { marker = JSON.parse(root.sessionStorage.getItem(KEY)); } catch (_) { /* 일반 페이지는 그대로 진행한다. */ }
    const validMarker = marker?.version === 1 && stateValid(marker.state) && Number.isFinite(marker.expiresAt);
    const query = new URLSearchParams(callbackPage ? root.location.hash.slice(1) : root.location.search);
    const hasResult = query.has('code') || query.has('error');
    const callback = validMarker && hasResult && query.getAll('state').length === 1 && query.get('state') === marker.state;

    if (callbackPage) {
        const show = text => {
            const render = () => {
                const el = root.document.getElementById('discord-popup-status');
                if (el) { el.textContent = text; el.closest('main').hidden = false; }
            };
            if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', render, { once: true });
            else render();
        };
        // 시작 API 준비 중에는 문구 없이 기다린다. 복귀 결과 안내는 아래에서 표시한다.
        if (!hasResult && new URLSearchParams(root.location.search).get('preparing') === '1') {
            return;
        }
        // 코드는 메모리에서만 전달하며 다른 자산 요청 전에 주소에서 제거한다.
        root.history.replaceState({}, '', root.location.pathname);
        try { root.sessionStorage.removeItem(KEY); } catch (_) { /* 메시지의 일회성은 부모/서버에서도 검사한다. */ }
        const code = query.get('code'), error = query.get('error');
        if (!callback || marker.expiresAt <= Date.now() || !root.opener || root.opener.closed
            || query.getAll('code').length > 1 || query.getAll('error').length > 1
            || Boolean(code) === Boolean(error) || code && code.length > 4096) {
            show('인증 결과를 전달하지 못했습니다. 이 창을 닫고 원래 서비스 창에서 다시 시도해 주세요.');
            return;
        }
        try {
            root.opener.postMessage({ type: TYPE, version: 1, state: marker.state,
                ...(code ? { code } : { error: error === 'access_denied' ? 'cancelled' : 'failed' }) }, root.location.origin);
            show('원래 서비스 창에서 멤버십을 확인하고 있습니다.');
        } catch (_) { show('원래 서비스 창에 연결하지 못했습니다. 이 창을 닫고 다시 시도해 주세요.'); }
        return;
    }

    let activeCancel;
    function open({ prepared = false } = {}) {
        const nav = root.navigator || {}, ua = nav.userAgent || '';
        if (nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua)
            || /Macintosh/i.test(ua) && nav.maxTouchPoints > 1) return null;
        activeCancel?.();
        let popup;
        try { popup = root.open(prepared ? 'about:blank' : root.location.origin + '/discord-popup.html?preparing=1', '_blank', 'popup,width=520,height=740'); } catch (_) { return null; }
        if (!popup) return null;
        let resolve, reject, cancel, settled = false, expectedState, expiresAt = Date.now() + 270000;
        const result = new Promise((a, b) => { resolve = a; reject = b; });
        result.catch(() => {}); // 사용자가 시작 API 대기 중 창을 닫아도 rejection을 회수한다.
        const close = () => { try { popup.close(); } catch (_) { /* 이미 닫힌 창 */ } };
        const finish = (value, code) => {
            if (settled) return;
            settled = true; root.clearInterval(timer); root.removeEventListener('message', receive); close();
            if (activeCancel === cancel) activeCancel = undefined;
            if (code) reject(Object.assign(new Error('Discord 팝업 인증을 완료하지 못했습니다.'), { code }));
            else resolve(value);
        };
        function receive(event) {
            const data = event.data;
            if (event.origin !== root.location.origin || event.source !== popup || !data || data.type !== TYPE
                || data.version !== 1 || !expectedState || data.state !== expectedState) return;
            if (Date.now() >= expiresAt) { finish(null, 'DISCORD_POPUP_EXPIRED'); return; }
            if (typeof data.code === 'string' && data.code.length > 0 && data.code.length <= 4096 && data.error === undefined)
                finish({ code: data.code, state: data.state });
            else if (data.code === undefined && ['cancelled', 'failed'].includes(data.error))
                finish(null, data.error === 'cancelled' ? 'DISCORD_POPUP_CANCELLED' : 'DISCORD_POPUP_FAILED');
        }
        root.addEventListener('message', receive);
        const timer = root.setInterval(() => {
            if (Date.now() >= expiresAt) finish(null, 'DISCORD_POPUP_EXPIRED');
            else { try { if (popup.closed) finish(null, 'DISCORD_POPUP_CANCELLED'); } catch (_) { finish(null, 'DISCORD_POPUP_FAILED'); } }
        }, 250);
        cancel = () => finish(null, 'DISCORD_POPUP_CANCELLED');
        activeCancel = cancel;
        return {
            result,
            authorize({ authorizationUrl, state, deadline }) {
                if (settled) throw Object.assign(new Error(), { code: 'DISCORD_POPUP_CANCELLED' });
                const url = new URL(authorizationUrl);
                if (!stateValid(state) || !Number.isFinite(deadline) || deadline <= Date.now()
                    || url.origin !== 'https://discord.com' || url.pathname !== '/oauth2/authorize'
                    || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
                    || url.searchParams.getAll('redirect_uri').length !== 1
                    || url.searchParams.get('redirect_uri') !== root.location.origin + '/') throw new Error('Discord 팝업 주소 오류');
                expectedState = state; expiresAt = Math.min(deadline, expiresAt);
                try {
                    popup.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, state, expiresAt }));
                    popup.location.replace(url.href);
                    return true;
                } catch (_) { finish(null, 'DISCORD_POPUP_FAILED'); return false; }
            },
            cancel,
        };
    }
    root.YgoDiscordPopup = Object.freeze({ isCallback: false, open, cancelActive() { activeCancel?.(); } });
})(window);
