// Shared matching for the dropdown and the complete catalog results.
const catalogNumberIndexes = new WeakMap();

function collectCatalogMatches(value) {
    const query = normalizeStr(value);
    if (!query) return [];
    const consonantsOnly = /^[ㄱ-ㅎ]+$/.test(query);
    const ownedNames = cardCacheInstance.getOwnedNamesSet();
    const ownedNumbers = cardCacheInstance.getOwnedNumbersSet();
    const names = CardDataStore.allCardNamesNormalized.length
        ? CardDataStore.allCardNamesNormalized : cardCacheInstance.getAllNamesNormalized();
    const matches = [];
    for (const item of names) {
        const matched = item.normalized.includes(query) || (consonantsOnly
            ? item.chosung.includes(query)
            : typeof Hangul !== 'undefined' && typeof Hangul.search === 'function' && Hangul.search(item.normalized, query) !== -1);
        if (matched) matches.push({ type: 'name', val: item.original,
            normalized: item.normalized, isOwned: ownedNames.has(item.original) });
    }
    if (query.length >= 6) {
        const source = CardDataStore.allCardNumbers.length
            ? CardDataStore.allCardNumbers : cardCacheInstance.getOwnedNumbers();
        let numbers = catalogNumberIndexes.get(source);
        if (!numbers) {
            numbers = source.map(value => ({ val: String(value), normalized: String(value).toLowerCase() }));
            catalogNumberIndexes.set(source, numbers);
        }
        for (const item of numbers) {
            if (item.normalized.includes(query)) matches.push({ ...item, type: 'number', isOwned: ownedNumbers.has(item.val) });
        }
    }
    // Preserve the existing dropdown priority, without repeating Hangul.search in sort.
    for (const item of matches) {
        item.exact = item.normalized === query;
        item.preferred = item.type === 'name' || item.normalized.startsWith(query);
    }
    return matches.sort((a, b) => Number(b.isOwned) - Number(a.isOwned)
        || Number(b.exact) - Number(a.exact)
        || Number(b.preferred) - Number(a.preferred)
        || a.val.length - b.val.length || a.val.localeCompare(b.val));
}

function groupCatalogResults(matches, links) {
    const cards = new Map();
    for (const match of matches) {
        const key = `${match.type}:${match.val}`;
        const resolved = links.get(key);
        for (const linked of resolved?.length ? resolved : [{ cid: null, name: match.type === 'name' ? match.val : getCardNameByNumber(match.val) }]) {
            const cid = linked.cid ? String(linked.cid) : null;
            const cardKey = cid || key;
            if (!cards.has(cardKey)) cards.set(cardKey, { cid, name: linked.name || '',
                nameMatch: false, numberMatch: false, number: null });
            const card = cards.get(cardKey);
            if (match.type === 'name') {
                if (!card.nameMatch) card.name = match.val;
                card.nameMatch = true;
            } else {
                card.numberMatch = true;
                if (!card.number) card.number = match.val;
            }
        }
    }
    return [...cards.values()];
}

const catalogResolvedLinks = new Map();
// 완료 응답의 생략 필드(값 없음)와 아직 보충하지 않은 캐시의 생략 필드를 구분한다.
const catalogCompleteMetadata = new WeakSet();
function rememberCatalogLinks(item, cards) {
    for (const card of cards) ClientCache.registerCid(card.cid,
        item.type === 'name' ? [item.val] : (card.name ? [card.name] : []),
        item.type === 'number' ? [item.val] : []);
}

async function completeCatalogMetadata(links, sequence) {
    const cids = [...new Set([...links.values()].flat().filter(card => card.cid).map(card => String(card.cid)))];
    const missing = cids.filter(cid => {
        const meta = cidMetaMemoryCache.get(cid);
        return !meta || (!meta.isFull && !catalogCompleteMetadata.has(meta))
            || !CatalogFilters.normalize(meta) || Date.now() - (meta.cachedAt || 0) >= 60000;
    });
    if (missing.length && sequence === searchSequence) {
        const received = await fetchCardsMetaBatch(missing, { force: true });
        if (sequence !== searchSequence) return;
        let failed = false;
        for (const cid of missing) {
            const meta = cidMetaMemoryCache.get(cid);
            if (meta && received?.[cid] === meta && CatalogFilters.normalize(meta)) catalogCompleteMetadata.add(meta);
            else failed = true;
        }
        if (failed) throw new Error('일부 카드의 세부 정보를 불러오지 못했습니다.');
    }
}

