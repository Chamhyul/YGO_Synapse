/* 검색·보유 목록 편집 UI. 원본 데이터와 적용/닫기 수명주기는 호출자가 관리한다. */
const FilterEditor = (() => {
function render({ form, key:editKey, definition, drafts, mobile, scope='search', sort:initialSort='', errorId, changed=()=>{} }) {
    let sortDraft = initialSort;
    const draftState = () => drafts;
    const button = (text, classes, action) => { const el=document.createElement('button'); el.type='button'; el.className=classes; el.textContent=text; el.onclick=action; return el; };
    function sortOptionList() {
        if (scope !== 'inventory') return;
        const list = form.querySelector('.filter-option-list');
        if (!list) return;
        const options = definition.options;
        const originalOrder = new Map(options.map((option, index) => [option.value, index]));
        const rows = [...list.querySelectorAll('.filter-option-item')];
        rows.sort((a, b) => {
            if (!sortDraft) return originalOrder.get(a.querySelector('input').value) - originalOrder.get(b.querySelector('input').value);
            const order = a.textContent.localeCompare(b.textContent, 'ko', { numeric:true, sensitivity:'base' });
            return (sortDraft === 'asc' ? order : -order)
                || originalOrder.get(a.querySelector('input').value) - originalOrder.get(b.querySelector('input').value);
        });
        // 기존 노드를 이동해 체크 상태·검색에 따른 숨김 상태를 유지한다.
        for (const row of rows) list.insertBefore(row, list.querySelector('[data-empty-options]')); 
    }
    function renderOptions(definition, form) {
        const group = document.createElement('div'); group.dataset.selectionGroup = '';
        const query = (scope === 'inventory' || ['monster', 'race'].includes(editKey)) ? document.createElement('input') : null;
        if (query) {
            query.type = 'text'; query.className = 'filter-input-field ui-input--filled color-type001 shape-rounded002';
            query.placeholder = scope === 'inventory' && ['name', 'number'].includes(editKey) ? `${definition.label} 검색` : '선택지 검색';
            query.setAttribute('aria-label', query.placeholder);
            query.setAttribute('aria-controls', `${errorId}-options`); query.autocomplete = 'off';
        }
        const tools = document.createElement('div'); tools.dataset.selectionTools = '';
        const count = document.createElement('span'); count.className = 'color-text-002'; count.setAttribute('aria-live', 'polite');
        let operatorSwitch = null;
        if (definition.characteristic) {
            const label = document.createElement('label');
            label.dataset.operatorSwitch = '';
            const control = document.createElement('span'); control.className = 'theme-switch';
            const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch');
            input.checked = draftState()[editKey].operator === 'and';
            const track = document.createElement('span');
            track.className = 'theme-switch__track color-switch-theme color-text-001 shape-capsule'; track.setAttribute('aria-hidden', 'true');
            const update = () => {
                const operator = input.checked ? 'AND' : 'OR';
                input.setAttribute('aria-label', `유형 조합 방식: ${operator}`);
                track.dataset.operator = operator;
            };
            input.onchange = () => { draftState()[editKey].operator = input.checked ? 'and' : 'or'; update(); };
            update(); control.append(input, track); label.append(control); operatorSwitch = label;
        }
        const list = document.createElement('ul'); list.id = `${errorId}-options`; list.className = 'filter-option-list color-surface-000 shape-rounded003';
        const toggle = definition.characteristic ? null : button('모두 선택', 'filter-select-toggle ui-button ui-button--text color-text-theme color-highlight-theme', () => {
            const visible = [...list.querySelectorAll('li:not([hidden]) input')];
            const select = !visible.some(input => input.checked);
            const values = new Set(definition.characteristic ? draftState()[editKey].values : draftState()[editKey]);
            for (const input of visible) { input.checked = select; if (select) values.add(input.value); else values.delete(input.value); }
            if (definition.characteristic) draftState()[editKey].values = [...values]; else draftState()[editKey] = [...values];
            update();
        });
        const empty = document.createElement('li'); empty.dataset.emptyOptions = ''; empty.className = 'color-text-002';
        empty.textContent = '일치하는 선택지가 없습니다.'; empty.hidden = true;
        for (const option of definition.options) {
            const row = document.createElement('li'); row.className = 'filter-option-item';
            const label = document.createElement('label'); label.className = 'ui-button color-type004 shape-rounded002';
            const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'color-text-theme'; input.value = option.value;
            input.checked = (definition.characteristic ? draftState()[editKey].values : draftState()[editKey]).includes(option.value);
            const text = document.createElement('span'); text.textContent = option.label;
            input.onchange = () => {
                let values = definition.characteristic ? draftState()[editKey].values : draftState()[editKey];
                values = input.checked ? [...new Set([...values, option.value])] : values.filter(value => value !== option.value);
                if (definition.characteristic) draftState()[editKey].values = values; else draftState()[editKey] = values;
                update();
            };
            label.append(input, text); row.append(label); list.append(row);
        }
        list.append(empty);
        function update() {
            const visible = [...list.querySelectorAll('.filter-option-item')].filter(row => !row.hidden);
            const values = definition.characteristic ? draftState()[editKey].values : draftState()[editKey];
            count.textContent = `${values.length}개 선택${query?.value ? ` · 검색 결과 ${visible.length}개` : ''}`;
            if (toggle) {
                toggle.textContent = visible.some(row => row.querySelector('input').checked) ? '모두 해제' : '모두 선택';
                toggle.disabled = !visible.length;
            }
            empty.hidden = !!visible.length;
            updateApplyAvailability();
        }
        if (query) query.oninput = () => {
            const value = normalizeStr(query.value);
            for (const row of list.querySelectorAll('.filter-option-item')) row.hidden = !!value && !matchKorean(row.textContent, value);
            toggle?.setAttribute('aria-label', value ? '검색된 선택지 모두 선택 또는 해제' : '모든 선택지 선택 또는 해제'); update();
        };
        tools.append(count, operatorSwitch || toggle); group.append(tools, list);
        if (query) {
            if (mobile) group.append(query);
            else group.prepend(query);
        }
        form.append(group); update(); sortOptionList();
    }
    function updateApplyAvailability() { changed(drafts[editKey]); }
    function renderNumbers(definition, form) {
        const numbers = document.createElement('div'); numbers.className = 'catalog-filter-editor__numbers';
        for (const part of definition.numeric === 'range' ? ['from', 'to'] : ['']) {
            const label = document.createElement('label');
            const text = document.createElement('span'); text.textContent = part ? part === 'from' ? '최소' : '최대' : '값 (0~13)';
            const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'numeric';
            input.className = 'catalog-filter-editor__number ui-input--filled color-type001 shape-rounded002';
            input.value = (part ? drafts[editKey][part] : drafts[editKey]) ?? '';
            input.setAttribute('aria-describedby', errorId);
            input.oninput = () => { if (part) drafts[editKey][part] = input.value; else drafts[editKey] = input.value; changed(drafts[editKey]); };
            if (part) {
                input.placeholder = text.textContent;
                input.setAttribute('aria-label', `${definition.label} ${text.textContent}`);
                label.append(input);
                if (part === 'to') {
                    const separator = document.createElement('span'); separator.textContent = '~';
                    separator.className = 'color-text-002'; separator.setAttribute('aria-hidden', 'true'); numbers.append(separator);
                }
            } else label.append(text, input);
            numbers.append(label);
        }
        form.append(numbers);
    }

    form.replaceChildren();
    if (definition.options) renderOptions(definition, form); else renderNumbers(definition, form);
    return { sort(direction) { sortDraft=direction; sortOptionList(); } };
}
function sortButton(direction, change) {
    const button=document.createElement('button'); button.type='button'; button.className='ui-button ui-button--text color-text-001';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('width','24'); svg.setAttribute('height','24'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','currentColor'); svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path'); svg.append(path); button.append(svg);
    function sync() {
        const state = direction === 'asc' ? ['오름차순','내림차순','M3 6h6v2H3zm0 5h12v2H3zm0 5h18v2H3z'] : direction === 'desc' ? ['내림차순','비활성','M3 6h18v2H3zm0 5h12v2H3zm0 5h6v2H3z'] : ['비활성','오름차순','M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z'];
        path.setAttribute('d',state[2]); button.title=`정렬: ${state[0]}`; button.setAttribute('aria-label',`정렬: ${state[0]}. 누르면 ${state[1]}`);
    }
    button.onclick=()=>{ direction=direction === '' ? 'asc' : direction === 'asc' ? 'desc' : ''; sync(); change(direction); }; sync(); return button;
}
return { render, sortButton };
})();
