/* Excel 파일을 선택할 때만 기존 SheetJS 배포본을 준비한다. */
(function (root) {
    'use strict';
    const source = 'https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js';
    let pending = null;
    const available = () => typeof root.XLSX?.read === 'function'
        && typeof root.XLSX?.utils?.sheet_to_json === 'function';

    function load() {
        if (available()) return Promise.resolve(root.XLSX);
        if (pending) return pending;
        let resolve, reject;
        pending = new Promise((yes, no) => { resolve = yes; reject = no; });
        const result = pending;
        const script = document.createElement('script');
        let settled = false;
        const finish = success => {
            if (settled) return;
            settled = true;
            root.clearTimeout(timer);
            script.onload = script.onerror = null;
            if (success && available()) resolve(root.XLSX);
            else {
                script.remove();
                pending = null;
                reject(Object.assign(new Error('Excel 파일 도구를 불러오지 못했습니다. 파일을 다시 선택해주세요.'),
                    { code: 'SPREADSHEET_LOAD_FAILED' }));
            }
        };
        const timer = root.setTimeout(() => finish(false), 20000);
        script.src = source;
        script.async = true;
        script.onload = () => finish(true);
        script.onerror = () => finish(false);
        try { document.head.appendChild(script); }
        catch (_) { finish(false); }
        return result;
    }
    root.AppSpreadsheet = Object.freeze({ load });
})(window);