async function resolveCatalogMatches(matches, sequence, onProgress = () => {}) {
    const links = new Map();
    const missing = [];
    let failure = null;
    for (const item of matches) {
        const key = `${item.type}:${item.val}`;
        const cached = catalogResolvedLinks.get(key);
        if (cached && cached.expires > Date.now()) {
            links.set(key, cached.cards);
            rememberCatalogLinks(item, cached.cards);
            continue;
        }
        const cid = findCidByNameOrNo(item.type === 'name' ? item.val : '', item.type === 'number' ? item.val : null);
        if (cid) {
            const meta = cidMetaMemoryCache.get(String(cid));
            links.set(key, [{ cid, name: item.type === 'name' ? item.val : (meta?.name || getCardNameByNumber(item.val)) }]);
            if (meta && Object.hasOwn(meta.info || meta.rawSlot || {}, '10') && Date.now() - (meta.cachedAt || 0) < 60000) continue;
        }
        missing.push(item);
    }
    onProgress(groupCatalogResults(matches, links));
    for (let offset = 0; offset < missing.length; offset += 40) {
        if (sequence !== searchSequence) return null;
        const chunk = missing.slice(offset, offset + 40);
        try {
        const res = await callApi('resolveCardNames', {}, {
            names: chunk.filter(item => item.type === 'name').map(item => item.val),
            numbers: chunk.filter(item => item.type === 'number').map(item => item.val)
        });
        if (sequence !== searchSequence) return null;
        if (!res.success || (chunk.some(item => item.type === 'number') && !res.numberResults)) {
            throw new Error('검색 결과를 불러오지 못했습니다. 다시 시도해 주세요.');
        }
        for (const [cid, info] of Object.entries(res.metadata || {})) {
            mergeCardMetaToCache(cid, { rawSlot: info }, false);
            const complete = cidMetaMemoryCache.get(String(cid));
            if (complete && CatalogFilters.normalize(complete)) catalogCompleteMetadata.add(complete);
        }
        for (const item of chunk) {
            const cards = item.type === 'name'
                ? (res.results?.[item.val] || []).map(cid => ({ cid, name: item.val }))
                : (res.numberResults[item.val] || []);
            const key = `${item.type}:${item.val}`;
            links.set(key, cards);
            rememberCatalogLinks(item, cards);
            catalogResolvedLinks.set(key, { cards, expires: Date.now() + 60000 });
        }
        while (catalogResolvedLinks.size > 5000) catalogResolvedLinks.delete(catalogResolvedLinks.keys().next().value);
        onProgress(groupCatalogResults(matches, links));
        await completeCatalogMetadata(links, sequence);
        if (sequence !== searchSequence) return null;
        onProgress(groupCatalogResults(matches, links));
        } catch (error) {
            if (sequence !== searchSequence) return null;
            failure ||= error;
            onProgress(groupCatalogResults(matches, links));
        }
    }
    if (!missing.length) {
        await completeCatalogMetadata(links, sequence);
        if (sequence !== searchSequence) return null;
        onProgress(groupCatalogResults(matches, links));
    }
    if (failure) throw failure;
    return groupCatalogResults(matches, links);
}

function getCatalogQuantityIndexes(items) {
    const quantities = new Map(), nameQuantities = new Map(), numberQuantities = new Map();
    const nameCids = new Map(), numberCids = new Map();
    for (const card of items) if (card.cid) {
        if (card.name) nameCids.set(normalizeStr(card.name), String(card.cid));
        if (card.number) numberCids.set(normalizeStr(card.number), String(card.cid));
    }
    for (const row of cardCacheInstance.getInventory()) {
        const qty = parseInt(row[3]) || 0;
        const name = normalizeStr(row[0]), number = normalizeStr(row[1]);
        nameQuantities.set(name, (nameQuantities.get(name) || 0) + qty);
        numberQuantities.set(number, (numberQuantities.get(number) || 0) + qty);
        const cid = row[6] || findCidByNameOrNo(row[0], row[1]) || numberCids.get(number) || nameCids.get(name);
        if (cid) quantities.set(String(cid), (quantities.get(String(cid)) || 0) + qty);
    }
    return { quantities, nameQuantities, numberQuantities };
}

// DOM and normalized cache entries stay outside serializable navigation state.
const catalogViews = new WeakMap();
const catalogMetadata = new WeakMap();
let catalogPageSize = 20;
let catalogViewSequence = 0;
let catalogFilterEditor = null;

function getCatalogNormalizedMeta(card) {
    const meta = card.cid && cidMetaMemoryCache.get(String(card.cid));
    if (!meta) return null;
    const info = meta.info || meta.rawSlot;
    const complete = !!meta.isFull || catalogCompleteMetadata.has(meta);
    const signature = JSON.stringify([complete, info?.[10], info?.[11], info?.[12], info?.[13], info?.[14], info?.[15], info?.[16], info?.[17],
        info?.card_type, info?.properties, info?.lv, info?.attribute, info?.race, info?.atk, info?.def, info?.pendulum_scale]);
    const saved = catalogMetadata.get(meta);
    if (saved?.signature === signature) return saved.value;
    const value = CatalogFilters.normalize(meta, { complete });
    catalogMetadata.set(meta, { signature, value });
    return value;
}

