/* 인증 결과를 먼저 반환하고 같은 응답의 기록 종료는 별도로 회수한다. */
(function (root) {
    'use strict';
    const contentType = 'application/x-ndjson';
    // 계정/판정 본문 없이 화면 적용과 기록 수신의 순서만 확인한다.
    function stamp(kind, phase) {
        if (!['admin', 'youtube', 'discord'].includes(kind)) return;
        try { root.document?.documentElement?.setAttribute('data-authentication-' + kind + '-' + phase, String(Date.now())); } catch (_) {}
    }
    function resultKind(value) {
        const provider = value?.sourceMembership?.verificationProvider;
        return ['youtube', 'discord'].includes(provider) ? provider : value?.role ? 'admin' : null;
    }
    function supported(response) {
        return response.headers?.get('Content-Type')?.split(';')[0].trim() === contentType;
    }
    function read(response, { onRecorded = () => {}, onFailure = () => {}, maxBytes = 1024 * 1024 } = {}) {
        if (!supported(response)) return response.json();
        return new Promise((resolve, reject) => {
            let resultReceived = false, terminal = false, failureReported = false, kind;
            const fail = () => {
                if (failureReported) return;
                failureReported = true;
                if (resultReceived) { try { onFailure(); } catch (_) {} }
                else reject(new Error('인증 응답을 확인하지 못했습니다.'));
            };
            (async () => {
                const reader = response.body.getReader(), decoder = new TextDecoder();
                let buffer = '', bytes = 0;
                function packet(line) {
                    if (!line.trim()) return;
                    const value = JSON.parse(line);
                    if (value.v !== 1 || terminal) throw new Error();
                    if (value.type === 'result' && !resultReceived && value.result?.success === true) {
                        resultReceived = true;
                        kind = resultKind(value.result);
                        stamp(kind, 'result');
                        resolve(value.result);
                    } else if (value.type === 'recorded' && resultReceived) {
                        terminal = true;
                        stamp(kind, 'recorded');
                        if (value.success === true && value.result?.success === true) {
                            Promise.resolve().then(() => onRecorded(value.result)).catch(() => {});
                        } else fail();
                    } else throw new Error();
                }
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) { buffer += decoder.decode(); break; }
                        bytes += value.byteLength;
                        if (bytes > maxBytes) throw new Error();
                        buffer += decoder.decode(value, { stream: true });
                        let newline;
                        while ((newline = buffer.indexOf('\n')) >= 0) {
                            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                            packet(line);
                        }
                    }
                    if (buffer.trim()) packet(buffer);
                    if (!terminal) throw new Error();
                } finally { reader.releaseLock(); }
            })().catch(fail);
        });
    }
    root.YgoAuthenticationResult = { read, supported, displayed: kind => stamp(kind, 'displayed') };
})(globalThis);
