/* 로그인 시간 진단: 고정 단계·숫자·임의 상관 ID만 콘솔에 기록한다. */
(function (root) {
    'use strict';
    const LIMIT = 96, KEY = 'ygo_login_timing_redirect_v1';
    const stages = new Set(['page_to_auth_state', 'provider_round_trip', 'id_token', 'app_check', 'http',
        'response_json', 'registration_gate', 'user_data', 'claims_token', 'render', 'ui_ready_wait']);
    const operations = new Set(['login', 'getRegistrationStatus', 'getUserData']);
    const outcomes = new Set(['ready', 'failed', 'signup_required', 'superseded', 'signed_out']);
    let active, pendingPopup, recentPopup;
    const now = () => { try { return root.performance.now(); } catch (_) { return 0; } };
    const round = n => Math.round(Math.max(0, Number.isFinite(n) ? n : 0) * 1000) / 1000;
    function popupResource(entry, trace) {
        try {
            if (!Number.isFinite(entry.startTime) || entry.startTime < trace.started) return;
            if (Number.isFinite(trace.endAt) && entry.startTime > trace.endAt) return;
            const u = new URL(entry.name), path = u.pathname;
            const category = u.hostname === 'identitytoolkit.googleapis.com'
                ? path.endsWith('/accounts:signInWithIdp') ? 'auth_idp'
                    : path.endsWith('/accounts:lookup') ? 'auth_lookup' : path.endsWith('/projects') ? 'auth_config' : null
                : u.hostname === 'apis.google.com' ? 'auth_gapi'
                    : path === '/__/auth/iframe' ? 'auth_iframe' : null;
            if (!category || !Number.isFinite(entry.duration)) return;
            const record = { category, startMs: round(entry.startTime - trace.started), durationMs: round(entry.duration),
                detailed: Number.isFinite(entry.responseStart) && entry.responseStart > 0 };
            const key = `${category}:${record.startMs}:${record.durationMs}`;
            if (trace.seen.has(key)) return;
            if (trace.resources.length >= 24) { trace.dropped++; return; }
            trace.seen.add(key); trace.resources.push(record);
        } catch (_) {}
    }
    function popupSnapshot(trace) {
        return { version: 1, traceId: trace.id, scope: 'opener-only', outcome: trace.outcome,
            openHookInstalled: trace.hooked, openCallsObserved: trace.openCalls, observerAvailable: trace.observed, opened: trace.opened,
            marks: { ...trace.marks }, resources: trace.resources.map(r => ({ ...r })), droppedResources: trace.dropped };
    }
    function beginPopup() {
        try {
            pendingPopup?.stop('superseded'); recentPopup = undefined;
            const trace = { id: id(), started: now(), wallAt: Date.now(), marks: {}, resources: [], seen: new Set(),
                hooked: false, observed: false, openCalls: 0, opened: null, dropped: 0, outcome: 'pending', attached: false };
            let observer, timer, originalOpen, wrapper, closed = false, settled = false;
            const point = name => { try { if (!Object.hasOwn(trace.marks, name)) trace.marks[name] = round(now() - trace.started); } catch (_) {} };
            const collect = () => {
                try { for (const entry of observer?.takeRecords() || []) popupResource(entry, trace); } catch (_) {}
                try { for (const entry of root.performance.getEntriesByType('resource').slice(-300)) popupResource(entry, trace); } catch (_) {}
            };
            const releaseOpen = () => { try { if (wrapper && root.open === wrapper) root.open = originalOpen; } catch (_) {} };
            const stop = outcome => {
                if (closed) return;
                closed = true; trace.outcome = outcome; collect();
                try { observer?.disconnect(); } catch (_) {}
                try { if (timer !== undefined) root.clearTimeout(timer); } catch (_) {}
                releaseOpen();
                if (pendingPopup === trace) pendingPopup = undefined;
                if (outcome === 'resolved' && !trace.attached) recentPopup = trace;
                try { root.console.info('[YGO popup timing] ' + JSON.stringify({ event: 'login_popup_timing', ...popupSnapshot(trace) })); } catch (_) {}
            };
            trace.stop = stop; trace.point = point; trace.collect = collect;
            pendingPopup = trace; point('sdk_call');
            try {
                originalOpen = root.open;
                if (typeof originalOpen === 'function') {
                    wrapper = function (...args) {
                        if (closed) return Reflect.apply(originalOpen, this, args);
                        // 인수·URL·창의 내용은 읽지 않고 this/인수/반환값/예외를 그대로 전달한다.
                        const first = trace.openCalls === 0;
                        trace.openCalls = Math.min(4096, trace.openCalls + 1);
                        if (first) point('window_open_call');
                        try { const result = Reflect.apply(originalOpen, this, args); if (first) trace.opened = !!result; return result; }
                        finally { if (first) point('window_open_return'); }
                    };
                    root.open = wrapper; trace.hooked = root.open === wrapper;
                }
            } catch (_) {}
            try {
                observer = new root.PerformanceObserver(list => {
                    try { if (!closed) for (const entry of list.getEntries()) popupResource(entry, trace); } catch (_) {}
                });
                observer.observe({ type: 'resource', buffered: false }); trace.observed = true;
            } catch (_) {}
            try { timer = root.setTimeout?.(() => stop('limit'), 600000); } catch (_) {}
            return Object.freeze({ returned() { if (!closed) point('sdk_promise_returned'); },
                settled(ok) {
                    if (closed || settled) return;
                    settled = true; point('sdk_promise_settled'); trace.endAt = now();
                    trace.outcome = ok ? 'resolved' : 'rejected'; releaseOpen();
                    // Resource Timing의 등록은 Promise보다 늦을 수 있다. 성공 시
                    // 서비스 로그인 종료까지 관측하되 공급자 종료 뒤 시작한 요청은 제외한다.
                    if (!ok) stop('rejected');
                } });
        } catch (_) { return undefined; }
    }
    const allowedMarks = new Set(['timing_loaded', 'auth_bootstrap_start', 'auth_created', 'auth_state_ready',
        'auth_user_ready', 'redirect_result_start', 'redirect_result_ready', 'redirect_result_failed',
        'app_check_start', 'app_check_ready', 'app_check_failed', 'auth_bootstrap_failed',
        'service_auth_start', 'dom_ready', 'ui_init_start', 'cache_start', 'cache_ready', 'cache_failed', 'ui_ready', 'ui_failed']);
    const marks = Object.create(null);
    function mark(name) {
        try { if (allowedMarks.has(name) && !Object.hasOwn(marks, name)) marks[name] = round(now()); } catch (_) {}
    }
    function startupMeasure(name, work) {
        if (name !== 'cache') return work();
        mark('cache_start');
        try { return Promise.resolve(work()).then(value => { mark('cache_ready'); return value; }, error => { mark('cache_failed'); throw error; }); }
        catch (error) { mark('cache_failed'); throw error; }
    }
    function startup() {
        // URL·쿼리·HTTP 본문은 반환하지 않고 고정 분류와 숫자만 사용한다.
        const result = { scope: 'page', marks: { ...marks }, navigation: {}, resources: [] };
        try {
            const n = root.performance.getEntriesByType('navigation')[0];
            if (n) for (const key of ['requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'loadEventStart']) {
                if (Number.isFinite(n[key]) && n[key] >= 0) result.navigation[key] = round(n[key]);
            }
            const fixed = new Map([
                ['/__/firebase/13.0.0/firebase-app-compat.js', 'sdk_app'], ['/__/firebase/10.12.0/firebase-app-compat.js', 'sdk_app'], ['/__/firebase/13.0.0/firebase-auth-compat.js', 'sdk_auth'], ['/__/firebase/10.12.0/firebase-auth-compat.js', 'sdk_auth'],
                ['/__/firebase/13.0.0/firebase-app-check-compat.js', 'sdk_app_check'], ['/__/firebase/10.12.0/firebase-app-check-compat.js', 'sdk_app_check'], ['/__/firebase/init.js', 'sdk_config'],
                ['/auth-bootstrap.js', 'auth_bootstrap'], ['/script.js', 'app_script'], ['/admin-session.js', 'admin_bridge'],
                ['/hangul-js', 'hangul'], ['/ajax/libs/materialize/1.0.0/js/materialize.min.js', 'materialize'],
                ['/xlsx-latest/package/dist/xlsx.full.min.js', 'xlsx'], ['/gsi/client', 'youtube_gis'],
                ['/__/auth/iframe', 'auth_iframe'], ['/__/auth/iframe.js', 'auth_iframe_script'],
            ]);
            for (const entry of root.performance.getEntriesByType('resource').slice(0, 300)) {
                const u = new URL(entry.name), path = u.pathname;
                let category = fixed.get(path);
                if (u.hostname === 'identitytoolkit.googleapis.com') category = path.endsWith('/accounts:signInWithIdp') ? 'auth_idp'
                    : path.endsWith('/accounts:lookup') ? 'auth_lookup' : 'auth_config';
                if (u.hostname === 'securetoken.googleapis.com') category = 'auth_token_refresh';
                if (u.hostname === 'firebaseappcheck.googleapis.com') category = 'app_check_exchange';
                if (!category || result.resources.length >= 48) continue;
                result.resources.push({ category, startMs: round(entry.startTime), durationMs: round(entry.duration),
                    responseStartMs: round(entry.responseStart), responseEndMs: round(entry.responseEnd),
                    detailed: Number.isFinite(entry.responseStart) && entry.responseStart > 0 });
            }
        } catch (_) { /* 브라우저 계측 제한이 로그인 결과에 영향을 주지 않게 한다. */ }
        return result;
    }
    // 허용된 오류 분류만 복사한다. SDK 원문·customData·URL·토큰은 기록하지 않는다.
    function appCheckFailure(error) {
        let code = 'unknown', httpStatus = null;
        try {
            const raw = error?.code;
            const known = ['already-initialized', 'use-before-activation', 'fetch-network-error', 'fetch-parse-error',
                'fetch-status-error', 'storage-open', 'storage-get', 'storage-set', 'recaptcha-error', 'initial-throttle', 'throttled'];
            for (const name of known) if (raw === 'appCheck/' + name || raw === 'app-check/' + name) code = name;
            const status = error?.customData?.httpStatus;
            if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
        } catch (_) {}
        const category = ['initial-throttle', 'throttled'].includes(code) ? 'throttled'
            : code === 'fetch-network-error' ? 'network' : code === 'fetch-status-error' ? 'http'
                : code === 'recaptcha-error' ? 'recaptcha' : code.startsWith('storage-') ? 'storage'
                    : ['already-initialized', 'use-before-activation'].includes(code) ? 'configuration'
                        : code === 'fetch-parse-error' ? 'response' : 'unknown';
        return { code, category, httpStatus,
            retryable: !['throttled', 'configuration', 'storage'].includes(category) && ![400, 403, 404, 429].includes(httpStatus) };
    }
    let appCheckEvents = 0, recoveryEvents = 0;
    function diagnostic(event, value) {
        try { root.console.info('[YGO auth recovery] ' + JSON.stringify({ event, version: 1, ...value })); } catch (_) {}
    }
    function appCheck(stage, forceRefresh, work) {
        const record = ['bootstrap', 'request', 'refresh'].includes(stage) && appCheckEvents++ < 48;
        const started = now();
        const end = (ok, error) => {
            if (record) diagnostic('app_check_preparation', { stage, forceRefresh: forceRefresh === true,
                startMs: round(started), durationMs: round(now() - started), ok, ...(ok ? {} : { failure: appCheckFailure(error) }) });
        };
        try { return Promise.resolve(work()).then(value => { end(true); return value; }, error => { end(false, error); throw error; }); }
        catch (error) { end(false, error); throw error; }
    }
    function recovery(kind) {
        if (!['registration', 'discord'].includes(kind) || recoveryEvents++ >= 16) return null;
        const started = now(), traceId = id(), spans = []; let finished = false;
        return {
            measure(name, work) {
                if (!['registration_attempt', 'app_check_refresh', 'retry_delay', 'restore_wait', 'membership_request', 'claims_sync', 'final_sync', 'render'].includes(name)
                    || finished || spans.length >= 16) return work();
                const span = { name, startMs: round(now() - started) }; spans.push(span);
                const at = now(), end = ok => { span.durationMs = round(now() - at); span.ok = ok; };
                try {
                    const value = work();
                    if (value && typeof value.then === 'function') return Promise.resolve(value).then(result => { end(true); return result; }, error => { end(false); throw error; });
                    end(true); return value;
                } catch (error) { end(false); throw error; }
            },
            finish(outcome, error) {
                if (finished || !['ready', 'failed', 'cancelled', 'superseded'].includes(outcome)) return;
                finished = true;
                const allowed = ['APPCHECK_UNAVAILABLE', 'APPCHECK_CONFIGURATION_REJECTED', 'APPCHECK_REQUIRED', 'APPCHECK_INVALID',
                    'AUTH_INVALID', 'SERVICE_CHECK_TIMEOUT', 'DISCORD_SESSION_CHANGED', 'DISCORD_RESTORE_FAILED', 'DISCORD_VERIFICATION_EXPIRED'];
                let failureCode = 'unknown'; try { if (allowed.includes(error?.code)) failureCode = error.code; } catch (_) {}
                const ended = now();
                diagnostic('auth_recovery_timing', { kind, traceId, outcome, durationMs: round(ended - started),
                    pageStartMs: round(started), pageEndMs: round(ended), spans,
                    ...(outcome === 'failed' ? { failureCode } : {}) });
            }
        };
    }
    mark('timing_loaded');
    try { root.document?.addEventListener('DOMContentLoaded', () => mark('dom_ready'), { once: true }); } catch (_) {}
    try { root.addEventListener?.('pagehide', () => {
        try {
            const raw = root.sessionStorage.getItem(KEY), value = raw ? JSON.parse(raw) : null;
            if (value?.version === 1 && value.mode === 'redirect' && Number.isFinite(value.at)) {
                const elapsed = Date.now() - value.at;
                if (elapsed >= 0 && elapsed <= 600000) root.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, mode: 'redirect', at: value.at, outboundMs: round(elapsed) }));
            }
        } catch (_) {}
    }); } catch (_) {}
    function id() {
        try { return Array.from(root.crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join(''); }
        catch (_) { return null; }
    }
    function begin(flow, operation, name) {
        if (!flow || flow.finished || !operations.has(operation) || !stages.has(name)) return () => {};
        if (flow.spans.length >= LIMIT) { flow.dropped++; return () => {}; }
        const started = now(), span = { operation, name, startMs: round(started - flow.started) };
        flow.spans.push(span); let done = false;
        return ok => { if (done || flow.finished) return; done = true; span.durationMs = round(now() - started); span.ok = ok !== false; };
    }
    function control(flow, operation = 'login') {
        return {
            begin(name) { return begin(flow, operation, name); },
            measure(name, work) {
                const end = begin(flow, operation, name);
                try {
                    const result = work();
                    if (result && typeof result.then === 'function') return Promise.resolve(result).then(
                        value => { end(true); return value; }, error => { end(false); throw error; });
                    end(true); return result;
                } catch (error) { end(false); throw error; }
            },
            server(value) {
                if (flow && !flow.finished && typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
                    && flow.servers.length < 8) flow.servers.push({ operation, requestId: value });
            },
            checkpoint(name) {
                if (!['entry_ready', 'inventory_ready', 'claims_ready'].includes(name) || !flow || flow.finished) return;
                const field = { entry_ready: 'entryReadyMs', inventory_ready: 'inventoryReadyMs', claims_ready: 'claimsReadyMs' }[name];
                if (flow[field] !== undefined) return;
                flow[field] = round(now() - flow.started);
                if (name !== 'entry_ready') return;
                flow.entryReadyMs = round(now() - flow.started);
                try { root.console.info('[YGO login entry timing] ' + JSON.stringify({ event: 'login_entry_timing', version: 1,
                    flowId: flow.id, mode: flow.mode, entryReadyMs: flow.entryReadyMs })); } catch (_) {}
            },
            finish(outcome) {
                if (!flow || flow.finished || !outcomes.has(outcome)) return;
                flow.finished = true;
                if (active === flow) active = undefined;
                flow.popup?.stop(flow.popup.outcome);
                try {
                    root.console.info('[YGO login timing] ' + JSON.stringify({ event: 'login_client_timing', version: 2,
                        flowId: flow.id, mode: flow.mode, outcome, totalMs: round(now() - flow.started),
                        ...(flow.entryReadyMs === undefined ? {} : { entryReadyMs: flow.entryReadyMs, afterEntryMs: round(now() - flow.started - flow.entryReadyMs) }),
                        ...(flow.inventoryReadyMs === undefined ? {} : { inventoryReadyMs: flow.inventoryReadyMs }),
                        ...(flow.claimsReadyMs === undefined ? {} : { claimsReadyMs: flow.claimsReadyMs }),
                        ...(flow.popup ? { popup: popupSnapshot(flow.popup) } : {}),
                        droppedSpans: flow.dropped, startup: startup(), navigation: flow.navigation, spans: flow.spans.map(s => ({ ...s })), serverRequests: flow.servers }));
                } catch (_) { /* 기록 장애는 로그인·동기화 결과에 영향을 주지 않는다. */ }
            }
        };
    }
    function provider(mode, preserveStart = false) {
        if (!['redirect', 'popup'].includes(mode)) return;
        try {
            const previous = preserveStart ? JSON.parse(root.sessionStorage.getItem(KEY) || 'null') : null;
            const at = previous?.version === 1 && previous.mode === 'popup' && Number.isFinite(previous.at)
                && Date.now() >= previous.at && Date.now() - previous.at <= 600000 ? previous.at : Date.now();
            root.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, mode, at }));
        } catch (_) {}
    }
    function cancelProvider() { try { root.sessionStorage.removeItem(KEY); } catch (_) {} }
    function start() {
        if (active) control(active).finish('superseded');
        const t = now(); let marker;
        try {
            const raw = root.sessionStorage.getItem(KEY); root.sessionStorage.removeItem(KEY);
            const value = raw ? JSON.parse(raw) : null;
            if (value && ['at,mode,version', 'at,mode,outboundMs,version'].includes(Object.keys(value).sort().join(',')) && value.version === 1
                && ['redirect', 'popup'].includes(value.mode) && Number.isFinite(value.at)
                && Date.now() >= value.at && Date.now() - value.at <= 600000) marker = value;
        } catch (_) {}
        const elapsed = marker ? Date.now() - marker.at : t;
        const flow = active = { id: id(), mode: marker?.mode || 'restore', started: t - elapsed,
            spans: [], servers: [], dropped: 0, finished: false };
        const popup = pendingPopup || recentPopup;
        if ((marker?.mode === 'popup' || !marker && pendingPopup) && popup && !popup.attached && Date.now() - popup.wallAt <= 600000) {
            popup.attached = true; popup.point('auth_state'); popup.collect(); flow.popup = popup; recentPopup = undefined;
        }
        if (marker?.mode !== 'popup') flow.spans.push({ operation: 'login', name: 'page_to_auth_state', startMs: round(-flow.started), durationMs: round(t), ok: true });
        flow.navigation = marker?.mode === 'redirect' ? { beforeReturnMs: round(elapsed - t), returnToServiceAuthMs: round(t),
            ...(Number.isFinite(marker.outboundMs) && marker.outboundMs >= 0 && marker.outboundMs <= 600000 ? { outboundMs: round(marker.outboundMs) } : {}) } : {};
        if (marker) flow.spans.push({ operation: 'login', name: 'provider_round_trip', startMs: 0, durationMs: round(elapsed), ok: true });
        return control(flow);
    }
    root.YgoLoginTiming = Object.freeze({ start, provider, cancelProvider, beginPopup, mark, startupMeasure, appCheckFailure, appCheck, recovery, current: () => active ? control(active) : null,
        request: operation => active && operations.has(operation) ? control(active, operation) : null });
})(window);