function ensureCatalogFilterState(state) {
    state.filters ||= CatalogFilters.create(state.filter);
    state.addedFilters ||= ['target'];
    state.pageSize ||= catalogPageSize;
    state.page ||= 1;
}

async function loadCatalogSearchState(state, sequence) {
    const isCurrent = () => sequence === searchSequence && lastSearchState === state && UIStore.mode === 'search';
    state.pending = true;
    state.error = '';
    try {
        await resolveCatalogMatches(collectCatalogMatches(state.query), sequence, items => {
            if (!isCurrent()) return;
            state.items = items;
            renderCatalogResults(state);
        });
    } catch (error) {
        if (isCurrent()) state.error = '일부 카드 정보를 확인하지 못했습니다.';
    } finally {
        if (isCurrent()) {
            state.pending = false;
            renderCatalogResults(state);
        }
    }
}

async function showCatalogSearch(query, filter, sequence, isInstant) {
    closeCatalogFilterEditor();
    const state = { type: 'broad', items: groupCatalogResults(collectCatalogMatches(query), new Map()), query,
        filter: ['name', 'number'].includes(filter) ? filter : 'auto', filters: CatalogFilters.create(filter),
        addedFilters: ['target'], page: 1, pageSize: catalogPageSize, pending: true };
    lastSearchState = state;
    if (typeof SearchNavigation !== 'undefined') {
        SearchNavigation.showCatalog(state, mount => renderCatalogResults(state, mount), { instant: isInstant });
    } else if (UIStore.mode !== 'search') switchToMode('search', isInstant);
    await loadCatalogSearchState(state, sequence);
    void refreshPublicDataQuietly();
}

function resumeCatalogSearch(state, sequence) {
    if (state.pending || state.error || state.items.some(card => !card.cid || !getCatalogNormalizedMeta(card))) {
        return loadCatalogSearchState(state, sequence);
    }
    return Promise.resolve();
}

function commitCatalogState(state) {
    const targets = state.filters.target;
    state.filter = targets.length === 1 ? targets[0] : 'auto';
    if (typeof SearchNavigation !== 'undefined') SearchNavigation.updateCatalog(state);
    else updateSearchHash('broad', { searchType: state.filter, key: state.query });
    renderCatalogResults(state);
}

function applyCatalogFilter(state, key, value, { add = true } = {}) {
    if (state.pending) return '카드 정보를 확인한 뒤 필터를 적용해 주세요.';
    const validated = CatalogFilters.validate(key, value);
    if (validated.error) return validated.error;
    state.filters[key] = validated.value;
    if (add && !state.addedFilters.includes(key)) state.addedFilters.push(key);
    state.page = 1;
    commitCatalogState(state);
    return null;
}

function catalogButton(label, className, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.onclick = action;
    return button;
}

const catalogFilledButton = 'ui-button color-type001 color-disabled shape-capsule ui-control--disabled';
const catalogTextButton = 'ui-button ui-button--text color-text-001 shape-capsule';

