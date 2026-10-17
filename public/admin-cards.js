(() => {
    'use strict';
    const content = document.getElementById('admin-content');
    const el = name => document.getElementById('cards-' + name);
    if (!content || !el('search')) return;
    const endpoint = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net/getPublicCardData';
    const locales = {ko:'한국어', ja:'일본어', ae:'아시아 영어', cn:'중국어', en:'영어', de:'독일어', fr:'프랑스어', it:'이탈리아어', es:'스페인어', pt:'포르투갈어'};
    const common = {card_type:'카드 종류', properties:'분류 (쉼표로 구분)', lv:'레벨 / 랭크 / 링크', attribute:'속성', race:'종족', atk:'공격력', def:'수비력', pendulum_scale:'펜듈럼 스케일'};
    const localized = {name:'카드명', text:'카드 텍스트', text_pen:'펜듈럼 텍스트'};
    let cards = [], original = null, draft = null, controller, sequence = 0, appCheck;
    const copy = value => JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const dirty = () => original && JSON.stringify(original) !== JSON.stringify(draft);
    const showValue = value => value === undefined ? '미등록' : JSON.stringify(value);
    function changes() {
        const entries = [];
        if (original) {
            for (const [key, label] of Object.entries(common)) {
                if (JSON.stringify(original.data.info[key]) !== JSON.stringify(draft.data.info[key])) entries.push([label, original.data.info[key], draft.data.info[key]]);
            }
            for (const [locale, label] of Object.entries(locales)) {
                for (const [key, field] of Object.entries(localized)) {
                    const before = original.data.info[locale]?.[key], after = draft.data.info[locale]?.[key];
                    if (JSON.stringify(before) !== JSON.stringify(after)) entries.push([`${label} · ${field}`, before, after]);
                }
            }
        }
        el('changes').replaceChildren();
        for (const [label, before, after] of entries) {
            const li = document.createElement('li');
            li.textContent = `${label}\n${showValue(before)} → ${showValue(after)}`;
            el('changes').append(li);
        }
        el('change-count').textContent = entries.length + '개';
        el('no-changes').hidden = entries.length > 0;
        el('dirty').textContent = !original ? '선택 대기' : dirty() ? '수정 중 · 저장 안 됨' : '원본';
        el('reset').disabled = !dirty();
    }
    function fields(target, labels, source, update) {
        target.replaceChildren();
        for (const [key, title] of Object.entries(labels)) {
            const label = document.createElement('label');
            label.textContent = title;
            const input = document.createElement(key.startsWith('text') ? 'textarea' : 'input');
            if (input.tagName === 'TEXTAREA') { input.rows = 5; label.className = 'admin-cards-field--wide'; }
            else input.type = 'text';
            input.className = 'ui-input--filled color-surface-002 shape-rounded-lg';
            input.dataset.field = key;
            const value = source[key];
            input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
            input.placeholder = '미등록';
            // 알 수 없는 구조는 문자열로 덮어쓰지 않는다.
            input.readOnly = value !== undefined && value !== null && typeof value === 'object' && !(key === 'properties' && Array.isArray(value) && value.every(item => typeof item === 'string'));
            if (input.readOnly) input.value = JSON.stringify(value);
            input.addEventListener('input', () => {
                if (content.hidden || input.readOnly) return;
                const raw = input.value;
                let next = raw;
                if (key === 'properties') next = raw.split(',').map(item => item.trim()).filter(Boolean);
                else if (typeof value === 'number' && /^-?\d+(\.\d+)?$/.test(raw)) next = Number(raw);
                // 원래 빈 필드로 되돌리면 누락/null/빈 문자열 구분까지 복구한다.
                const display = Array.isArray(value) ? value.join(', ') : value ?? '';
                update(key, raw === String(display) ? value : next);
                changes();
            });
            label.append(input); target.append(label);
        }
    }
    function renderLocale() {
        const locale = el('locale').value;
        const source = object(draft.data.info[locale]) ? draft.data.info[locale] : {};
        fields(el('localized'), localized, source, (key, value) => {
            if (!object(draft.data.info[locale])) draft.data.info[locale] = {};
            if (value === undefined) delete draft.data.info[locale][key];
            else draft.data.info[locale][key] = value;
            if (!Object.keys(draft.data.info[locale]).length && original.data.info[locale] === undefined) delete draft.data.info[locale];
        });
        // 기존 언어 데이터가 다른 형식이면 편집으로 대체하지 않는다.
        if (draft.data.info[locale] !== undefined && !object(draft.data.info[locale])) {
            el('localized').querySelectorAll('input,textarea').forEach(input => input.disabled = true);
        }
        el('printings').textContent = JSON.stringify({packs: source.packs ?? null, ciid: source.ciid ?? null}, null, 2);
    }
    function select(card) {
        if (dirty() && !confirm('수정한 내용을 버리고 다른 카드를 선택할까요?')) return;
        original = copy(card); draft = copy(card);
        el('editor').hidden = false; el('editor').disabled = false; el('select-help').hidden = true;
        el('identity').textContent = `CID ${card.cid} · ${card.data.numbers.join(' · ') || '수록 번호 미등록'}`;
        fields(el('common'), common, draft.data.info, (key, value) => {
            if (value === undefined) delete draft.data.info[key]; else draft.data.info[key] = value;
        });
        el('locale').value = Object.keys(locales).find(locale => object(card.data.info[locale])) || 'ko';
        renderLocale(); changes();
        el('results').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cid === card.cid)));
    }
    function clear() {
        original = draft = null; cards = [];
        el('editor').hidden = true; el('editor').disabled = true; el('select-help').hidden = false;
        el('common').replaceChildren(); el('localized').replaceChildren(); el('printings').textContent = ''; el('identity').textContent = '';
        el('results').replaceChildren(); el('count').textContent = '0개'; el('empty').hidden = false;
        changes();
    }
    async function getAppToken() {
        if (!appCheck) {
            if (!window.firebase?.appCheck) throw Error('App Check를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
            if (['localhost','127.0.0.1','192.168.0.22'].includes(location.hostname) || location.hostname.endsWith('.local')) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
            appCheck = firebase.appCheck();
            appCheck.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider('6Le3FaksAAAAAFE9lMsuyGfgTkvNaVzrThMUthe3'), true);
        }
        return (await appCheck.getToken()).token;
    }
    el('search').addEventListener('submit', async event => {
        event.preventDefault();
        if (content.hidden || el('search-fields').disabled) return;
        const value = el('query').value.trim(), kind = el('kind').value;
        if (!value || kind === 'cid' && !/^[1-9]\d{0,9}$/.test(value)) { el('status').textContent = 'CID는 1~10자리의 양의 정수로 입력해 주세요.'; return; }
        if (dirty() && !confirm('수정한 내용을 버리고 새로 검색할까요?')) return;
        clear(); controller?.abort(); controller = new AbortController();
        const current = ++sequence, signal = controller.signal;
        el('search-fields').disabled = true; el('results').setAttribute('aria-busy', 'true'); el('status').textContent = '카드 데이터를 조회하고 있습니다.';
        const timer = setTimeout(() => { controller.abort(); if (current === sequence && !content.hidden) { el('status').textContent = '조회 시간이 초과되었습니다. App Check 설정과 연결 상태를 확인해 주세요.'; el('search-fields').disabled = false; el('results').setAttribute('aria-busy', 'false'); } }, 25000);
        try {
            const token = await getAppToken();
            if (signal.aborted || current !== sequence || content.hidden) return;
            const response = await fetch(endpoint, {method:'POST', credentials:'omit', cache:'no-store', redirect:'error', signal, headers:{'Content-Type':'application/json','X-Firebase-AppCheck':token}, body:JSON.stringify(kind === 'cid' ? {cids:[value]} : {field:kind, value})});
            const result = await response.json();
            if (signal.aborted || current !== sequence || content.hidden) return;
            if (!response.ok || result.success !== true) throw Error(response.status === 401 || response.status === 403 ? 'App Check 인증을 확인해 주세요. 로컬 테스트는 Firebase에 등록된 디버그 환경이 필요합니다.' : '카드를 조회하지 못했습니다. API 연결 상태와 검색 조건을 확인해 주세요.');
            if (!Array.isArray(result.cards) || result.cards.length > 100 || result.cards.some(card => !/^[1-9]\d{0,9}$/.test(card.cid) || !object(card.data) || !Array.isArray(card.data.names) || !Array.isArray(card.data.numbers) || !object(card.data.info))) throw Error('카드 데이터 형식을 확인하지 못했습니다.');
            cards = result.cards;
            for (const card of cards) {
                const li = document.createElement('li'), button = document.createElement('button'), name = document.createElement('span'), detail = document.createElement('small');
                button.type = 'button'; button.dataset.cid = card.cid; button.setAttribute('aria-pressed', 'false');
                button.className = 'ui-button color-navi shape-rounded-lg admin-cards-result';
                name.textContent = card.data.info.ko?.name || card.data.names[0] || `CID ${card.cid}`;
                detail.textContent = `CID ${card.cid} · ${card.data.numbers.join(' · ') || '수록 번호 미등록'}`;
                button.append(name, detail); button.addEventListener('click', () => select(card)); li.append(button); el('results').append(li);
            }
            el('count').textContent = cards.length + '개'; el('empty').hidden = cards.length > 0;
            el('empty').textContent = '일치하는 카드가 없습니다. 검색 조건을 확인해 주세요.';
            el('status').textContent = `${cards.length}개의 카드를 조회했습니다.`;
        } catch (error) {
            if (current === sequence && !content.hidden && !signal.aborted) el('status').textContent = error.message || '조회 중 오류가 발생했습니다.';
        } finally {
            clearTimeout(timer);
            if (current === sequence && !content.hidden) { el('search-fields').disabled = false; el('results').setAttribute('aria-busy', 'false'); }
        }
    });
    el('kind').addEventListener('change', () => { el('query').placeholder = {cid:'CID 입력', names:'정확한 카드명 입력', numbers:'정확한 수록 번호 입력'}[el('kind').value]; });
    for (const [value, label] of Object.entries(locales)) el('locale').add(new Option(label, value));
    el('locale').addEventListener('change', renderLocale);
    el('reset').addEventListener('click', () => { if (original && confirm('모든 변경 사항을 원본으로 되돌릴까요?')) { const card = original; original = null; select(card); } });
    window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
    new MutationObserver(() => {
        if (content.hidden) { sequence++; controller?.abort(); clear(); el('query').value = ''; el('search-fields').disabled = true; }
        else el('search-fields').disabled = false;
    }).observe(content, {attributes:true, attributeFilter:['hidden']});
    el('search-fields').disabled = content.hidden;
})();
