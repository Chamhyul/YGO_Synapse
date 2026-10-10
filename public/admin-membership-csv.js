(() => {
    'use strict';
    const content = document.getElementById('admin-content');
    const panel = document.getElementById('membership-csv-panel');
    if (!panel || !content || content.hidden) return;
    const element = name => document.getElementById('membership-csv-' + name);
    const file = element('file'), status = element('status'), resultButton = element('result');
    const storageKey = 'admin-membership-csv-operation:' + content.dataset.adminUid;
    let csvText = '', preview = null, operationId = '', busy = false, generation = 0;
    const controllers = new Set();
    try { operationId = sessionStorage.getItem(storageKey) || ''; } catch (_) {}
    if (!/^[a-f0-9]{32}$/.test(operationId)) operationId = '';
    function remember(id) {
        operationId = id;
        try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch (_) {}
    }
    function controls() {
        const blocked = busy || content.hidden || !!operationId;
        file.disabled = blocked;
        file.closest('label').setAttribute('aria-disabled', String(blocked));
        element('preview-button').disabled = blocked || !csvText;
        element('apply').disabled = blocked || !preview;
        element('refresh').disabled = busy || content.hidden;
        resultButton.hidden = !operationId;
        resultButton.disabled = busy || content.hidden;
        panel.setAttribute('aria-busy', String(busy));
    }
    function clearPreview() { preview = null; element('preview').hidden = true; controls(); }
    async function api(suffix = '', body) {
        const controller = new AbortController(); controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch('/admin/api/membership-csv' + suffix, {
                method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
                ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
            });
            if (response.status === 401 || response.status === 403) {
                content.hidden = true; location.reload(); throw new Error('관리자 로그인 상태를 다시 확인해 주세요.');
            }
            let data;
            try { data = await response.json(); } catch (_) { throw new Error('서버 응답을 확인하지 못했습니다.'); }
            if (!response.ok || !data.success) throw Object.assign(new Error(data.message || '서버 연결 또는 배포 상태를 확인해 주세요.'), { code: data.code, status: response.status });
            return data;
        } finally { clearTimeout(timer); controllers.delete(controller); }
    }
    const time = value => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
    function showCurrent(data) {
        element('current').textContent = `현재 ${data.count}명 · 마지막 적용 ${time(data.updatedAt)}`;
    }
    async function refresh() {
        if (busy || content.hidden) return;
        busy = true; controls();
        try { showCurrent(await api()); if (!operationId) status.textContent = 'CSV 파일을 선택한 뒤 파일 내용을 확인해 주세요.'; }
        catch (error) { if (!content.hidden) { element('current').textContent = '현재 목록 확인 불가'; status.textContent = error.message; } }
        finally { busy = false; controls(); }
    }
    file.addEventListener('change', async () => {
        const selected = file.files[0], version = ++generation;
        csvText = ''; clearPreview();
        element('filename').textContent = selected?.name || '선택한 파일 없음';
        if (!selected) return;
        if (!/\.csv$/i.test(selected.name) || selected.size > 1024 * 1024) {
            status.textContent = '1MB 이하의 CSV 파일을 선택해 주세요.'; return;
        }
        busy = true; controls();
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
            if (version !== generation || content.hidden) return;
            csvText = text; status.textContent = '파일 내용 확인을 누르면 적용 전 변경 수를 확인할 수 있습니다.';
        } catch (_) { status.textContent = 'UTF-8 CSV 파일을 읽지 못했습니다. YouTube Studio에서 다시 내려받아 주세요.'; }
        finally { busy = false; controls(); }
    });
    element('preview-button').addEventListener('click', async () => {
        if (busy || !csvText || operationId || content.hidden) return;
        const version = generation;
        busy = true; clearPreview(); status.textContent = '파일과 현재 목록을 확인하고 있습니다.';
        try {
            const data = await api('/preview', { csvText });
            if (version !== generation || content.hidden) return;
            preview = data;
            element('changes').textContent = `${data.previousCount}명 → ${data.count}명 · 추가 ${data.added}명 · 제외 ${data.removed}명 · 등급 변경 ${data.changed}명`;
            element('tiers').replaceChildren(...data.tiers.map(tier => {
                const item = document.createElement('li'); item.textContent = `${tier.levelName}: ${tier.count}명`; return item;
            }));
            element('preview').hidden = false;
            status.textContent = '변경 수를 확인해 주세요. 운영 목록 교체를 누르기 전까지 서버 목록은 유지됩니다.';
        } catch (error) { if (!content.hidden) status.textContent = error.message; }
        finally { busy = false; controls(); }
    });
    function completed(data) {
        showCurrent(data); remember(''); csvText = ''; file.value = ''; clearPreview();
        element('filename').textContent = '선택한 파일 없음';
        status.textContent = `운영 회원 목록을 ${data.count}명으로 교체했습니다.`;
    }
    element('apply').addEventListener('click', async () => {
        if (busy || !preview || operationId || content.hidden) return;
        if (!confirm(`운영 회원 목록 전체를 ${preview.count}명으로 교체할까요? 새 CSV에 없는 회원은 목록에서 제외됩니다.`)) return;
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        remember([...bytes].map(value => value.toString(16).padStart(2, '0')).join(''));
        busy = true; controls(); status.textContent = '운영 회원 목록을 적용하고 있습니다.';
        try {
            const data = await api('', { csvText, revision: preview.revision, fingerprint: preview.fingerprint, operationId });
            if (!content.hidden) completed(data);
        } catch (error) {
            if (!content.hidden) {
                if (error.status === 400 || error.code === 'MEMBERSHIP_CSV_CONFLICT') {
                    remember(''); clearPreview(); status.textContent = error.message;
                } else status.textContent = '적용 결과를 아직 확인하지 못했습니다. 다시 업로드하지 말고 적용 결과 확인을 눌러 주세요.';
            }
        } finally { busy = false; controls(); }
    });
    resultButton.addEventListener('click', async () => {
        if (busy || !operationId || content.hidden) return;
        busy = true; controls();
        try {
            const data = await api('/status', { operationId });
            if (content.hidden) return;
            if (data.status === 'completed') { completed(data.result); await refreshAfterResult(); }
            else if (data.status === 'failed') {
                remember(''); clearPreview(); status.textContent = '이 작업은 적용되지 않았습니다. 파일 내용을 다시 확인해 주세요.';
            } else if (data.status === 'pending') status.textContent = '서버에서 적용 중입니다. 잠시 후 적용 결과를 다시 확인해 주세요.';
            else {
                status.textContent = '서버에 작업 기록이 없습니다. 늦게 도착할 수 있으므로 잠시 후 다시 확인해 주세요.';
                // 요청이 서버에 도착하지 않은 경우에도 새 작업은 사용자가 판단하여 시작한다.
                if (confirm('서버에 작업 기록이 없습니다. 잠시 기다린 뒤에도 같다면 새 작업을 시작할 수 있습니다. 이전 요청이 늦게 도착할 수 있습니다. 새 작업을 준비할까요?')) {
                    remember(''); clearPreview(); status.textContent = '파일 내용을 다시 확인해 주세요. 목록이 변경되면 서버가 새 적용 요청을 차단합니다.';
                }
            }
        } catch (error) { if (!content.hidden) status.textContent = error.message; }
        finally { busy = false; controls(); }
    });
    async function refreshAfterResult() {
        try { showCurrent(await api()); } catch (_) { /* 완료 결과는 유지하고 다음 새로고침에서 현재 목록을 확인한다. */ }
    }
    element('refresh').addEventListener('click', refresh);
    new MutationObserver(() => {
        if (!content.hidden) return;
        generation++; csvText = ''; preview = null; file.value = '';
        controllers.forEach(controller => controller.abort()); controls();
    }).observe(content, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('beforeunload', event => { if (busy && operationId) { event.preventDefault(); event.returnValue = ''; } });
    if (operationId) status.textContent = '앞서 요청한 작업의 적용 결과를 확인해 주세요.';
    controls(); refresh();
})();