function buildCatalogView(state, mount) {
    const root = document.createElement('section');
    root.setAttribute('aria-label', '검색 결과');
    const heading = document.createElement('h2');
    heading.className = 'visually-hidden';
    heading.textContent = '검색 결과';
    root.appendChild(heading);
    const toolbar = document.createElement('div');
    toolbar.className = 'catalog-search-toolbar';
    const total = document.createElement('p');
    total.className = 'catalog-search-total color-text-001';
    toolbar.appendChild(total);
    const divider = document.createElement('span');
    divider.className = 'catalog-search-divider';
    divider.setAttribute('aria-hidden', 'true');
    toolbar.appendChild(divider);
    const filterArea = document.createElement('div');
    filterArea.className = 'catalog-search-filter-area';
    const chips = document.createElement('div');
    chips.className = 'catalog-search-filters';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', '검색 결과 필터');
    filterArea.appendChild(chips);
    toolbar.appendChild(filterArea);
    const size = document.createElement('div');
    size.className = 'region-container dropdown-capsule catalog-search-size';
    const surface = document.createElement('div');
    surface.className = 'region-expansion-bg dropdown-capsule__surface color-surface-001 shape-capsule border-basic';
    const options = document.createElement('ul');
    const viewId = ++catalogViewSequence;
    options.id = `catalog-page-size-options-${viewId}`;
    options.className = 'region-dropdown-list';
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', '페이지당 표시 수량');
    options.onkeydown = event => handleRegionOptionKeydown(event, size);
    const sizeOptions = new Map();
    for (const count of [20, 50, 100]) {
        const option = document.createElement('li');
        option.className = 'color-type004';
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        option.textContent = `${count}개씩 보기`;
        option.onclick = () => {
            closeDropdowns();
            state.pageSize = count; catalogPageSize = count; state.page = 1;
            commitCatalogState(state);
            sizeButton.focus({ preventScroll: true });
        };
        options.appendChild(option);
        sizeOptions.set(count, option);
    }
    surface.appendChild(options);
    size.appendChild(surface);
    const sizeButton = catalogButton('', 'ui-button region-capsule color-type004 shape-capsule', event => toggleRegionDropdown(event, size));
    sizeButton.id = `catalog-page-size-button-${viewId}`;
    sizeButton.setAttribute('aria-haspopup', 'listbox');
    sizeButton.setAttribute('aria-controls', options.id);
    sizeButton.setAttribute('aria-expanded', 'false');
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'region-text';
    const sizeIcon = document.createElement('i');
    sizeIcon.className = 'material-icons region-icon color-text-002';
    sizeIcon.setAttribute('aria-hidden', 'true');
    sizeIcon.textContent = 'expand_more';
    sizeButton.append(sizeLabel, sizeIcon);
    sizeButton.onkeydown = event => handleRegionButtonKeydown(event, size);
    size.appendChild(sizeButton);
    toolbar.appendChild(size);
    const mobileChips = document.createElement('div');
    mobileChips.className = 'catalog-search-filters catalog-search-filters--mobile';
    mobileChips.setAttribute('role', 'group');
    mobileChips.setAttribute('aria-label', '검색 결과 필터');
    filterArea.appendChild(mobileChips);
    const loading = document.createElement('p');
    loading.className = 'catalog-search-loading color-text-002';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    loading.hidden = true;
    filterArea.appendChild(loading);
    root.appendChild(toolbar);
    const status = document.createElement('p');
    status.className = 'catalog-search-progress color-text-002';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);
    const list = document.createElement('ul');
    list.className = 'catalog-search-list';
    list.setAttribute('aria-label', '검색된 카드');
    root.appendChild(list);
    const empty = document.createElement('p');
    empty.className = 'catalog-search-empty color-text-002';
    root.appendChild(empty);
    const pager = document.createElement('nav');
    pager.className = 'catalog-search-pager';
    pager.setAttribute('aria-label', '검색 결과 페이지');
    const changePage = delta => {
        state.page += delta;
        commitCatalogState(state);
    };
    const previous = catalogButton('이전', 'ui-button color-type005 color-disabled shape-capsule ui-control--disabled', () => changePage(-1));
    const pageLabel = document.createElement('span');
    pageLabel.className = 'catalog-search-page color-text-001';
    pageLabel.setAttribute('aria-current', 'page');
    const next = catalogButton('다음', 'ui-button color-type005 color-disabled shape-capsule ui-control--disabled', () => changePage(1));
    pager.append(previous, pageLabel, next);
    root.appendChild(pager);
    mount.replaceChildren(root);
    const add = catalogButton('', 'catalog-search-add ui-button color-tint-theme color-disabled shape-capsule ui-control--disabled', event => openCatalogFilterEditor(state, 'add', event.currentTarget));
    const addIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    addIcon.setAttribute('class', 'catalog-search-chip__icon');
    addIcon.setAttribute('viewBox', '0 0 24 24');
    addIcon.setAttribute('fill', 'currentColor');
    addIcon.setAttribute('focusable', 'false');
    const addPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    addPath.setAttribute('d', 'M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z');
    addIcon.appendChild(addPath);
    addIcon.setAttribute('aria-hidden', 'true');
    add.appendChild(addIcon);
    add.setAttribute('aria-label', '검색 필터 추가');
    add.setAttribute('aria-haspopup', 'dialog');
    add.setAttribute('aria-expanded', 'false');
    add.setAttribute('aria-controls', 'catalog-filter-editor');
    chips.appendChild(add);
    const view = { root, mount, toolbar, total, filterArea, chips, mobileChips, loading, add, status, list, empty, pager, previous, next, pageLabel,
        sizeButton, sizeLabel, sizeOptions, chipNodes: new Map(), mobileChipNodes: new Map(), rows: new Map() };
    catalogViews.set(state, view);
    return view;
}

