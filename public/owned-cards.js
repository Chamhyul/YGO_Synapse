/* 단일 카드의 보유 요약·상세. 저장 데이터는 변경하지 않고 화면별 펼침 상태만 보관합니다. */
(function (root) {
    'use strict';
    const views = new WeakMap();
    let serial = 0;
    const duration = 200;
    const locationKey = value => String(value ?? '').trim() ? String(value) : '';
    const locationLabel = value => value || '위치 미지정';

    function groupRows(rows, compareRarity = (a, b) => a.localeCompare(b)) {
        const cards = new Map();
        for (const row of rows) {
            const number = String(row[1] ?? '');
            const rarity = String(row[2] ?? '').trim();
            const quantity = parseInt(row[3], 10) || 0;
            const location = locationKey(row[4]);
            const illustration = String(row[5] || '기본').trim() || '기본';
            if (!cards.has(number)) cards.set(number, {
                number, name: String(row[0] || ''), cid: String(row[6] || ''), total: 0, locations: new Set(), rarities: new Set(), illustrations: new Map(),
            });
            const card = cards.get(number);
            if (!card.cid && row[6]) card.cid = String(row[6]);
            card.total += quantity;
            card.locations.add(location);
            if (rarity) card.rarities.add(rarity);
            if (!card.illustrations.has(illustration)) card.illustrations.set(illustration, new Map());
            const locations = card.illustrations.get(illustration);
            if (!locations.has(location)) locations.set(location, { location, total: 0, quantities: new Map() });
            const item = locations.get(location);
            item.total += quantity;
            item.quantities.set(rarity, (item.quantities.get(rarity) || 0) + quantity);
        }
        return [...cards.values()].map(card => ({
            ...card,
            locations: [...card.locations],
            rarities: [...card.rarities].sort(compareRarity),
            illustrations: [...card.illustrations].sort(([a], [b]) => {
                if (a === b) return 0;
                if (a === '기본') return -1;
                if (b === '기본') return 1;
                return a.localeCompare(b, undefined, { numeric: true });
            }).map(([illustration, locations]) => ({ illustration, locations: [...locations.values()] })),
        }));
    }

    function element(document, tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = String(text);
        return el;
    }

    function createDetailContent(document, card, options) {
        const list = element(document, 'ul', 'owned-card__details');
        list.setAttribute('aria-label', `${card.number || '번호 미지정'} 일러스트별 보유 상세`);
        const images = [];
        for (const [index, group] of card.illustrations.entries()) {
            const surfaceClass = index % 2 === 0 ? 'color-searchDetailArea-odd' : 'color-searchDetailArea-even';
            const item = element(document, 'li', `owned-card__illustration-group ${surfaceClass}`);
            const artwork = element(document, 'div', 'owned-card__artwork color-surface-000 shape-rounded002');
            const image = element(document, 'img', 'owned-card__image');
            image.alt = `${card.name || card.number || '카드'} · ${group.illustration === '기본' ? '기본 일러스트' : `일러스트 ${group.illustration}`}`;
            image.width = 72;
            image.height = 72;
            image.decoding = 'async';
            image.hidden = true;
            const status = element(document, 'span', 'owned-card__image-status color-text-002', '이미지 불러오는 중');
            artwork.append(image, status);
            const locations = element(document, 'ul', 'owned-card__detail-locations');
            locations.setAttribute('aria-label', '보관 위치별 레어도·수량');
            for (const location of group.locations) {
                const locationRow = element(document, 'li', 'owned-card__location-row');
                const locationChip = element(document, 'span', 'owned-card__location-chip ui-chip ui-chip--compact color-type003 shape-capsule', locationLabel(location.location));
                const rarities = element(document, 'ul', 'owned-card__rarities ui-chip-list');
                const keys = [...location.quantities.keys()].sort(options.compareRarity || ((a, b) => a.localeCompare(b)));
                for (const key of keys) {
                    const quantity = location.quantities.get(key);
                    const label = options.describeRarity?.(key, card)?.label || key || '레어도 미지정';
                    const rarityItem = element(document, 'li');
                    const chip = element(document, 'span', 'owned-card__rarity-chip ui-chip ui-chip--compact color-tint-theme shape-capsule', `${label} • ${quantity}장`);
                    chip.dataset.rarity = key;
                    chip.dataset.quantity = String(quantity);
                    rarityItem.appendChild(chip);
                    rarities.appendChild(rarityItem);
                }
                locationRow.append(locationChip, rarities);
                locations.appendChild(locationRow);
            }
            item.append(artwork, locations);
            list.appendChild(item);
            images.push({ image, status, artwork, illustration: group.illustration });
        }
        return { list, images };
    }

    function loadDetailImages(view, entry) {
        if (entry.imagesStarted) return;
        entry.imagesStarted = true;
        const version = entry.imageVersion;
        const load = view.options.loadIllustration;
        const card = entry.card;
        for (const slot of entry.images) {
            const current = () => !view.disposed && version === entry.imageVersion
                && view.entries.get(entry.number) === entry && entry.detail.contains(slot.image);
            const missing = () => {
                if (!current()) return;
                slot.image.hidden = true;
                slot.status.hidden = false;
                slot.status.textContent = '이미지 없음';
                slot.artwork.setAttribute('aria-busy', 'false');
            };
            slot.artwork.setAttribute('aria-busy', 'true');
            slot.image.addEventListener('error', missing);
            Promise.resolve().then(() => load?.(card, slot.illustration)).then(result => {
                if (!current()) return;
                if (result?.status !== 'loaded' || !result.url) { missing(); return; }
                slot.image.src = result.url;
                slot.image.hidden = false;
                slot.status.hidden = true;
                slot.artwork.setAttribute('aria-busy', 'false');
            }).catch(missing);
        }
    }

    function updateConnections(view) {
        const entries = [...view.list.children].map(item => view.entries.get(item.dataset.number));
        entries.forEach((entry, i) => {
            entry.item.classList.toggle('is-joined-before', i > 0 && !entry.open && !entries[i - 1].open);
            entry.item.classList.toggle('is-joined-after', i < entries.length - 1 && !entry.open && !entries[i + 1].open);
        });
    }

    const foldedPanel = { opacity: '0', transform: 'translateY(-4px)', clipPath: 'inset(0 0 100% 0)' };
    const visiblePanel = { opacity: '1', transform: 'translateY(0px)', clipPath: 'inset(0 0 0% 0)' };

    function syncPanels(entry) {
        for (const [panel, visible] of [[entry.locations, !entry.open], [entry.detail, entry.open]]) {
            panel.classList.toggle('is-leaving', false);
            panel.hidden = !visible;
            panel.inert = !visible;
            panel.setAttribute('aria-hidden', String(!visible));
        }
    }

    function cancelTransition(entry) {
        const animation = entry.heightAnimation;
        entry.heightAnimation = null;
        entry.heightObserver?.disconnect();
        entry.heightObserver = null;
        animation?.cancel();
        entry.panelAnimations.forEach(panelAnimation => panelAnimation.cancel());
        entry.panelAnimations = [];
        syncPanels(entry);
    }

    function panelFrame(view, panel) {
        if (panel.hidden) return foldedPanel;
        const style = view.document.defaultView?.getComputedStyle?.(panel);
        return style ? {
            opacity: style.opacity,
            transform: style.transform === 'none' ? visiblePanel.transform : style.transform,
            clipPath: style.clipPath === 'none' ? visiblePanel.clipPath : style.clipPath,
        } : visiblePanel;
    }

    function setExpanded(view, entry, open) {
        // 표시를 교체하기 전의 높이(전환 중이면 현재 프레임)를 시작점으로 사용합니다.
        const fromHeight = entry.content.getBoundingClientRect().height;
        const frames = new Map([entry.locations, entry.detail].map(panel => [panel, panelFrame(view, panel)]));
        cancelTransition(entry);
        entry.open = open;
        entry.button.setAttribute('aria-expanded', String(open));
        entry.button.setAttribute('aria-label', `${entry.number || '번호 미지정'} 보유 상세 ${open ? '닫기' : '펼치기'}`);
        entry.label.textContent = open ? '닫기' : '펼치기';
        const detail = entry.detail;
        if (!open && detail.contains(view.document.activeElement)) entry.button.focus({ preventScroll: true });
        syncPanels(entry);
        entry.item.classList.toggle('is-expanded', open);
        if (open) loadDetailImages(view, entry);
        updateConnections(view);
        const targetSize = entry.content.getBoundingClientRect();
        const toHeight = targetSize.height;
        if (typeof entry.content.animate === 'function'
            && !view.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            const incoming = open ? detail : entry.locations;
            const outgoing = open ? entry.locations : detail;
            // 퇴장 내용은 같은 칸에 겹쳐 두어 목표 높이를 늘리지 않고 접습니다.
            outgoing.classList.toggle('is-leaving', true);
            outgoing.hidden = false;
            entry.panelAnimations = [incoming, outgoing].map(panel => panel.animate([
                frames.get(panel), panel === incoming ? visiblePanel : foldedPanel,
            ], { duration, easing: 'ease', fill: 'both' }));
            const animation = entry.content.animate([
                { height: `${fromHeight}px` }, { height: `${toHeight}px` },
            ], { duration, easing: 'ease' });
            entry.heightAnimation = animation;
            animation.onfinish = () => {
                if (entry.heightAnimation === animation) cancelTransition(entry);
            };
            const ResizeObserver = view.document.defaultView?.ResizeObserver;
            if (ResizeObserver) {
                entry.heightObserver = new ResizeObserver(() => {
                    if (entry.heightAnimation !== animation) return;
                    // 줄바꿈 기준이 바뀌면 이전 폭에서 측정한 목표 높이를 고정하지 않습니다.
                    if (Math.abs(entry.content.getBoundingClientRect().width - targetSize.width) > 0.5) {
                        cancelTransition(entry);
                    }
                });
                entry.heightObserver.observe(entry.content);
            }
        }
    }

    function createEntry(view, card) {
        const { document } = view;
        const item = element(document, 'li', 'owned-card ui-stack-card color-text-000 shape-rounded003');
        item.dataset.number = card.number;
        const heading = element(document, 'div', 'owned-card__heading');
        const number = element(document, 'h3', 'owned-card__number', card.number || '번호 미지정');
        const locations = element(document, 'ul', 'owned-card__locations ui-chip-list');
        locations.setAttribute('aria-label', '보관 위치');
        const content = element(document, 'div', 'owned-card__content');
        const quantity = element(document, 'span', 'owned-card__quantity');
        const button = element(document, 'button', 'owned-card__toggle ui-button ui-button--text color-text-002');
        button.type = 'button';
        const label = element(document, 'span', 'owned-card__toggle-label', '펼치기');
        const icon = element(document, 'i', 'owned-card__chevron material-icons', 'keyboard_arrow_down');
        icon.setAttribute('aria-hidden', 'true');
        button.append(label, icon);
        heading.append(number, quantity);
        item.append(heading, content);
        const detail = element(document, 'div', 'owned-card__detail');
        detail.id = `owned-detail-${view.id}-${++view.serial}`;
        detail.hidden = true;
        detail.inert = true;
        detail.setAttribute('aria-hidden', 'true');
        button.setAttribute('aria-controls', detail.id);
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', `${card.number || '번호 미지정'} 보유 상세 펼치기`);
        content.append(locations, detail, button);
        const entry = { number: card.number, item, content, locations, quantity, button, label, detail, open: false, heightAnimation: null, panelAnimations: [], imageVersion: 0, imagesStarted: false, images: [] };
        button.addEventListener('click', () => setExpanded(view, entry, !entry.open));
        item.addEventListener('click', event => {
            // 버튼의 기본 동작은 그대로 두고 카드 표면의 클릭 영역만 확장합니다.
            if (event.defaultPrevented || event.button > 0 || button.contains(event.target) || detail.contains(event.target)) return;
            if (event.target?.closest?.('a[href], button, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"]')) return;
            const selection = document.getSelection?.();
            if (selection?.isCollapsed === false
                && (item.contains(selection.anchorNode) || item.contains(selection.focusNode))) return;
            setExpanded(view, entry, !entry.open);
        });
        return entry;
    }

    function disposeEntry(view, entry) {
        cancelTransition(entry);
        entry.imageVersion++;
        entry.item.remove();
    }

    // 나가는 화면의 최종 표시 상태는 유지하고 전환과 이미지의 지연 응답을 무효화합니다.
    function dispose(container) {
        const view = views.get(container);
        if (!view) return;
        view.disposed = true;
        view.entries.forEach(entry => {
            cancelTransition(entry);
            entry.imageVersion++;
        });
        views.delete(container);
    }

    function render(rows, container, options = {}) {
        if (!container) return;
        const document = container.ownerDocument;
        let view = views.get(container);
        const focusedButton = view && [...view.entries.values()].find(entry => entry.button === document.activeElement)?.button;
        const contextKey = options.contextKey ?? '';
        const sameContext = view?.contextKey === contextKey;
        if (!view || !sameContext || view.list.parentNode !== container) {
            if (view) view.entries.forEach(entry => disposeEntry(view, entry));
            const list = element(document, 'ul', 'owned-card-list');
            const empty = element(document, 'p', 'owned-card-empty color-text-002', '보유한 카드가 없습니다.');
            container.replaceChildren(list, empty);
            view = { document, list, empty, contextKey, id: ++serial, serial: 0, entries: new Map(), options };
            views.set(container, view);
        }
        view.options = options;
        const cards = groupRows(rows, options.compareRarity);
        const numbers = new Set(cards.map(card => card.number));
        view.entries.forEach((entry, number) => {
            if (!numbers.has(number)) { disposeEntry(view, entry); view.entries.delete(number); }
        });
        cards.forEach((card, i) => {
            let entry = view.entries.get(card.number);
            if (!entry) { entry = createEntry(view, card); view.entries.set(card.number, entry); }
            cancelTransition(entry);
            entry.item.classList.toggle('color-surface-001', i % 2 === 0);
            entry.item.classList.toggle('color-surface-002', i % 2 === 1);
            entry.quantity.textContent = `${card.total}장`;
            entry.quantity.setAttribute('aria-label', `총 ${card.total}장`);
            entry.locations.replaceChildren(...card.locations.map(location => {
                const li = element(document, 'li');
                li.appendChild(element(document, 'span', 'ui-chip ui-chip--compact color-tint-theme shape-capsule', locationLabel(location)));
                return li;
            }));
            entry.imageVersion++;
            entry.imagesStarted = false;
            entry.card = card;
            const content = createDetailContent(document, card, options);
            entry.images = content.images;
            entry.detail.replaceChildren(content.list);
            if (entry.open) loadDetailImages(view, entry);
            if (view.list.children[i] !== entry.item) view.list.insertBefore(entry.item, view.list.children[i] || null);
        });
        updateConnections(view);
        view.list.hidden = cards.length === 0;
        view.empty.hidden = cards.length !== 0;
        if (sameContext && focusedButton?.isConnected && document.activeElement !== focusedButton) {
            focusedButton.focus({ preventScroll: true });
        }
        return view;
    }

    const api = { groupRows, render, dispose };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.OwnedCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
