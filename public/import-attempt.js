(function (root, factory) {
    const create = factory();
    if (typeof module === 'object' && module.exports) module.exports = create;
    else root.YgoImportAttempt = create(root);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    return function create(root) {
        const storageKey = 'ygo_import_attempts_v1', running = new Map();
        const error = (code, message) => Object.assign(new Error(message), { code });
        const check = valid => { if (!valid()) throw error('IMPORT_ACCOUNT_CHANGED', '계정이 변경되었습니다. 가져오기를 다시 확인해 주세요.'); };
        async function fingerprint(value) {
            const bytes = new root.TextEncoder().encode(JSON.stringify(value));
            return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        }
        function load() {
            try {
                const value = JSON.parse(root.sessionStorage.getItem(storageKey) || '{}');
                if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16
                    || Object.entries(value).some(([k, v]) => !/^[a-f0-9]{64}$/.test(k) || !/^[a-f0-9]{32}$/.test(v))) throw 1;
                return value;
            } catch (_) { throw error('IMPORT_STORAGE_UNAVAILABLE', '가져오기 시도 기록을 보관할 수 없습니다. 브라우저 저장 설정을 확인해 주세요.'); }
        }
        function save(value) {
            try { const text = JSON.stringify(value); root.sessionStorage.setItem(storageKey, text); if (root.sessionStorage.getItem(storageKey) !== text) throw 1; }
            catch (_) { throw error('IMPORT_STORAGE_UNAVAILABLE', '가져오기 시도 기록을 보관할 수 없습니다. 브라우저 저장 설정을 확인해 주세요.'); }
        }
        function forget(key, id) { const value = load(); if (value[key] === id) { delete value[key]; save(value); } }
        async function perform({ uid, source, payload, send, isCurrent }) {
            check(isCurrent);
            const body = source === 'file' ? payload.data ?? null : [payload.spreadsheetId ?? null, payload.fingerprint ?? null];
            const digest = await fingerprint([source, body]), key = await fingerprint([uid, source, body]);
            check(isCurrent);
            const work = (async () => {
                const saved = load();
                if (!saved[key]) {
                    if (Object.keys(saved).length >= 16) throw error('IMPORT_PENDING_LIMIT', '확인되지 않은 가져오기가 남아 있습니다. 이전 저장 결과부터 확인해 주세요.');
                    saved[key] = [...root.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''); save(saved);
                }
                const id = saved[key];
                let status;
                try { status = await send({ importRequestId: id, importFingerprint: digest }, null); }
                catch (e) {
                    if ([404, 405].includes(e.status)) status = { success: true, importRequest: { status: 'unsupported' } };
                    else throw e;
                }
                check(isCurrent);
                const state = status?.success && status.importRequest?.status;
                if (state === 'unsupported' && ['localhost', '127.0.0.1'].includes(root.location?.hostname)) {
                    // 기본 로컬 저장소의 기존 API를 보존한다. 운영 writer 영수증 보호와 구분한다.
                    forget(key, id); return send({}, payload);
                }
                if (state === 'completed' && status.result?.success === true) { try { forget(key, id); } catch (_) {} return status.result; }
                if (state === 'cancelled') {
                    forget(key, id);
                    throw error('IMPORT_REQUEST_CANCELLED', '이전 가져오기가 취소된 것을 확인했습니다. 다시 실행하면 새 시도로 진행합니다.');
                }
                if (state !== 'missing') throw error('IMPORT_RESULT_UNCONFIRMED', state === 'unsupported'
                    ? '서버의 안전한 가져오기 기능이 준비되지 않았습니다. 저장하지 않았습니다.'
                    : '이전 가져오기 저장 결과를 확인 중입니다. 새 작업으로 다시 제출하지 마세요.');
                check(isCurrent);
                try {
                    const result = await send({}, { ...payload, importRequestId: id });
                    if (result?.success !== true) throw error('IMPORT_RESULT_UNCONFIRMED', '가져오기 저장 결과를 확인하지 못했습니다.');
                    try { forget(key, id); } catch (_) {} return result;
                } catch (e) {
                    // 응답 유실에도 ID를 남긴다. 다음 실행은 먼저 서버의 원래 영수증을 조회한다.
                    throw error(e.code || 'IMPORT_RESULT_UNCONFIRMED', e.code === 'SHEET_CHANGED' ? e.message
                        : '가져오기 완료 여부를 확인하지 못했습니다. 다시 실행하면 먼저 이전 저장 결과를 확인합니다.');
                }
            })();
            return work;
        }
        async function execute(options) {
            // 해시 계산이 비동기이므로 그 앞에서 같은 탭의 동시 실행을 공유한다.
            // 이 키는 요청 중 메모리에만 있고 저장소에는 해시/임의 ID만 남긴다.
            const key = JSON.stringify([options.uid, options.source, options.payload]);
            if (running.has(key)) return running.get(key);
            const work = perform(options); running.set(key, work);
            try { return await work; } finally { running.delete(key); }
        }
        return Object.freeze({ execute });
    };
});