function catalogFilterChip(state, key, mobile) {
    const wrapper = document.createElement('div');
    wrapper.dataset.filterKey = key;
    wrapper.className = 'catalog-search-chip ui-chip ui-chip--interactive color-tint-theme color-disabled shape-capsule';
    const edit = catalogButton('', 'catalog-search-chip__edit ui-control--disabled color-disabled', event => openCatalogFilterEditor(state, key, event.currentTarget));
    edit.setAttribute('aria-haspopup', 'dialog');
    edit.setAttribute('aria-controls', 'catalog-filter-editor');
    edit.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'catalog-search-chip__label';
    edit.appendChild(label);
    edit.onfocus = () => { if (mobile) wrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    wrapper.appendChild(edit);
    if (mobile) {
        const chevron = document.createElement('i');
        chevron.className = 'material-icons catalog-search-chip__icon';
        chevron.textContent = 'expand_more';
        chevron.setAttribute('aria-hidden', 'true');
        edit.appendChild(chevron);
    } else {
        const remove = catalogButton('', 'catalog-search-chip__remove', () => {
            if (state.pending) return;
            state.filters[key] = CatalogFilters.emptyValue(key);
            if (key !== 'target') state.addedFilters = state.addedFilters.filter(item => item !== key);
            state.page = 1;
            commitCatalogState(state);
            (key === 'target' ? edit : catalogViews.get(state)?.add)?.focus({ preventScroll: true });
        });
        const removeIcon = document.createElement('i');
        removeIcon.className = 'material-icons catalog-search-chip__icon';
        removeIcon.textContent = 'close';
        removeIcon.setAttribute('aria-hidden', 'true');
        remove.appendChild(removeIcon);
        remove.setAttribute('aria-label', key === 'target' ? '검색 대상을 전체로 초기화' : `${CatalogFilters.definitions[key].label} 필터 제거`);
        wrapper.appendChild(remove);
    }
    return { wrapper, edit, label };
}

function updateCatalogChips(state, view) {
    const update = (key, nodes, mobile) => {
        let node = nodes.get(key);
        if (!node) { node = catalogFilterChip(state, key, mobile); nodes.set(key, node); }
        const enabled = key === 'traits' || CatalogFilters.isEnabled(state.filters, key);
        node.edit.disabled = !enabled;
        node.wrapper.classList.toggle('is-unavailable', !enabled);
        node.wrapper.hidden = mobile && !enabled;
        const active = CatalogFilters.isActive(state.filters,key), definition = CatalogFilters.definitions[key];
        const summary = CatalogFilters.summarize(state.filters,key).replace(/^(OR|AND): /,'$1 : ');
        node.label.textContent = active ? summary : definition.characteristic ? CatalogFilters.kinds.find(kind=>kind.value===key).label : definition.label;
        node.wrapper.classList.toggle('color-tint-theme',active); node.wrapper.classList.toggle('color-tint-neutral',!active);
        node.edit.setAttribute('aria-label', `${definition.label}: ${summary}`);
        return node;
    };
    const visibleKeys = ['target', ...state.addedFilters.filter(key => key !== 'target' && CatalogFilters.definitions[key])];
    for (const [key, node] of view.chipNodes) if (!visibleKeys.includes(key)) { node.wrapper.remove(); view.chipNodes.delete(key); }
    for (const key of visibleKeys) {
        const node = update(key, view.chipNodes, false);
        if (!node.wrapper.parentNode) view.chips.insertBefore(node.wrapper, view.add);
    }
    const mobileKeys = CatalogFilters.keys.filter(key => CatalogFilters.isEnabled(state.filters,key)).sort((a,b)=>Number(CatalogFilters.isActive(state.filters,b))-Number(CatalogFilters.isActive(state.filters,a)));
    for (const [key,node] of view.mobileChipNodes) if (!mobileKeys.includes(key)) { node.wrapper.remove(); view.mobileChipNodes.delete(key); }
    for (const key of mobileKeys) {
        const node = update(key, view.mobileChipNodes, true);
        view.mobileChips.appendChild(node.wrapper);
    }
}

function catalogCardHref(card) {
    if (typeof SearchNavigation !== 'undefined') return SearchNavigation.cardHref(card);
    const params = new URLSearchParams();
    if (card.cid) params.set('cid', card.cid);
    if (card.number) params.set('code', card.number);
    if (!card.cid && !card.number) { params.set('m', '1'); params.set('key', card.name); }
    return `#search?${params}`;
}

function updateCatalogRows(state, view, visible) {
    const { quantities, nameQuantities, numberQuantities } = getCatalogQuantityIndexes(state.items);
    const liveKeys = new Set();
    visible.forEach((card, index) => {
        const key = card.cid || `${card.number ? 'number' : 'name'}:${card.number || card.name}`;
        liveKeys.add(key);
        let row = view.rows.get(key);
        if (!row) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'catalog-search-row ui-card--interactive color-type000 shape-rounded002';
            link.dataset.cardKey = key;
            const name = document.createElement('span'); name.className = 'catalog-search-name';
            const title = document.createElement('span');
            const number = document.createElement('span'); number.className = 'catalog-search-number color-text-002';
            name.append(title, number);
            const details = document.createElement('span'); details.className = 'catalog-search-details';
            const kind = document.createElement('span'); kind.className = 'catalog-search-kind color-text-002';
            const quantity = document.createElement('span'); quantity.className = 'catalog-search-quantity ui-chip color-tint-theme shape-capsule';
            details.append(kind, quantity);
            link.append(name, details); item.appendChild(link);
            row = { item, link, title, number, kind, quantity };
            view.rows.set(key, row);
        }
        row.link.href = catalogCardHref(card);
        row.link.onclick = event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            closeCatalogFilterEditor();
            if (typeof SearchNavigation !== 'undefined') SearchNavigation.openCard(card, state, row.link);
            else {
                const value = card.number || card.name;
                const input = document.getElementById('card-search');
                if (input) input.value = value;
                saveRecentSearch(value, card.number ? 'number' : 'name', true);
                if (card.cid) void renderTargetByCid(card.cid, card.number);
                else void startSearch(false, card.number ? 'number' : 'name', true);
            }
        };
        row.title.textContent = card.name;
        row.number.textContent = card.number || '';
        row.number.hidden = !card.number;
        const metadata = getCatalogNormalizedMeta(card);
        row.kind.textContent = CatalogFilters.kinds.find(kind => kind.value === metadata?.kind)?.label || '';
        row.kind.hidden = !metadata;
        const qty = card.cid ? quantities.get(String(card.cid)) : card.number ? numberQuantities.get(normalizeStr(card.number)) : nameQuantities.get(normalizeStr(card.name));
        row.quantity.textContent = `${qty || 0}장`;
        if (view.list.children[index] !== row.item) view.list.insertBefore(row.item, view.list.children[index] || null);
    });
    for (const [key, row] of view.rows) if (!liveKeys.has(key)) { row.item.remove(); view.rows.delete(key); }
}

