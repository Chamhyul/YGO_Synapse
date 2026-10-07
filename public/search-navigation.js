/* Search views share one route surface; history stores identifiers, never DOM or inventory data. */
(function (root) {
    'use strict';
    function createSearchNavigation(env) {
        const { document, history, location } = env;
        const entries = new Map();
        let current = null, pane = null, serial = 0, activeTransition = null;
        const session = Date.now().toString(36);
        const area = () => document.getElementById('result-area');
        const scroller = () => document.getElementById('app-page-search');
        const own = state => state?.searchNavigation;
        const hashFor = state => {
            if (state.type === 'broad') {
                const mode = state.filter === 'name' ? 1 : state.filter === 'number' ? 2 : 0;
                return `#search?m=${mode}&key=${encodeURIComponent(state.query || '')}`;
            }
            const params = new URLSearchParams();
            if (state.targetCid) params.set('cid', state.targetCid);
            if (state.prioritizeNumber) params.set('code', state.prioritizeNumber);
            if (!params.size) params.set('target', state.targetCardName || '');
            return `#search?${params}`;
        };
        const cardHref = card => hashFor({ type: 'target', targetCid: card.cid,
            prioritizeNumber: card.number, targetCardName: card.name });
        const recordPosition = () => {
            if (!current || env.mode() !== 'search') return;
            const page = scroller();
            current.position = { top: page?.scrollTop || 0, left: page?.scrollLeft || 0,
                windowX: env.window.scrollX || 0, windowY: env.window.scrollY || 0 };
        };
        function writeEntry(entry, replace) {
            const state = { ...(history.state || {}) };
            delete state.mobileSearchOpen;
            state.searchNavigation = { id: entry.id, order: entry.order };
            history[replace ? 'replaceState' : 'pushState'](state, '', entry.hash);
        }
        function commit(state, options = {}) {
            recordPosition();
            const entry = { id: `${session}-${++serial}`, order: serial, state, hash: hashFor(state),
                backId: options.backId || null, position: null, focusHref: null };
            const replace = options.instant || !!history.state?.mobileSearchOpen || location.hash === entry.hash && !current;
            entries.set(entry.id, entry);
            current = entry;
            env.setState(state);
            writeEntry(entry, replace);
            // Keep a bounded set of recent views. Evicted history still resolves from its normal URL.
            while (entries.size > 40) entries.delete(entries.keys().next().value);
            return entry;
        }
        function cancelTransition() {
            const active = activeTransition;
            if (!active) return;
            activeTransition = null;
            active.observer?.disconnect();
            active.animations.forEach(animation => animation.cancel());
            active.old?.remove();
            active.area.classList.remove('is-transitioning');
        }
        function restorePosition(entry) {
            if (current !== entry || !entry.position) return;
            const page = scroller();
            if (page) { page.scrollTop = entry.position.top; page.scrollLeft = entry.position.left; }
            env.window.scrollTo(entry.position.windowX, entry.position.windowY);
        }
        function focusView(entry, restoring) {
            if (current !== entry || env.mode() !== 'search') return;
            if (restoring && entry.focusHref) {
                const link = [...pane.querySelectorAll('.catalog-search-row')].find(el => el.getAttribute('href') === entry.focusHref);
                if (link) { link.focus({ preventScroll: true }); return; }
            }
            const heading = pane.querySelector('h2, h1');
            if (heading) {
                heading.tabIndex = -1;
                heading.classList.add('search-results__focus-target');
                heading.focus({ preventScroll: true });
            }
        }
        function addBack(entry) {
            const previous = entries.get(entry.backId);
            if (!previous || !pane || entry.state.type !== 'target') return;
            pane.querySelector('.search-results__back')?.remove();
            const back = document.createElement('a');
            back.href = previous.hash;
            back.className = 'search-results__back ui-button ui-button--text color-text-001';
            back.setAttribute('aria-label', '검색 결과로 돌아가기');
            back.innerHTML = '<svg class="search-results__back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span class="search-results__back-label">뒤로 가기</span>';
            back.onclick = event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (own(history.state)?.id === entry.id) history.back();
                else { writeEntry(previous, true); restore(previous); }
            };
            const header = pane.querySelector('.search-card__name');
            if (header) header.prepend(back);
            else pane.prepend(back);
        }
        function display(entry, render, direction, { instant = false, restoring = false, focus = true } = {}) {
            env.closeEditor();
            cancelTransition();
            const result = area();
            if (!result) return null;
            const old = pane?.parentNode === result ? pane : result.firstElementChild;
            const oldHeight = result.getBoundingClientRect().height;
            // Old views are real nodes, not clones. Drop their IDs before mounting an incoming view.
            if (old) {
                env.disposePane?.(old);
                old.inert = true;
                old.setAttribute('aria-hidden', 'true');
                old.removeAttribute('id');
                old.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
                old.classList.add('search-results__pane--leaving');
            }
            pane = document.createElement('div');
            pane.className = 'search-results__pane';
            pane.dataset.searchView = entry.state.type;
            result.appendChild(pane);
            const next = pane;
            const rendering = render(next);
            if (rendering?.catch) rendering.catch(error => env.report(error));
            addBack(entry);
            result.dataset.transition = direction;
            const finishFocus = () => {
                if (restoring) restorePosition(entry);
                else if (!instant) {
                    const page = scroller();
                    if (page) page.scrollTop = 0;
                }
                if (focus && !instant) focusView(entry, restoring);
            };
            if (instant || !old || !next.animate || env.window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                old?.remove();
                finishFocus();
                return next;
            }
            const duration = 300, easing = 'cubic-bezier(0.4, 0, 0.2, 1)';
            result.classList.add('is-transitioning');
            const incomingX = direction === 'back' ? 'calc(-100% - 24px)' : 'calc(100% + 24px)';
            const outgoingX = direction === 'back' ? 'calc(100% + 24px)' : 'calc(-100% - 24px)';
            const animations = [
                next.animate(direction === 'down'
                    ? [{ transform: 'translateY(-32px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]
                    : [{ transform: `translateX(${incomingX})` }, { transform: 'translateX(0)' }], { duration, easing }),
                old.animate(direction === 'down' ? [{ opacity: 1 }, { opacity: 0 }]
                    : [{ transform: 'translateX(0)' }, { transform: `translateX(${outgoingX})` }], { duration, easing })
            ];
            const transition = { old, area: result, animations, observer: null };
            activeTransition = transition;
            const began = Date.now();
            let targetHeight = next.getBoundingClientRect().height;
            let heightAnimation = result.animate([{ height: `${oldHeight}px` }, { height: `${targetHeight}px` }], { duration, easing });
            animations.push(heightAnimation);
            if (env.window.ResizeObserver) {
                transition.observer = new env.window.ResizeObserver(() => {
                    if (activeTransition !== transition) return;
                    const height = next.getBoundingClientRect().height;
                    if (Math.abs(height - targetHeight) < 1) return;
                    const from = result.getBoundingClientRect().height;
                    heightAnimation.cancel();
                    targetHeight = height;
                    heightAnimation = result.animate([{ height: `${from}px` }, { height: `${height}px` }],
                        { duration: Math.max(1, duration - (Date.now() - began)), easing });
                    animations.push(heightAnimation);
                });
                transition.observer.observe(next);
            }
            Promise.all(animations.slice(0, 2).map(animation => animation.finished.catch(() => {}))).then(() => {
                if (activeTransition !== transition) return;
                cancelTransition();
                finishFocus();
            });
            return next;
        }
        function showCatalog(state, render, options = {}) {
            const wasSearch = env.mode() === 'search';
            const entry = commit(state, options);
            env.activate();
            return display(entry, render, 'down', { instant: options.instant || !wasSearch });
        }
        function updateCatalog(state) {
            if (current?.state !== state || state.type !== 'broad') return;
            current.hash = hashFor(state);
            if (own(history.state)?.id === current.id) writeEntry(current, true);
        }
        function showTarget(state, render, options = {}) {
            const wasSearch = env.mode() === 'search';
            const entry = commit(state, options);
            env.activate();
            return display(entry, render, options.backId ? 'forward' : 'down', { instant: options.instant || !wasSearch });
        }
        function updateTarget(state, mountedPane) {
            if (!current || current.state.type !== 'target' || mountedPane !== pane) return;
            current.state = { ...current.state, ...state };
            current.hash = hashFor(current.state);
            env.setState(current.state);
            if (own(history.state)?.id === current.id) writeEntry(current, true);
        }
        function openCard(card, state, trigger) {
            if (current?.state !== state) return;
            recordPosition();
            current.focusHref = trigger?.getAttribute('href') || cardHref(card);
            const backId = current.id;
            env.setQuery(card.number || card.name);
            env.remember(card.number || card.name, card.number ? 'number' : 'name');
            if (card.cid) return env.openByCid(card.cid, card.number, { backId });
            return env.openByName(card.number ? 'number' : 'name', { backId });
        }
        function restore(entry) {
            if (current === entry && env.mode() === 'search') return;
            const previous = current;
            recordPosition();
            env.invalidate();
            current = entry;
            env.setState(entry.state);
            env.activate();
            if (entry.state.type === 'broad') {
                env.setQuery(entry.state.query);
                const backward = previous?.state.type === 'target' && previous.backId === entry.id;
                display(entry, mount => env.renderCatalog(entry.state, mount), backward ? 'back' : 'down', { restoring: true });
                env.resumeCatalog(entry.state);
            } else {
                env.setQuery(entry.state.prioritizeNumber || entry.state.targetCardName);
                display(entry, mount => env.renderTarget(entry.state, mount), entry.backId === previous?.id ? 'forward' : 'down', { restoring: true });
            }
        }
        function handleHashChange(skipAutomation = false) {
            const entry = entries.get(own(history.state)?.id);
            if (!entry || entry.hash !== location.hash) return false;
            if (skipAutomation && current === entry) {
                if (entry.state.type === 'broad') env.renderCatalog(entry.state, pane);
                else {
                    const pending = env.renderTarget(entry.state, pane);
                    pending?.catch(env.report);
                    addBack(entry);
                }
            } else restore(entry);
            return true;
        }
        function onPopState(event) {
            if (event.state?.mobileSearchOpen) return;
            const entry = entries.get(own(event.state)?.id);
            if (entry && entry.hash === location.hash) restore(entry);
        }
        function leave() {
            recordPosition();
            cancelTransition();
            env.closeEditor();
            env.invalidate();
        }
        const api = { showCatalog, updateCatalog, showTarget, updateTarget, openCard, cardHref,
            currentPane: () => pane, handleHashChange, onPopState, leave, cancelTransition };
        return api;
    }
    if (typeof module !== 'undefined') module.exports = { createSearchNavigation };
    if (root.document) {
        root.SearchNavigation = createSearchNavigation({
            window: root, document: root.document, history: root.history, location: root.location,
            mode: () => UIStore.mode,
            setState: state => { lastSearchState = state; },
            invalidate: () => { searchSequence++; },
            activate: () => {
                if (UIStore.mode === 'search') return;
                const previous = isInternalHashChange;
                isInternalHashChange = true;
                try { switchToMode('search'); } finally { isInternalHashChange = previous; }
            },
            setQuery: value => {
                const input = document.getElementById('card-search');
                if (input) input.value = value || '';
                checkClearBtn();
            },
            closeEditor: () => { if (typeof closeCatalogFilterEditor === 'function') closeCatalogFilterEditor({ restoreFocus: false }); },
            disposePane: pane => {
                if (typeof OwnedCards !== 'undefined') {
                    pane.querySelectorAll('.target-inventory-section').forEach(section => OwnedCards.dispose(section));
                }
            },
            remember: (value, type) => saveRecentSearch(value, type, true),
            openByCid: (cid, code, options) => renderTargetByCid(cid, code, false, options),
            openByName: (type, options) => startSearch(false, type, true, options),
            renderCatalog: (state, mount) => renderCatalogResults(state, mount),
            resumeCatalog: state => { if (typeof resumeCatalogSearch === 'function') void resumeCatalogSearch(state, searchSequence); },
            renderTarget: (state, mount) => renderTargetSearchResult(state.targetCardName,
                getInventoryRowsByCidOrName(state.targetCid, state.targetCardName, state.prioritizeNumber),
                state.prioritizeNumber, mount, state.targetCid, state.targetMeta ? Promise.resolve(state.targetMeta) : null),
            report: error => console.error('[Search view]', error)
        });
        root.addEventListener('popstate', event => root.SearchNavigation.onPopState(event));
    }
})(typeof window !== 'undefined' ? window : globalThis);
