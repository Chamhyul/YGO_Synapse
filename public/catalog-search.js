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
function rememberCatalogLinks(item, cards) {
    for (const card of cards) ClientCache.registerCid(card.cid,
        item.type === 'name' ? [item.val] : (card.name ? [card.name] : []),
        item.type === 'number' ? [item.val] : []);
}

async function completeCatalogMetadata(links, sequence) {
    const cids = [...new Set([...links.values()].flat().map(card => String(card.cid)))];
    const missing = cids.filter(cid => {
        const meta = cidMetaMemoryCache.get(cid);
        return !meta || !Object.hasOwn(meta.info || {}, '10') || Date.now() - (meta.cachedAt || 0) >= 60000;
    });
    // Older deployed resolvers return only CIDs. Use the existing batch endpoint in that case.
    if (missing.length && sequence === searchSequence) {
        await fetchCardsMetaBatch(missing);
        if (sequence !== searchSequence) return;
        if (missing.some(cid => !Object.hasOwn(cidMetaMemoryCache.get(cid)?.info || {}, '10'))) {
            throw new Error('일부 카드의 세부 정보를 불러오지 못했습니다.');
        }
    }
}

async function resolveCatalogMatches(matches, sequence, onProgress = () => {}) {
    const links = new Map();
    const missing = [];
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
        }
        for (const item of chunk) {
            const cards = item.type === 'name'
                ? (res.results[item.val] || []).map(cid => ({ cid, name: item.val }))
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
    }
    if (!missing.length) {
        await completeCatalogMetadata(links, sequence);
        if (sequence !== searchSequence) return null;
        onProgress(groupCatalogResults(matches, links));
    }
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

async function showCatalogSearch(query, filter, sequence, isInstant) {
    const matches = collectCatalogMatches(query);
    const state = { type: 'broad', items: [], query, filter: ['name', 'number'].includes(filter) ? filter : 'auto', page: 1, pageSize: 20, pending: true };
    lastSearchState = state;
    if (UIStore.mode !== 'search') switchToMode('search', isInstant);
    const isCurrent = () => sequence === searchSequence && lastSearchState === state && UIStore.mode === 'search';
    try {
        await resolveCatalogMatches(matches, sequence, items => {
            if (!isCurrent()) return;
            state.items = items;
            renderCatalogResults(state);
        });
    } catch (error) {
        if (isCurrent()) state.error = '일부 카드의 세부 정보를 불러오지 못했습니다. 검색 결과는 그대로 표시합니다.';
    } finally {
        if (isCurrent()) {
            state.pending = false;
            renderCatalogResults(state);
        }
    }
    void refreshPublicDataQuietly();
}