function renderCatalogResults(state, mountContainer = null) {
    ensureCatalogFilterState(state);
    catalogPageSize = state.pageSize;
    let view = catalogViews.get(state);
    const mount = mountContainer || view?.mount || document.getElementById('result-area');
    if (!mount) return;
    if (!view || view.mount !== mount || view.root.parentNode !== mount) view = buildCatalogView(state, mount);
    const filtered = [];
    let unresolved = 0;
    for (const item of state.items) {
        const result = CatalogFilters.evaluate(item, state.filters, getCatalogNormalizedMeta(item));
        if (result === 'match') filtered.push(item);
        else if (result === 'pending') unresolved++;
    }
    const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.max(1, Math.min(state.page, pages));
    view.list.setAttribute('aria-busy', String(!!state.pending));
    const unlinked = filtered.filter(item => !item.cid).length;
    const confirmedCount = filtered.length - unlinked;
    view.total.textContent = unresolved || state.error || unlinked ? `확인된 ${confirmedCount}장` : `총 ${confirmedCount}장`;
    const messages = [];
    if (unlinked) messages.push(`카드 식별자 미확인 후보 ${unlinked}개 · 중복 확인 전`);
    if (state.error) messages.push(unresolved ? `${unresolved}장의 조건 확인 불가 · 확인된 결과만 표시합니다.` : '일부 카드 정보를 확인하지 못했습니다. 검색 결과는 그대로 표시합니다.');
    if (!state.pending && !state.error && unresolved) messages.push(`${unresolved}장의 조건 확인 불가 · 확인된 결과만 표시합니다.`);
    const hasStatusNotice = messages.length > 0;
    if (!hasStatusNotice) messages.push(`총 ${confirmedCount}장`);
    view.status.classList.toggle('visually-hidden', !hasStatusNotice);
    view.status.textContent = messages.join(' · ');
    view.status.hidden = !!state.pending;
    view.chips.hidden = !!state.pending;
    view.mobileChips.hidden = !!state.pending;
    view.loading.hidden = !state.pending;
    view.loading.textContent = state.pending ? (unresolved ? `조건 확인 중 · ${unresolved}장 대기` : '세부 정보 확인 중') : '';
    if (state.pending && catalogFilterEditor?.open && catalogFilterEditor.state === state) {
        closeCatalogFilterEditor({ restoreFocus: false });
    }
    view.sizeLabel.textContent = `${state.pageSize}개씩 보기`;
    view.sizeButton.setAttribute('aria-label', `페이지당 표시 수량: ${state.pageSize}개`);
    for (const [count, option] of view.sizeOptions) option.setAttribute('aria-selected', String(count === state.pageSize));
    updateCatalogChips(state, view);
    const visible = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    updateCatalogRows(state, view, visible);
    view.empty.hidden = visible.length > 0 || !!state.pending;
    view.empty.textContent = state.pending && unresolved ? '필터 조건에 필요한 카드 정보를 확인하고 있습니다.'
        : unresolved ? '확인된 일치 결과가 없습니다. 일부 카드 정보를 확인할 수 없습니다.' : '검색 결과가 없습니다.';
    view.pager.hidden = filtered.length === 0;
    view.previous.disabled = state.page <= 1;
    view.next.disabled = state.page >= pages;
    view.pageLabel.textContent = `${state.page} / ${pages}`;
    view.pageLabel.setAttribute('aria-label', `${pages}페이지 중 ${state.page}페이지`);
}

