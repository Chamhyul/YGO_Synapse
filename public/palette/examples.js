// 제품 스타일을 소비하는 합성 예제입니다. 앱 초기화·계정·검색 API는 호출하지 않습니다.
const cleanups = new WeakMap();
let sequence = 0;

export function renderExamples(container) {
    cleanups.get(container)?.();
    const document = container.ownerDocument;
    const ownedCards = document.defaultView?.OwnedCards || globalThis.OwnedCards;
    const prefix = `palette-example-${++sequence}`;
    const ownedContainers = [];
    const removers = [];
    const element = (tag, classes = '', text) => {
        const node = document.createElement(tag);
        if (classes) node.className = classes;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const listen = (node, type, handler) => {
        node.addEventListener(type, handler);
        removers.push(() => node.removeEventListener(type, handler));
    };
    const icon = (name, extra = '') => {
        const node = element('i', `material-icons ${extra}`.trim(), name);
        node.setAttribute('aria-hidden', 'true');
        return node;
    };
    const button = (label, classes, action) => {
        const node = element('button', classes, label);
        node.type = 'button';
        if (action) node.dataset.paletteAction = action;
        return node;
    };
    const section = (key, title, description) => {
        const node = element('section');
        node.dataset.paletteExample = key;
        const heading = element('h2', '', title);
        heading.dataset.paletteCaption = 'title';
        const note = element('p', '', description);
        note.dataset.paletteCaption = 'description';
        const stage = element('div');
        stage.dataset.paletteStage = key;
        node.append(heading, note, stage);
        container.appendChild(node);
        return stage;
    };
    const caption = text => {
        const node = element('p', '', text);
        node.dataset.paletteCaption = 'sample';
        return node;
    };
    const row = () => {
        const node = element('div');
        node.dataset.paletteRow = '';
        return node;
    };
    const fakeLink = (label, classes, action) => {
        const node = element('a', classes, label);
        node.href = '#';
        if (action) node.dataset.paletteAction = action;
        return node;
    };
    container.replaceChildren();
    const status = element('p');
    status.dataset.paletteCaption = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const announce = message => { status.textContent = message; };
    listen(container, 'click', event => {
        if (event.target.closest?.('a[href="#"]')) event.preventDefault();
        const action = event.target.closest?.('[data-palette-action]');
        if (action && container.contains(action)) announce(`${action.dataset.paletteAction} 실제 서비스 동작은 실행하지 않습니다.`);
    });

    // 홈 본문 상속과 로그인 버튼의 고유 크기를 함께 사용합니다.
    const home = section('home', '[홈]-[로그인 안내·로그인하기]',
        '실제 home-page·home-signin 구조와 색상·곡률 조합입니다. 로그인은 안내만 표시합니다.');
    const homeContext = element('div', 'home-page color-text-001');
    const signin = element('section', 'home-signin color-surface-001 shape-rounded-lg');
    signin.setAttribute('aria-label', '로그인 안내 합성 예제');
    const description = element('div', 'home-signin__description');
    description.appendChild(element('h2', 'home-signin__title color-text-000', '로그인하여 아래의 기능을 이용할 수 있습니다.'));
    const features = element('ul', 'home-signin__features');
    features.setAttribute('role', 'list');
    for (const text of ['카드 등록: 이름과 번호로 보유한 카드를 등록합니다.', '요약 정보: 등록한 카드의 수량과 보관 위치를 확인합니다.']) {
        const item = element('li');
        const marker = element('span', 'home-signin__marker color-text-theme', '•');
        marker.setAttribute('aria-hidden', 'true');
        item.append(marker, element('span', '', text));
        features.appendChild(item);
    }
    description.appendChild(features);
    signin.append(description, button('로그인하기', 'ui-button home-signin__action color-theme shape-capsule', '[홈]-[로그인하기] 예제입니다.'));
    homeContext.appendChild(signin);
    home.appendChild(homeContext);

    const faq = section('faq', '[홈]-[FAQ·팁과 세그먼트]',
        '질문은 네이티브 details로 열고 닫습니다. 실제 공통 CSS의 외형·아이콘 회전은 적용하며 앱의 높이·좌우 전환 애니메이션은 포함하지 않습니다. 세그먼트는 선택 외형만 바뀝니다.');
    const segment = (key, compact) => {
        const fieldset = element('fieldset', `ui-segment ${compact ? 'ui-segment--compact' : 'home-resources__segment'} color-surface-001 shape-capsule`);
        const group = `${prefix}-${key}`;
        fieldset.appendChild(element('legend', 'visually-hidden', compact ? '소형 세그먼트 예제' : 'FAQ 세그먼트 예제'));
        const labels = compact ? ['등록', '이동', '제거'] : ['자주 묻는 질문 (FAQ)', '카드 보관 팁'];
        labels.forEach((text, index) => {
            const input = element('input', 'ui-segment__input');
            input.type = 'radio'; input.name = group; input.id = `${group}-${index}`; input.checked = index === 0;
            const label = element('label', 'ui-segment__option color-text-selectable shape-capsule');
            label.htmlFor = input.id;
            if (!compact) {
                const glyph = element('i', index === 0 ? 'fa-solid fa-circle-question' : 'fa-solid fa-lightbulb');
                glyph.setAttribute('aria-hidden', 'true');
                label.append(glyph, document.createTextNode(` ${text}`));
            } else label.textContent = text;
            fieldset.append(input, label);
        });
        const indicator = element('div', 'ui-segment__indicator color-surface-002 shape-capsule');
        indicator.setAttribute('aria-hidden', 'true');
        fieldset.appendChild(indicator);
        return fieldset;
    };
    faq.append(segment('faq', false), caption('[공통]-[소형 세그먼트] 크기 변형만 비교하며 관리 기능은 실행하지 않습니다.'), segment('compact', true));
    const questions = element('div', 'home-resources__panel');
    for (const [title, answer, open] of [
        ['카드를 어떻게 검색하나요?', '카드 이름 또는 번호로 검색할 수 있습니다.', false],
        ['보관 위치를 여러 개 사용할 수 있나요?', '보관 위치별로 등록된 카드를 확인할 수 있습니다. 이 문구는 긴 답변의 줄바꿈을 확인하기 위한 합성 예제입니다.', true]
    ]) {
        const details = element('details', 'ui-disclosure color-surface-001 shape-rounded-lg');
        details.open = open;
        const summary = element('summary', 'ui-disclosure__summary color-text-000');
        const chevron = element('i', 'fa-solid fa-chevron-down ui-disclosure__icon color-text-001 color-highlight-theme');
        chevron.setAttribute('aria-hidden', 'true');
        summary.append(element('span', '', title), chevron);
        const body = element('p', 'ui-disclosure__body color-text-001', `${answer} `);
        body.appendChild(fakeLink('관련 안내', 'ui-link color-text-theme color-highlight-theme', '[홈]-[FAQ 본문 링크] 예제입니다.'));
        details.append(summary, body);
        questions.appendChild(details);
    }
    faq.appendChild(questions);

    const mobileMode = document.documentElement.classList.contains('is-mobile-device');
    const searchStage = section('search-input', mobileMode
        ? '[모바일 검색]-[검색바·최근 검색·추천 항목]'
        : '[데스크톱 검색]-[검색바·최근 검색·추천 항목]',
    '현재 플랫폼의 실제 검색 입력·버튼·열린 목록 외형만 표시합니다. 입력·추천 선택·지우기는 로컬 예제이며 원격 검색, 사진 검색, 앱 화면 전환은 실행하지 않습니다. 전체 masthead와 고정 검색 오버레이는 제외했습니다.');
    const searchInput = element('input', `search-input search-input--${mobileMode ? 'mobile' : 'desktop'} color-text-000`);
    searchInput.type = mobileMode ? 'search' : 'text';
    searchInput.id = mobileMode ? 'mobile-card-search' : 'card-search';
    searchInput.placeholder = '카드 검색';
    searchInput.autocomplete = 'off';
    searchInput.setAttribute('aria-label', '로컬 예제 카드 검색');
    const searchList = element('ul', `custom-dropdown${mobileMode ? ' mobile-dropdown' : ''} active`);
    searchList.id = mobileMode ? 'mobile-custom-dropdown' : 'custom-dropdown';
    searchList.dataset.paletteSearchList = mobileMode ? 'mobile' : 'desktop';
    const suggestions = [];
    for (const [index, owned] of [true, false].entries()) {
        const suggestion = element('li', `text-suggest color-type004${index === 0 ? ' selected' : ''}`);
        const tag = element('span', `ui-tag shape-rounded001 ${owned ? 'color-tint-theme' : 'color-tint-neutral'}`, '이름');
        const text = element('span', owned ? 'color-text-theme' : 'color-text-001');
        text.append(document.createTextNode(owned ? '예시 ' : '다른 '), element('span', `text-match ${owned ? 'color-text-000' : 'color-text-001'}`, '드래곤'));
        suggestion.append(tag, text);
        listen(suggestion, 'click', () => {
            suggestions.forEach(item => item.classList.toggle('selected', item === suggestion));
            searchInput.value = owned ? '예시 드래곤' : '다른 드래곤';
            searchInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
            announce('[검색]-[추천 항목] 입력 예제만 선택했습니다.');
        });
        suggestions.push(suggestion);
    }
    const recentHeader = element('li', 'recent-header-item');
    recentHeader.append(element('span', 'color-text-001', '최근 검색'), button('전체 제거', 'ui-button ui-button--text color-text-002 clear-all-btn', '[검색]-[최근 기록 전체 제거] 예제입니다.'));
    searchList.appendChild(recentHeader);
    if (mobileMode) {
        const recent = element('li', 'mobile-recent-container');
        const actions = element('div', 'recent-search-actions');
        for (const [label, appearance] of [
            ['예시 드래곤', 'shape-capsule color-tint-theme'],
            ['DEMO-KR002', 'shape-capsule color-tint-neutral'],
            ['일반 검색어', 'ui-button--text color-text-001']
        ]) {
            const item = button(label, `ui-button recent-search-button ${appearance}`);
            listen(item, 'click', () => { searchInput.value = label; searchInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true })); announce('[모바일 검색]-[최근 검색] 입력 예제만 변경했습니다.'); });
            actions.appendChild(item);
        }
        const clearAll = button('', 'ui-button ui-button--text color-text-002 clear-all-icon', '[모바일 검색]-[최근 기록 전체 제거] 예제입니다.');
        clearAll.setAttribute('aria-label', '최근 검색 기록 전체 제거 예제');
        clearAll.appendChild(icon('delete')); recent.append(actions, clearAll); searchList.appendChild(recent);
    } else {
        for (const [text, tint, type] of [['예시 드래곤', 'color-tint-theme', '이름'], ['DEMO-KR002', 'color-tint-neutral', '번호']]) {
            const recent = element('li', 'recent-item-row color-type004');
            const label = element('span');
            label.append(element('span', `ui-tag shape-rounded001 ${tint}`, type), document.createTextNode(text));
            const remove = button('', 'ui-button ui-button--text color-text-002 item-delete-btn', '[데스크톱 검색]-[최근 기록 제거] 예제입니다.');
            remove.setAttribute('aria-label', `${text} 최근 기록 제거 예제`); remove.appendChild(icon('close'));
            recent.append(label, remove); searchList.appendChild(recent);
        }
    }
    searchList.append(...suggestions);
    let clearInput;
    if (mobileMode) {
        const toolbar = element('div', 'mobile-search__toolbar color-surface-000 border-section-000');
        const inputWrap = element('div', 'mobile-search__input-wrap');
        const surface = element('div', 'mobile-search__surface ui-search-surface color-surface-001 shadow-small shape-capsule border-basic');
        surface.setAttribute('aria-hidden', 'true');
        const submit = button('', 'ui-button ui-button--text color-text-003 mobile-search__submit', '[모바일 검색]-[검색 실행] 예제입니다.');
        submit.setAttribute('aria-label', '검색 실행 예제'); submit.appendChild(icon('search'));
        clearInput = button('', 'ui-button ui-button--text color-text-003 mobile-search__clear');
        clearInput.setAttribute('aria-label', '예제 검색어 지우기'); clearInput.appendChild(icon('cancel'));
        inputWrap.append(surface, submit, searchInput, clearInput);
        const photo = button('', 'ui-button color-theme shape-capsule mobile-search__photo', '[모바일 검색]-[사진 검색 진입] 예제입니다.');
        photo.setAttribute('aria-label', '사진 검색 진입 예제'); photo.appendChild(icon('photo_camera'));
        const back = button('', 'ui-button ui-button--text color-text-000 mobile-search__back', '[모바일 검색]-[검색 닫기] 예제입니다.');
        back.setAttribute('aria-label', '검색 닫기 예제'); back.appendChild(icon('arrow_back'));
        toolbar.append(inputWrap, photo, back); searchStage.append(toolbar, searchList);
    } else {
        const expanded = element('div');
        expanded.dataset.paletteSearchExpanded = '';
        const searchRow = element('div', 'search-row');
        const wrapper = element('div', 'search-input-wrapper dropdown-capsule active');
        const surface = element('div', 'search-expansion-bg dropdown-capsule__surface ui-search-surface color-surface-001 shadow-small shape-capsule border-basic');
        surface.appendChild(searchList);
        clearInput = button('', 'ui-button ui-button--text color-text-002 search-input-action clear-search-btn');
        clearInput.setAttribute('aria-label', '예제 검색어 지우기'); clearInput.appendChild(icon('cancel'));
        const photo = button('', 'ui-button ui-button--text color-text-002 search-input-action photo-search-icon-btn', '[데스크톱 검색]-[사진 검색 진입] 예제입니다.');
        photo.setAttribute('aria-label', '사진 검색 진입 예제'); photo.appendChild(icon('photo_camera'));
        wrapper.append(surface, searchInput, photo, clearInput);
        const submit = button('', 'ui-button color-theme shape-capsule', '[데스크톱 검색]-[검색 실행] 예제입니다.');
        submit.id = 'search-btn'; submit.setAttribute('aria-label', '검색 실행 예제'); submit.appendChild(icon('search'));
        searchRow.append(wrapper, submit); expanded.appendChild(searchRow); searchStage.appendChild(expanded);
        const measure = () => {
            if (!wrapper.isConnected) return;
            const height = Math.ceil(searchList.getBoundingClientRect().height);
            wrapper.style.setProperty('--dropdown-height', `${height}px`);
            // 절대 배치된 실제 추천 목록 아래에 뷰어의 전시 공간만 확보합니다.
            expanded.style.paddingBottom = `${height}px`;
        };
        const ResizeObserver = document.defaultView?.ResizeObserver;
        if (ResizeObserver) {
            const observer = new ResizeObserver(measure);
            observer.observe(searchList); removers.push(() => observer.disconnect());
        }
        measure();
        listen(searchInput, 'input', () => { photo.hidden = !!searchInput.value; });
    }
    const updateClear = () => {
        clearInput.hidden = !searchInput.value;
    };
    listen(searchInput, 'input', updateClear);
    listen(clearInput, 'click', () => { searchInput.value = ''; searchInput.dispatchEvent(new document.defaultView.Event('input', { bubbles: true })); searchInput.focus(); });
    listen(searchInput, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); announce('[검색]-[검색 실행] 원격 검색 없이 입력 외형만 확인하는 예제입니다.'); } });
    updateClear();

    const catalog = section('catalog', '[일반 검색 결과]-[결과 카드·필터 칩·페이지 이동]',
        '합성 검색 결과입니다. 카드 이동과 필터 편집기는 연결하지 않으며 내부 아이콘 대신 칩 전체의 강조를 확인할 수 있습니다.');
    const filters = element('div', 'catalog-search-filters');
    for (const text of ['검색 대상 : 전체', '종류 : 몬스터', '속성 : 빛, 어둠']) {
        const chip = element('div', 'catalog-search-chip ui-chip ui-chip--interactive color-tint-theme color-disabled shape-capsule');
        const edit = button('', 'catalog-search-chip__edit ui-control--disabled color-disabled', '[일반 검색 결과]-[필터 편집] 예제입니다.');
        edit.appendChild(element('span', 'catalog-search-chip__label', text));
        if (document.documentElement.classList.contains('is-mobile-device')) {
            edit.appendChild(icon('expand_more', 'catalog-search-chip__icon'));
            chip.appendChild(edit);
        } else {
            const remove = button('', 'catalog-search-chip__remove', '[일반 검색 결과]-[필터 제거] 예제입니다.');
            remove.setAttribute('aria-label', `${text} 필터 제거 예제`);
            remove.appendChild(icon('close', 'catalog-search-chip__icon'));
            chip.append(edit, remove);
        }
        filters.appendChild(chip);
    }
    catalog.appendChild(filters);
    const results = element('ul', 'catalog-search-list');
    for (const [name, number, kind, count] of [['예시 드래곤', 'DEMO-KR001', '몬스터', '4장'], ['긴 카드 이름이 표시되는 검색 결과 예제', 'DEMO-KR002', '마법', '0장']]) {
        const item = element('li');
        const link = fakeLink('', 'catalog-search-row ui-card--interactive color-type000 shape-rounded002', '[일반 검색 결과]-[단일 카드로 이동] 예제입니다.');
        const title = element('span', 'catalog-search-name');
        title.append(element('span', '', name), element('span', 'catalog-search-number color-text-002', number));
        const details = element('span', 'catalog-search-details');
        details.append(element('span', 'catalog-search-kind color-text-002', kind), element('span', 'catalog-search-quantity ui-chip color-tint-theme shape-capsule', count));
        link.append(title, details); item.appendChild(link); results.appendChild(item);
    }
    const pager = element('nav', 'catalog-search-pager');
    pager.setAttribute('aria-label', '검색 결과 페이지 예제');
    const previous = button('이전', 'ui-button color-type005 color-disabled shape-capsule ui-control--disabled');
    previous.disabled = true;
    pager.append(previous, element('span', 'catalog-search-page color-text-001', '1 / 3'), button('다음', 'ui-button color-type005 color-disabled shape-capsule ui-control--disabled', '[일반 검색 결과]-[다음 페이지] 예제입니다.'));
    catalog.append(results, pager);

    const cardStage = section('card-information', '[단일 카드 정보]-[이름·정보표·카드 텍스트]',
        '실제 표·칩·8px 표면 조합으로 만든 합성 데이터입니다. 뒤로가기와 일러스트 전환은 안내만 표시합니다.');
    const card = element('article', 'search-card color-surface-001 shape-rounded002');
    const name = element('div', 'search-card__name');
    const back = fakeLink('', 'search-results__back color-text-001', '[단일 카드 정보]-[뒤로 가기] 예제입니다.');
    back.setAttribute('aria-label', '검색 결과로 돌아가기 예제');
    back.innerHTML = '<svg class="search-results__back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span class="search-results__back-label">뒤로 가기</span>';
    const artButton = button('', 'search-art-toggle ui-button ui-button--text color-text-001', '[단일 카드 정보]-[일러스트 보기] 예제입니다.');
    artButton.setAttribute('aria-label', '카드 일러스트 보기 예제');
    artButton.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>';
    name.append(back, element('h2', 'search-card__title color-text-000', '예시 드래곤'), artButton);
    const info = element('div', 'search-card__info border-basic shape-rounded002');
    const table = element('table', 'search-card__table search-card__table--monster');
    table.setAttribute('aria-label', '합성 카드 정보');
    const tbody = element('tbody');
    [['속성', '빛', '종족', '드래곤족', '레벨', '8'], ['공격력', '3000', '수비력', '2500', '펜듈럼 스케일', '-']].forEach((values, r) => {
        const tr = element('tr');
        for (let c = 0; c < values.length; c += 2) {
            const th = element('th', 'search-card__label color-surface-002 color-text-000 border-basic');
            th.id = `${prefix}-card-${r}-${c}`;
            if (values[c] === '펜듈럼 스케일') th.append(element('span', 'search-card__label-desktop', values[c]), element('span', 'search-card__label-mobile', '펜듈럼'));
            else th.textContent = values[c];
            const td = element('td', 'search-card__value color-surface-001 color-text-001 border-basic', values[c + 1]);
            td.setAttribute('headers', th.id); tr.append(th, td);
        }
        tbody.appendChild(tr);
    });
    const classification = element('tr');
    const classificationCell = element('td', 'search-card__classifications color-surface-001 color-text-001 border-basic');
    classificationCell.colSpan = 6;
    const chips = element('div', 'ui-chip-list');
    for (const label of ['융합', '효과']) {
        chips.appendChild(element('span', 'ui-chip ui-chip--compact color-tint-theme shape-capsule', label));
    }
    classificationCell.append(element('span', 'visually-hidden', '분류'), chips);
    classification.appendChild(classificationCell); tbody.appendChild(classification);
    table.appendChild(tbody); info.appendChild(table);
    const text = element('div', 'search-card__text color-surface-000 color-text-000 shape-rounded002');
    const textSection = element('section', 'search-card__text-section');
    textSection.append(element('h3', 'search-card__text-heading', '[카드 텍스트]'), element('p', 'search-card__text-body', '이 문장은 카드 효과의 행간과 줄바꿈을 확인하기 위한 합성 문구입니다.\n카드 이름과 수량, 긴 설명이 함께 표시되는 정보 위계를 비교합니다.'));
    text.appendChild(textSection); card.append(name, info, text); cardStage.appendChild(card);

    const artworkStage = section('illustration', '[단일 카드 정보]-[일러스트 본문·선택 썸네일]',
        '실제 카드 사진 대신 현재 토큰으로 그린 간단한 SVG 도형을 사용합니다. 썸네일은 실제64px·8px 규격이며 기본 투명도50%, 실제 호버·키보드 포커스70%, 선택100%입니다. 선택·이전·다음은 로컬 예제만 바꾸며 발매 지역 팝업은 포함하지 않습니다.');
    const gallery = element('div', 'search-art-gallery');
    const picture = element('div', 'search-art-picture');
    const artCaption = element('div', 'search-art-caption');
    const movementClasses = 'ui-button color-type001 color-disabled ui-control--disabled shape-capsule';
    const previousArt = button('❮', `search-art-prev ${movementClasses}`);
    const nextArt = button('❯', `search-art-next ${movementClasses}`);
    previousArt.setAttribute('aria-label', '이전 도형 일러스트 예제'); nextArt.setAttribute('aria-label', '다음 도형 일러스트 예제');
    const artMeta = element('div', 'search-art-caption-meta');
    const artLabel = element('span', 'search-art-caption-label');
    artMeta.appendChild(artLabel); artCaption.append(previousArt, artMeta, nextArt);
    const stripRow = element('div', 'search-art-strip-row');
    const previousThumb = button('❮', `search-art-strip-prev ${movementClasses}`);
    const nextThumb = button('❯', `search-art-strip-next ${movementClasses}`);
    previousThumb.setAttribute('aria-label', '이전 도형 썸네일'); nextThumb.setAttribute('aria-label', '다음 도형 썸네일');
    const thumbs = element('div', 'search-art-thumbs');
    thumbs.setAttribute('role', 'group'); thumbs.setAttribute('aria-label', '도형 일러스트 선택');
    stripRow.append(previousThumb, thumbs, nextThumb); gallery.append(picture, artCaption, stripRow); artworkStage.appendChild(gallery);
    const tokenStyle = document.defaultView.getComputedStyle(document.documentElement);
    const token = name => tokenStyle.getPropertyValue(name).trim();
    const artUrls = [
        '<circle cx="120" cy="120" r="70"/>',
        '<path d="M120 35 205 195H35Z"/>',
        '<rect x="55" y="55" width="130" height="130" rx="20"/>',
        '<path d="m120 30 90 90-90 90-90-90Z"/>'
    ].map(shape => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="${token('--surface-002')}"/><g fill="${token('--theme-000')}">${shape}</g></svg>`)}`);
    const artThumbs = [];
    let selectedArt = 0;
    const selectArt = index => {
        selectedArt = (index + artUrls.length) % artUrls.length;
        const image = element('img', 'shape-rounded002');
        image.src = artUrls[selectedArt]; image.alt = `도형 일러스트 예제 ${selectedArt + 1}`;
        picture.replaceChildren(image);
        artLabel.textContent = String(selectedArt + 1);
        artThumbs.forEach((thumb, n) => thumb.setAttribute('aria-pressed', String(n === selectedArt)));
    };
    artUrls.forEach((url, index) => {
        const thumb = button('', 'search-art-thumb shape-rounded002 color-text-001');
        thumb.setAttribute('aria-label', `도형 일러스트 예제 ${index + 1} 선택`);
        const image = element('img'); image.src = url; image.alt = `도형 ${index + 1}`;
        thumb.appendChild(image); listen(thumb, 'click', () => selectArt(index)); artThumbs.push(thumb); thumbs.appendChild(thumb);
    });
    listen(previousArt, 'click', () => selectArt(selectedArt - 1)); listen(previousThumb, 'click', () => selectArt(selectedArt - 1));
    listen(nextArt, 'click', () => selectArt(selectedArt + 1)); listen(nextThumb, 'click', () => selectArt(selectedArt + 1));
    selectArt(0);

    const ownedStage = section('owned', '[단일 카드 정보]-[보유 요약·상세]',
        'OwnedCards.render가 합성 행을 직접 그립니다. 위치·레어도 줄바꿈과 이웃 카드의 접합을 확인합니다. 실제 사진을 사용하지 않으며 이미지는 ‘이미지 없음’으로 표시합니다. 첫 카드는 펼친 상태로 시작합니다.');
    const owned = element('section', 'target-inventory-section');
    owned.setAttribute('aria-label', '합성 보유 정보');
    ownedStage.appendChild(owned);
    if (ownedCards?.render) {
        ownedCards.render([
            ['예시 드래곤', 'DEMO-KR001', 'SE', 2, '바인더 A', '기본', 'demo-1'],
            ['예시 드래곤', 'DEMO-KR001', 'LONG', 1, '바인더 A', '기본', 'demo-1'],
            ['예시 드래곤', 'DEMO-KR001', 'UR', 1, '긴 보관 위치 이름과 여러 칩의 줄바꿈을 확인하는 수납장', '2', 'demo-1'],
            ['두 번째 예시 카드', 'DEMO-KR002', 'UR', 3, '덱 박스', '기본', 'demo-2'],
            ['세 번째 예시 카드', 'DEMO-KR003', 'SE', 1, '', '기본', 'demo-3']
        ], owned, {
            contextKey: `${prefix}-owned`,
            describeRarity: key => ({ label: { SE: '시크릿 레어', UR: '울트라 레어', LONG: '쿼터 센츄리 시크릿 레어' }[key] || key }),
            loadIllustration: async () => ({ status: 'missing' })
        });
        ownedContainers.push(owned);
        owned.querySelector('.owned-card__toggle')?.click();
    } else owned.appendChild(element('p', 'color-text-002', 'OwnedCards 렌더러를 불러오지 못했습니다.'));

    const accountStage = section('account', '[환경설정]-[계정 카드·닉네임 편집]',
        '일반 계정과 프리미엄 편집 상태의 합성 예제입니다. 닉네임 확인·취소는 이 문서 안에서만 동작하며 계정·서버·저장소를 변경하지 않습니다.');
    const account = (membership, editing) => {
        const root = element('section', `account-card color-surface-001 shape-rounded-lg${membership === '프리미엄' ? ' border-theme' : ''}`);
        root.setAttribute('aria-label', `${membership} 계정 합성 예제`);
        const avatar = element('div', 'user-avatar-area shape-capsule color-surface-002 color-text-theme');
        avatar.setAttribute('aria-hidden', 'true'); avatar.appendChild(icon('person'));
        const details = element('div', 'account-card__details');
        const display = element('div', 'account-card__nickname-row');
        const edit = button('', 'ui-button color-type001 shape-capsule account-card__icon-button account-card__icon-button--edit');
        edit.setAttribute('aria-label', '닉네임 수정 예제'); edit.appendChild(icon('edit'));
        const nickname = element('span', 'account-card__nickname', '팔레트 예제');
        display.append(edit, nickname);
        const form = element('form', 'account-card__nickname-row');
        const cancel = button('', 'ui-button color-type001 shape-capsule account-card__icon-button');
        cancel.setAttribute('aria-label', '닉네임 수정 취소'); cancel.appendChild(icon('close'));
        const confirm = button('', 'ui-button color-type001 shape-capsule account-card__icon-button');
        confirm.type = 'submit'; confirm.setAttribute('aria-label', '닉네임 수정 확인'); confirm.appendChild(icon('check'));
        const input = element('input', 'ui-input--filled color-type001 shape-capsule border-theme account-card__nickname-input');
        input.type = 'text'; input.value = nickname.textContent; input.setAttribute('aria-label', '예제 닉네임');
        form.append(cancel, confirm, input);
        const setEditing = value => { display.hidden = value; form.hidden = !value; };
        setEditing(editing);
        listen(edit, 'click', () => { input.value = nickname.textContent; setEditing(true); input.focus(); });
        listen(cancel, 'click', () => { setEditing(false); edit.focus(); });
        listen(form, 'submit', event => { event.preventDefault(); nickname.textContent = input.value.trim() || '팔레트 예제'; setEditing(false); edit.focus(); announce('[환경설정]-[닉네임] 예제 표시만 변경했습니다.'); });
        listen(input, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); setEditing(false); edit.focus(); } });
        const actions = element('div', 'account-card__actions');
        actions.append(button('멤버십 확인', 'ui-button color-type001 shape-capsule account-card__action-button', '[환경설정]-[멤버십 확인] 예제입니다.'), button('로그아웃', 'ui-button color-type001 shape-capsule account-card__action-button', '[환경설정]-[로그아웃] 예제입니다.'));
        details.append(display, form, element('p', 'account-card__joined color-text-001', '가입일: 2026-01-01 (합성)'), element('p', 'account-card__membership color-text-001', membership), actions);
        root.append(avatar, details);
        return root;
    };
    accountStage.append(account('일반', false), account('프리미엄', true));

    const stats = section('statistics', '[홈·보유 현황]-[수량·종류 요약]',
        'ui-stat의 실제21px 패딩과 글꼴 선언을 사용합니다. Outfit의 별도 로딩은 확인 과제이며 수치는 합성 데이터입니다. 로딩 링은 대시보드 전용 색상 조합입니다.');
    const grid = element('dl', 'ui-stat-grid');
    for (const [label, value] of [['보유 카드', '128'], ['카드 종류', '42']]) {
        const stat = element('div', 'ui-stat color-surface-001 shape-rounded-lg');
        stat.append(element('dt', 'ui-stat__label color-text-001', label), element('dd', 'ui-stat__value color-text-theme', value));
        grid.appendChild(stat);
    }
    const loading = element('div', 'loading-spinner-small color-theme-002');
    loading.setAttribute('role', 'img'); loading.setAttribute('aria-label', '대시보드 로딩 링 색상 예제');
    stats.append(grid, caption('[보유 현황]-[대시보드] 로딩 링과 더보기 버튼의 실제 조합'), loading);
    const more = button('', 'stat-more-btn ui-button color-theme-001', '[보유 현황]-[더보기] 예제입니다.');
    more.append(element('span', '', '더보기'), icon('expand_more'));
    stats.appendChild(more);

    const header = section('header', '[전역 헤더]-[로그인·공지·멤버십·지역 선택·테마 스위치]',
        '고정 헤더를 만들지 않고 실제 버튼만 비교합니다. 스위치는 이 예제의 체크 상태만 바꾸며 문서 테마·저장 설정은 변경하지 않습니다.');
    const headerRow = row();
    for (const [label, glyph, color, border] of [['로그인', 'account_circle', 'color-type000', ''], ['공지사항', 'notifications_none', 'color-type000', ''], ['멤버십 인증', 'workspace_premium', 'color-type002', 'border-theme']]) {
        const notice = label === '공지사항';
        const control = button('', `ui-button ${color} ${border} shadow-small app-header-button shape-capsule ${notice ? 'noti-btn-capsule' : 'auth-capsule'}`.replaceAll('  ', ' '), `[전역 헤더]-[${label}] 예제입니다.`);
        control.setAttribute('aria-label', `${label} 예제`);
        // 로그인 버튼의 모바일 아이콘 숨김·패딩 선택자는 실제 ID에 연결되어 있습니다.
        if (label === '로그인') control.id = 'auth-capsule-btn';
        control.appendChild(icon(glyph, notice ? '' : 'auth-icon color-text-theme'));
        if (!notice) control.appendChild(element('span', 'auth-text', label));
        headerRow.appendChild(control);
    }
    const region = button('', 'ui-button region-capsule color-type004 shape-capsule', '[전역 헤더]-[지역 선택 열기] 예제입니다.');
    region.setAttribute('aria-label', '언어 선택 예제: 한국');
    region.append(icon('public', 'region-icon color-text-002'), element('span', 'region-text', '한국'));
    headerRow.appendChild(region);
    const switchWrapper = element('div', 'theme-switch-wrapper color-text-002');
    const switchLabel = element('label', 'theme-switch');
    const switchInput = element('input'); switchInput.type = 'checkbox'; switchInput.id = `${prefix}-switch`;
    switchInput.setAttribute('aria-label', '로컬 테마 스위치 상태 예제'); switchLabel.htmlFor = switchInput.id;
    switchLabel.append(switchInput, element('div', 'theme-switch__track color-switch-theme'));
    switchWrapper.appendChild(switchLabel); headerRow.appendChild(switchWrapper); header.appendChild(headerRow);

    const navigation = section('navigation', '[데스크톱 사이드바]-[메뉴 버튼]',
        '고정 사이드바 없이 실제 메뉴 버튼의 기본·선택·호버·키보드 상태를 비교합니다. 선택은 이 예제 안에서만 바뀝니다.');
    const navigationRow = row();
    const navigationButtons = [];
    for (const [index, label] of ['홈', '카드 관리', '보유 현황'].entries()) {
        const item = button('', `ui-button app-navi-item color-navi app-navi-item--sidebar${index === 0 ? ' active' : ''}`);
        item.append(icon(['home', 'layers', 'list_alt'][index], 'app-navi-item__icon'), element('span', 'app-navi-item__label', label));
        item.setAttribute('aria-pressed', String(index === 0));
        listen(item, 'click', () => navigationButtons.forEach(candidate => { candidate.classList.toggle('active', candidate === item); candidate.setAttribute('aria-pressed', String(candidate === item)); }));
        navigationButtons.push(item); navigationRow.appendChild(item);
    }
    navigation.appendChild(navigationRow);

    const mobileNavigation = section('mobile-navigation', '[모바일 내비게이션]-[메뉴 버튼]',
        '고정 하단 배치·광고를 제외한 실제 내비게이션 바입니다. 기본 선택 면은 투명하며 호버·키보드 포커스만 강조합니다. 선택은 예제 안에서만 바뀝니다.');
    const mobileBar = element('nav', 'app-navi--mobile shadow-none');
    mobileBar.setAttribute('aria-label', '모바일 내비게이션 예제');
    const mobileButtons = [];
    for (const [index, label] of ['홈', '검색', '관리', '현황', '설정'].entries()) {
        const item = button('', `ui-button app-navi-item color-navi app-navi-item--mobile${index === 0 ? ' active' : ''}`);
        item.setAttribute('aria-label', label);
        item.setAttribute('aria-pressed', String(index === 0));
        item.append(icon(['home', 'search', 'layers', 'list_alt', 'settings'][index], 'app-navi-item__icon'), element('span', 'app-navi-item__label', label));
        listen(item, 'click', () => mobileButtons.forEach(candidate => { candidate.classList.toggle('active', candidate === item); candidate.setAttribute('aria-pressed', String(candidate === item)); }));
        mobileButtons.push(item); mobileBar.appendChild(item);
    }
    mobileNavigation.appendChild(mobileBar);

    const footerStage = section('footer', '[전역 푸터]-[제작자·법적 링크·구분자]',
        '제작자 링크는 빨간 글자·아이콘, 법적 링크는 테마 글자색으로 강조합니다. 실제 링크 이동은 실행하지 않습니다.');
    const footer = element('div', 'app-footer color-text-003');
    const footerInfo = element('div', 'app-footer__info');
    const maker = fakeLink('', 'maker-link ui-button ui-button--text color-text-003 color-highlight-youtube', '[전역 푸터]-[참혈 유튜브 링크] 예제입니다.');
    const youtube = element('i', 'fa-brands fa-youtube'); youtube.setAttribute('aria-hidden', 'true');
    maker.append(youtube, element('span', 'maker-text', '참혈'));
    const creator = element('span', 'app-footer__item', 'Made by '); creator.appendChild(maker);
    footerInfo.append(element('span', 'app-footer__item', '예제 버전'), element('span', 'app-footer__separator', '|'), creator, element('span', 'app-footer__separator', '|'), element('span', 'app-footer__item', '© 2026 YGO Synapse.'));
    const legal = element('div', 'app-footer__links');
    ['이용약관', '개인정보 처리방침', '라이선스 및 출처'].forEach((label, index) => {
        if (index) legal.appendChild(element('span', 'app-footer__link-separator', '•'));
        legal.appendChild(fakeLink(label, 'app-footer__link shape-rounded001 ui-button ui-button--text color-text-003 color-highlight-theme', `[전역 푸터]-[${label}] 예제입니다.`));
    });
    footer.append(footerInfo, legal); footerStage.appendChild(footer);
    container.appendChild(status);

    const dispose = () => {
        ownedContainers.forEach(node => ownedCards?.dispose(node));
        removers.forEach(remove => remove());
        if (cleanups.get(container) === dispose) cleanups.delete(container);
    };
    cleanups.set(container, dispose);
    return dispose;
}