function renderCatalogResults(state) {
    const area = document.getElementById('result-area');
    area.innerHTML = '';
    area.setAttribute('aria-busy', 'false');
    const filtered = state.items.filter(item => state.filter === 'auto'
        || (state.filter === 'name' ? item.nameMatch : item.numberMatch));
    const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.min(state.page, pages);
    const toolbar = document.createElement('div');
    toolbar.className = 'catalog-search-toolbar';
    const chips = document.createElement('div');
    chips.className = 'catalog-search-filters';
    chips.setAttribute('aria-label', '검색 결과 필터');
    for (const [filter, label] of [['auto', '전체'], ['name', '이름'], ['number', '번호']]) {
        const count = state.items.filter(item => filter === 'auto' || (filter === 'name' ? item.nameMatch : item.numberMatch)).length;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `catalog-search-chip ui-button ui-button--filled ui-shape-capsule ${state.filter === filter ? 'ui-color--theme' : 'ui-color--type000'}`;
        button.setAttribute('aria-pressed', String(state.filter === filter));
        button.textContent = `${label} ${count}`;
        button.onclick = () => {
            state.filter = filter; state.page = 1;
            updateSearchHash('broad', { searchType: filter, key: state.query });
            renderCatalogResults(state);
        };
        chips.appendChild(button);
    }
    toolbar.appendChild(chips);
    const size = document.createElement('div');
    size.className = 'region-container dropdown-capsule catalog-search-size';
    const surface = document.createElement('div');
    surface.className = 'region-expansion-bg dropdown-capsule__surface ui-shape-capsule';
    const options = document.createElement('ul');
    options.id = 'catalog-page-size-options';
    options.className = 'region-dropdown-list';
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', '페이지당 표시 수량');
    options.onkeydown = event => handleRegionOptionKeydown(event, size);
    for (const count of [20, 50, 100]) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        option.setAttribute('aria-selected', String(count === state.pageSize));
        option.textContent = `${count}개씩 보기`;
        option.onclick = () => {
            closeDropdowns();
            state.pageSize = count; state.page = 1; renderCatalogResults(state);
            document.getElementById('catalog-page-size-button')?.focus();
        };
        options.appendChild(option);
    }
    surface.appendChild(options);
    size.appendChild(surface);
    const sizeButton = document.createElement('button');
    sizeButton.id = 'catalog-page-size-button';
    sizeButton.type = 'button';
    sizeButton.className = 'app-header-control region-capsule';
    sizeButton.setAttribute('aria-haspopup', 'listbox');
    sizeButton.setAttribute('aria-controls', options.id);
    sizeButton.setAttribute('aria-expanded', 'false');
    sizeButton.setAttribute('aria-label', `페이지당 표시 수량: ${state.pageSize}개`);
    sizeButton.innerHTML = `<span class="region-text">${state.pageSize}개씩 보기</span><i class="material-icons region-icon" aria-hidden="true">expand_more</i>`;
    sizeButton.onclick = event => toggleRegionDropdown(event, size);
    sizeButton.onkeydown = event => handleRegionButtonKeydown(event, size);
    size.appendChild(sizeButton);
    toolbar.appendChild(size);
    area.appendChild(toolbar);
    const list = document.createElement('div');
    list.className = 'broad-search-list';
    area.appendChild(list);
    const { quantities, nameQuantities, numberQuantities } = getCatalogQuantityIndexes(state.items);
    const visible = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    for (const card of visible) {
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'broad-search-row catalog-search-row';
        const qty = card.cid ? quantities.get(card.cid) : card.number ? numberQuantities.get(normalizeStr(card.number)) : nameQuantities.get(normalizeStr(card.name));
        const meta = card.cid && cidMetaMemoryCache.get(card.cid);
        const kind = meta ? parseMetaKind(meta) : null;
        row.innerHTML = `<span class="broad-search-left">${escapeHTML(card.name)}${card.number ? `<span class="broad-card-name-sub">${escapeHTML(card.number)}</span>` : ''}</span><span class="catalog-search-details">${kind ? `<span class="broad-type-label broad-type-${kind.kind}">${escapeHTML(kind.kindStr)}</span>` : ''}<span class="broad-search-right">${qty || 0}장</span></span>`;
        row.onclick = () => {
            const value = card.number || card.name;
            document.getElementById('card-search').value = value;
            saveRecentSearch(value, card.number ? 'number' : 'name', true);
            if (card.cid) void renderTargetByCid(card.cid, card.number);
            else void startSearch(false, card.number ? 'number' : 'name', true);
        };
        list.appendChild(row);
    }
    if (!visible.length) {
        const empty = document.createElement('p');
        empty.className = 'center'; empty.textContent = '검색 결과가 없습니다.';
        list.appendChild(empty);
    }
    if (pages > 1) {
        const pager = document.createElement('div'); pager.className = 'catalog-search-pager';
        for (const [label, delta] of [['이전', -1], [`${state.page} / ${pages}`, 0], ['다음', 1]]) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
            button.disabled = !delta || state.page + delta < 1 || state.page + delta > pages;
            button.onclick = () => { state.page += delta; renderCatalogResults(state); };
            pager.appendChild(button);
        }
        area.appendChild(pager);
    }
    if (state.pending || state.error) {
        const status = document.createElement('div');
        status.className = 'catalog-search-progress';
        status.setAttribute('role', 'status');
        status.textContent = state.error || '세부 정보 확인 중...';
        area.appendChild(status);
    }
}