function ensureCatalogEditor() {
    if (catalogFilterEditor) return catalogFilterEditor;
    const backdrop = document.createElement('div');
    backdrop.id = 'catalog-filter-backdrop';
    backdrop.className = 'ui-overlay__backdrop color-surface-black';
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
    const root = document.createElement('section');
    root.id = 'catalog-filter-editor';
    root.className = 'catalog-filter-editor ui-overlay ui-overlay__panel ui-overlay--popup color-surface-001 color-text-001 shape-rounded003 shadow-medium';
    root.hidden = true;
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-labelledby', 'catalog-filter-title');
    const header = document.createElement('header'); header.className = 'ui-overlay__header';
    const title = document.createElement('h2'); title.id = 'catalog-filter-title'; title.className = 'color-text-000';
    const close = catalogButton('닫기', catalogTextButton, () => closeCatalogFilterEditor());
    close.setAttribute('aria-label', '필터 편집 닫기');
    close.textContent = '';
    const closeIcon = document.createElement('i'); closeIcon.className = 'material-icons'; closeIcon.textContent = 'close'; closeIcon.setAttribute('aria-hidden', 'true');
    close.appendChild(closeIcon);
    header.append(title, close);
    const body = document.createElement('div'); body.className = 'catalog-filter-editor__body';
    const content = document.createElement('div'); content.className = 'ui-overlay__body';
    const error = document.createElement('p'); error.id = 'catalog-filter-error'; error.className = 'catalog-filter-editor__error color-text-red';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('footer'); actions.className = 'ui-overlay__footer';
    const reset = catalogButton('초기화', catalogFilledButton, () => {
        const editor = catalogFilterEditor;
        const key = editor.editKey;
        editor.drafts[key] = CatalogFilters.emptyValue(key);
        renderCatalogEditorForm();
    });
    const apply = catalogButton('적용', 'ui-button color-theme shape-capsule', () => {
        const editor = catalogFilterEditor;
        const key = editor.editKey;
        if (key === 'target' && !editor.drafts.target.length) return;
        const errorMessage = applyCatalogFilter(editor.state, key, editor.drafts[key]);
        if (errorMessage) {
            editor.error.textContent = errorMessage;
            editor.body.querySelector('input')?.focus();
            return;
        }
        editor.drafts[key] = CatalogFilters.clone(editor.state.filters[key]);
        closeCatalogFilterEditor();
    });
    reset.className = catalogTextButton;
    reset.textContent = ''; reset.setAttribute('aria-label','초기화');
    const resetIcon=document.createElement('i'); resetIcon.className='material-icons'; resetIcon.textContent='refresh'; resetIcon.setAttribute('aria-hidden','true'); reset.append(resetIcon);
    const tools=document.createElement('div'); tools.className='ui-overlay__header'; tools.append(reset,close); header.replaceChildren(title,tools);
    apply.classList.add('color-disabled','ui-control--disabled');
    actions.append(apply);
    content.append(body, error);
    root.append(header, content, actions);
    document.body.append(backdrop, root);
    backdrop.onclick = () => closeCatalogFilterEditor();
    document.addEventListener('pointerdown', event => {
        const editor = catalogFilterEditor;
        if (!editor?.open || editor.mobile || root.contains(event.target) || editor.trigger?.contains(event.target)) return;
        closeCatalogFilterEditor({ restoreFocus: false });
    });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeCatalogFilterEditor();
        }
    });
    catalogFilterEditor = { root, backdrop, title, body, error, actions, reset, apply, open: false };
    return catalogFilterEditor;
}

function openCatalogFilterEditor(state, key, trigger) {
    if (state.pending) return;
    closeDropdowns();
    const editor = ensureCatalogEditor();
    if (editor.open) closeCatalogFilterEditor({ restoreFocus: false });
    editor.state = state;
    editor.key = key;
    editor.mobile = document.documentElement.classList.contains('is-mobile-device');
    editor.trigger = trigger;
    editor.drafts = CatalogFilters.clone(state.filters);
    if (!editor.drafts.target.length) editor.drafts.target = ['name', 'number'];
    editor.editKey = key;
    editor.open = true;
    editor.root.hidden = false;
    editor.root.inert = false;
    editor.root.style.removeProperty('display');
    editor.root.classList.toggle('ui-overlay--sheet', editor.mobile);
    editor.root.classList.toggle('ui-overlay--popup', !editor.mobile);
    editor.root.classList.toggle('shape-rounded-lg', editor.mobile);
    editor.root.classList.toggle('shape-rounded003', !editor.mobile);
    editor.root.classList.toggle('shadow-mobile-sheet', editor.mobile);
    editor.root.classList.toggle('shadow-medium', !editor.mobile);
    editor.root.style.removeProperty('left');
    editor.root.style.removeProperty('top');
    trigger?.setAttribute('aria-expanded', 'true');
    renderCatalogEditorForm();
    if (editor.mobile) {
        editor.backdrop.hidden = false;
        openManagedSheet(editor.root, { backdrop: editor.backdrop, trigger, initialFocus: editor.root });
    } else {
        editor.root.removeAttribute('aria-modal');
        if (globalThis.AppOverlays) globalThis.AppOverlays.openPopup(editor.root, trigger);
        editor.root.focus({ preventScroll: true });
    }
}

function closeCatalogFilterEditor({ restoreFocus = true } = {}) {
    const editor = catalogFilterEditor;
    if (!editor?.open) return;
    editor.open = false;
    editor.root.inert = true;
    editor.trigger?.setAttribute('aria-expanded', 'false');
    const view = catalogViews.get(editor.state);
    const key = editor.editKey;
    if (!editor.mobile && key !== 'target' && CatalogFilters.definitions[key] && !CatalogFilters.isActive(editor.state.filters, key)) {
        editor.state.addedFilters = editor.state.addedFilters.filter(item => item !== key);
        if (view) updateCatalogChips(editor.state, view);
    }
    if (editor.mobile) {
        closeManagedSheet(editor.root, { backdrop: editor.backdrop });
    } else {
        if (globalThis.AppOverlays) globalThis.AppOverlays.closePopup(editor.root);
        else editor.root.hidden = true;
        if (restoreFocus) (editor.trigger?.isConnected ? editor.trigger : view?.add)?.focus({ preventScroll: true });
    }
}

function renderCatalogEditorForm() {
    const editor = catalogFilterEditor;
    const { state, key, editKey, body } = editor;
    body.replaceChildren();
    editor.error.textContent = '';
    editor.actions.hidden = key === 'add';
    editor.reset.hidden = key === 'add';
    editor.title.textContent = key === 'add' ? '필터 추가' : CatalogFilters.definitions[key].label;
    if (key === 'add') {
        const available = CatalogFilters.keys.filter(item => !state.addedFilters.includes(item));
        const options = document.createElement('div');
        if (!editor.mobile) options.className = 'catalog-search-filters';
        for (const item of available) {
            const option = catalogButton(CatalogFilters.definitions[item].label,
                editor.mobile ? `catalog-filter-editor__add-option ${catalogFilledButton}`
                    : 'ui-button ui-chip color-tint-neutral color-disabled ui-control--disabled shape-capsule', () => {
                    if (!state.addedFilters.includes(item)) state.addedFilters.push(item);
                    const view = catalogViews.get(state);
                    if (view) updateCatalogChips(state, view);
                    const update = () => {
                        editor.key = item; editor.editKey = item;
                        renderCatalogEditorForm();
                    };
                    if (!editor.mobile && globalThis.AppOverlays?.updatePopup) AppOverlays.updatePopup(editor.root, update);
                    else update();
                    editor.root.focus({ preventScroll: true });
                });
            option.disabled = !CatalogFilters.isEnabled(state.filters, item);
            options.appendChild(option);
        }
        body.appendChild(options);
        if (!available.length) body.textContent = '추가할 수 있는 필터가 없습니다.';
        return;
    }
    editor.reset.hidden = false;
    const definition = CatalogFilters.definitions[editKey];
    FilterEditor.render({ form:body, key:editKey, definition, drafts:editor.drafts, mobile:editor.mobile,
        errorId:'catalog-filter-error', changed:() => {
            editor.apply.disabled = editKey === 'target' && !editor.drafts.target.length;
            editor.error.textContent = '';
        } });
}
