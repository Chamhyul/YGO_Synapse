/* 공통 외곽의 표시만 담당한다. 값 확정·취소와 기존 잠금/초점 수명주기는 호출자가 소유한다. */
(function (root) {
    'use strict';
    const transitions = new WeakMap();
    const popups = new Map();
    const panelSizes = new Map();
    const resizingPopups = new WeakSet();
    const rowEntrances = new WeakMap();
    const pendingRowEntrances = new Map();
    const rowExits = new WeakSet();
    let rowScroll = null;

    // 모달·시트와 높이 전환을 요청한 콘텐츠 외곽의 크기를 관찰한다.
    function canAnimateHeight(panel) {
        return panel.matches('.ui-overlay--modal, .ui-overlay--sheet, [data-animate-height]') || resizingPopups.has(panel);
    }

    function panelRect(panel) {
        if (panel.isConnected === false || panel.closest('[hidden], [inert], [aria-hidden="true"]')) {
            return { height: 0, width: 0 };
        }
        return panel.getBoundingClientRect();
    }

    function outlineFrame(element) {
        const { top, right, left, height } = getComputedStyle(element);
        return { top, right, left, height };
    }

    function stopHeightTransition(state) {
        const animation = state.animation;
        state.animation = null;
        animation?.cancel();
        if (state.row?.animation) {
            state.row.animation.cancel();
            state.row.animation = null;
        }
        if (state.outline?.animation) {
            state.outline.animation.cancel();
            state.outline.animation = null;
        }
        if (state.outline?.targetAnimation) {
            state.outline.targetAnimation.cancel();
            state.outline.targetAnimation = null;
        }
    }

    function syncPanelHeight(panel, immediate = false) {
        const state = panelSizes.get(panel);
        if (!state) return;
        const visible = panelRect(panel);
        const from = state.animation ? visible.height : state.height;
        const row = state.row;
        const fromRow = row?.animation ? row.element.getBoundingClientRect().height : row?.height;
        const outline = state.outline;
        const fromOutline = outline?.animation ? outlineFrame(outline.element) : outline?.frame;
        const fromTargetHeight = outline?.targetAnimation
            ? outline.target.getBoundingClientRect().height : outline?.targetHeight;
        stopHeightTransition(state);
        const next = panelRect(panel);
        const nextRow = row?.element.getBoundingClientRect().height;
        const rowChanged = row?.element.animate && Math.abs(fromRow - nextRow) >= 1;
        const widthChanged = Math.abs(state.width - next.width) > 1;
        state.height = next.height;
        state.width = next.width;
        if (row) row.height = nextRow;
        if (outline) {
            outline.targetHeight = outline.target.getBoundingClientRect().height;
            const targetSize = `${outline.targetHeight}px`;
            if (outline.element.style.getPropertyValue('--height-outline-target-size') !== targetSize) {
                outline.element.style.setProperty('--height-outline-target-size', targetSize);
            }
            outline.frame = outlineFrame(outline.element);
        }
        const outlineChanged = fromOutline && Object.keys(fromOutline).some(key => fromOutline[key] !== outline.frame[key]);
        const targetChanged = outline && Math.abs(fromTargetHeight - outline.targetHeight) >= 1;
        const time = duration();
        if (immediate || !canAnimateHeight(panel) ||
            transitions.has(panel) || widthChanged || !from || !next.height ||
            (Math.abs(from - next.height) < 1 && !rowChanged && !outlineChanged && !targetChanged) || !panel.animate || !time) return;
        const timing = { duration: time, easing: 'ease' };
        const animation = panel.animate([
            { height: `${from}px` }, { height: `${next.height}px` }
        ], timing);
        state.animation = animation;
        if (rowChanged) {
            row.animation = row.element.animate([
                { height: `${fromRow}px` }, { height: `${nextRow}px` }
            ], timing);
            row.animation.finished.catch(() => {});
        }
        if (outlineChanged) {
            outline.animation = outline.element.animate([fromOutline, outline.frame], timing);
            outline.animation.finished.catch(() => {});
        }
        if (targetChanged) {
            // 버튼의 새 최소 높이가 전환 중간의 높이를 제한하지 않게 한다.
            outline.targetAnimation = outline.target.animate([
                { height: `${fromTargetHeight}px`, minHeight: '0px' },
                { height: `${outline.targetHeight}px`, minHeight: '0px' }
            ], timing);
            outline.targetAnimation.finished.catch(() => {});
        }
        animation.finished.then(() => {
            if (state.animation !== animation) return;
            state.animation = null;
            state.height = panelRect(panel).height;
            if (row) row.animation = null;
            if (outline) {
                outline.animation = null;
                outline.targetAnimation = null;
            }
        }, () => {});
    }

    function observePanelSizes() {
        if (!root.ResizeObserver || !root.MutationObserver) return;
        const selector = '.ui-overlay__panel, [data-animate-height]';
        const resize = new root.ResizeObserver(entries => {
            for (const { target } of entries) {
                const state = panelSizes.get(target);
                // 전환 중간 크기를 새 자연 높이로 처리하지 않는다.
                if (state && !state.animation) syncPanelHeight(target);
            }
        });
        const register = panel => {
            if (panelSizes.has(panel) || !canAnimateHeight(panel)) return;
            const rect = panelRect(panel);
            const row = panel.matches('[data-animate-height]') && panel.querySelector('[data-animate-height-row]');
            const outline = row && panel.querySelector('[data-animate-height-outline]');
            const outlineTarget = outline && row.querySelector('[data-animate-height-outline-target]');
            panelSizes.set(panel, {
                height: rect.height, width: rect.width, animation: null,
                row: row ? { element: row, height: row.getBoundingClientRect().height, animation: null } : null,
                outline: outlineTarget ? {
                    element: outline, frame: outlineFrame(outline), animation: null,
                    target: outlineTarget, targetHeight: outlineTarget.getBoundingClientRect().height, targetAnimation: null,
                } : null,
            });
            resize.observe(panel);
        };
        document.querySelectorAll(selector).forEach(register);
        const mutations = new root.MutationObserver(records => {
            const changed = new Set();
            for (const record of records) {
                const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                // 장식용 외곽선의 측정값은 콘텐츠 높이를 바꾸지 않는다.
                if (record.attributeName === 'style' && target?.hasAttribute('data-animate-height-outline')) continue;
                const panel = target?.closest(selector);
                if (panel) { register(panel); changed.add(panel); }
                if (record.type === 'childList') {
                    record.addedNodes.forEach(node => {
                        if (node.nodeType !== 1) return;
                        if (node.matches(selector)) register(node);
                        node.querySelectorAll(selector).forEach(register);
                    });
                }
                // 시트 상위 루트의 display·inert 변경도 최초 표시/종료로 처리한다.
                if (record.type === 'attributes') {
                    for (const tracked of panelSizes.keys()) {
                        if (target?.contains(tracked)) changed.add(tracked);
                    }
                }
            }
            for (const [panel, state] of panelSizes) {
                if (panel.isConnected === false) {
                    stopHeightTransition(state);
                    resize.unobserve(panel);
                    panelSizes.delete(panel);
                }
            }
            changed.forEach(panel => syncPanelHeight(panel));
        });
        mutations.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] });
        document.addEventListener('load', event => {
            const panel = event.target.closest?.(selector);
            if (panel) syncPanelHeight(panel);
        }, true);
    }

    function duration() {
        return root.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
    }

    function followRowLayout() {
        const { scroller, lists } = rowScroll;
        let delta = 0;
        for (const [list, state] of lists) {
            if (!list.getClientRects().length || list.closest('.mode-form[inert], #app-page-manage:not(.active)')) {
                lists.delete(list);
                continue;
            }
            const height = list.getBoundingClientRect().height;
            delta += height - state.height;
            state.height = height;
            if (!state.animations.size) lists.delete(list);
        }
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const actual = scroller.scrollTop;
        // 브라우저가 문서 끝에서 먼저 스크롤을 제한한 경우 같은 감소량을 중복 적용하지 않는다.
        const from = actual === Math.min(rowScroll.actual, max) ? rowScroll.target : actual;
        rowScroll.target = Math.max(0, Math.min(max, from + delta));
        if (delta) scroller.scrollTop = rowScroll.target;
        rowScroll.actual = scroller.scrollTop;

        if (lists.size) root.requestAnimationFrame(followRowLayout);
        else {
            scroller.classList.remove('is-following-row-motion');
            rowScroll = null;
        }
    }

    function trackRowLayout(list, animation) {
        const scroller = document.scrollingElement;
        if (!list || !scroller || !root.requestAnimationFrame) return;
        if (!rowScroll) {
            const top = scroller.scrollTop;
            rowScroll = { scroller, target: top, actual: top, lists: new Map() };
            scroller.classList.add('is-following-row-motion');
            root.requestAnimationFrame(followRowLayout);
        }
        const lists = rowScroll.lists;
        if (!lists.has(list)) lists.set(list, { height: list.getBoundingClientRect().height, animations: new Set() });
        const { animations } = lists.get(list);
        animations.add(animation);
        const stop = () => animations.delete(animation);
        animation.finished.then(stop, stop);
    }

    const collapsedRowFrame = { minHeight: '0px', height: '0px', paddingBlockStart: '0px', paddingBlockEnd: '0px', opacity: 0, overflow: 'clip' };

    function rowFrame(row) {
        const { paddingBlockStart, paddingBlockEnd, opacity } = getComputedStyle(row);
        return {
            minHeight: '0px', height: `${row.getBoundingClientRect().height}px`,
            paddingBlockStart, paddingBlockEnd, opacity, overflow: 'clip',
        };
    }

    function startRowEntrances() {
        const time = duration();
        const measured = [];
        // 묶음 추가의 행 높이를 한 번에 읽고, 전환은 같은 프레임에 시작한다.
        for (const [row, state] of pendingRowEntrances) {
            if (!time || !row.getClientRects().length) {
                rowEntrances.delete(row);
                continue;
            }
            measured.push({ row, state, frame: rowFrame(row) });
        }
        pendingRowEntrances.clear();

        const timing = { duration: time, easing: 'ease' };
        for (const { row, state, frame } of measured) {
            const animation = row.animate([collapsedRowFrame, frame], timing);
            if (state.startTime !== null) animation.startTime = state.startTime;
            state.animation = animation;
            const clear = () => rowEntrances.delete(row);
            animation.finished.then(clear, clear);
        }
        for (const { row, state } of measured) trackRowLayout(row.parentElement, state.animation);
    }

    function animateRowEntrance(row, previousRow) {
        if (!row?.animate || rowEntrances.has(row)) return;
        const previous = rowEntrances.get(previousRow);
        if (previousRow && !previous) return;
        // 같은 목록을 다시 그리면 이미 시작한 행의 전환을 이어간다.
        const startTime = previous?.animation?.startTime ?? previous?.startTime ?? null;
        const state = { startTime, animation: null };
        rowEntrances.set(row, state);
        pendingRowEntrances.set(row, state);
        if (pendingRowEntrances.size === 1) queueMicrotask(startRowEntrances);
    }

    function animateRowExit(row) {
        const time = duration();
        if (pendingRowEntrances.delete(row)) {
            rowEntrances.delete(row);
            return false;
        }
        if (!time || !row.animate || !row.getClientRects().length) return false;
        const frame = rowFrame(row);
        rowEntrances.get(row)?.animation?.cancel();
        // 삭제된 행은 화면에서 줄어드는 동안에도 입력 목록의 집계와 탐색에서 제외한다.
        row.removeAttribute('data-index');
        row.inert = true;
        rowExits.add(row);
        const animation = row.animate([frame, collapsedRowFrame], { duration: time, easing: 'ease', fill: 'forwards' });
        trackRowLayout(row.parentElement, animation);
        const remove = () => {
            rowExits.delete(row);
            row.remove();
        };
        animation.finished.then(remove, remove);
        return true;
    }

    function restoreRowExits(list, previousChildren) {
        if (!previousChildren) return;
        const rows = [...list.children];
        let index = 0;
        for (const child of previousChildren) {
            if (child.hasAttribute('data-index')) index++;
            else if (rowExits.has(child)) list.insertBefore(child, rows[index] ?? null);
        }
    }

    async function waitForHeightTransition(panel) {
        // 호출자가 바꾼 레이아웃을 관찰자가 높이 전환에 반영할 때까지 기다린다.
        await Promise.resolve();
        let previous;
        let animation = panelSizes.get(panel)?.animation;
        while (animation && animation !== previous) {
            await animation.finished.catch(() => {});
            previous = animation;
            animation = panelSizes.get(panel)?.animation;
        }
    }

    function syncViewport() {
        const viewport = root.visualViewport;
        const style = document.documentElement.style;
        const height = `${viewport?.height || root.innerHeight}px`;
        const top = `${viewport?.offsetTop || 0}px`;
        if (style.getPropertyValue?.('--overlay-viewport-height') !== height) {
            style.setProperty('--overlay-viewport-height', height);
        }
        if (style.getPropertyValue?.('--overlay-viewport-top') !== top) {
            style.setProperty('--overlay-viewport-top', top);
        }
        for (const [panel, { trigger, options }] of popups) {
            if (panel.isConnected === false) {
                stopTransition(panel);
                popups.delete(panel);
            } else placePopup(panel, trigger, options);
        }
    }

    function stopTransition(panel) {
        const previous = transitions.get(panel);
        transitions.delete(panel);
        previous?.animations.forEach(animation => animation.cancel());
        if (previous?.timer) clearTimeout(previous.timer);
    }

    function animate(panel, backdrop, opening, { hide, complete } = {}) {
        const backdropFrom = backdrop && !opening ? Number(getComputedStyle(backdrop).opacity) : 0;
        const targetOpacity = opening ? 1 : 0;
        stopTransition(panel);
        syncPanelHeight(panel, true);
        const state = { animations: [], timer: null };
        transitions.set(panel, state);
        const finish = () => {
            if (transitions.get(panel) !== state) return;
            transitions.delete(panel);
            if (!opening) hide?.();
            backdrop?.classList.toggle('active', opening);
            state.animations.forEach(animation => animation.cancel());
            syncPanelHeight(panel, true);
            complete?.();
        };
        const time = duration();
        const sheet = panel.classList.contains('ui-overlay--sheet');
        const moved = sheet ? 'translateY(100%)' : 'translateY(-8px)';
        if (panel.animate && time) {
            const current = getComputedStyle(panel);
            const from = { opacity: current.opacity, transform: current.transform };
            const to = { opacity: targetOpacity, transform: opening ? 'translateY(0)' : moved };
            state.animations.push(panel.animate([opening ? { opacity: 0, transform: moved } : from, to],
                { duration: time, easing: 'ease', fill: 'forwards' }));
            if (backdrop) state.animations.push(backdrop.animate(
                [{ opacity: backdropFrom }, { opacity: targetOpacity }],
                { duration: time, easing: 'ease', fill: 'forwards' }));
            Promise.all(state.animations.map(animation => animation.finished)).then(finish, () => {});
        } else if (time) state.timer = setTimeout(finish, time);
        else finish();
    }

    function installModal(instance) {
        if (!instance || !instance.el.classList.contains('ui-overlay') || instance._commonOverlayInstalled) return;
        instance._commonOverlayInstalled = true;
        const backdrop = instance.$overlay[0];
        backdrop.classList.add('ui-overlay__backdrop', 'color-backdrop-navi');
        instance.options.preventScrolling = false; // 기존 공통 수명주기가 중첩 창의 잠금을 소유한다.
        instance._animateIn = function () {
            const sheet = document.documentElement.classList.contains('is-mobile-device');
            this.el.classList.toggle('ui-overlay--sheet', sheet);
            this.el.classList.toggle('ui-overlay--modal', !sheet);
            this.el.classList.toggle('shadow-mobile-sheet', sheet);
            this.el.classList.toggle('shadow-modal', !sheet);
            syncViewport();
            this.el.hidden = false;
            this.el.style.removeProperty('top');
            this.el.style.removeProperty('bottom');
            this.el.style.removeProperty('transform');
            animate(this.el, backdrop, true, { complete: () => this.options.onOpenEnd?.call(this, this.el) });
        };
        instance._animateOut = function () {
            animate(this.el, backdrop, false, {
                hide: () => { this.el.hidden = true; },
                complete: () => {
                    this.$overlay.remove();
                    this.options.onCloseEnd?.call(this, this.el);
                },
            });
        };
    }

    function placePopup(panel, trigger, options = {}) {
        const viewTop = root.visualViewport?.offsetTop || 0;
        const viewHeight = root.visualViewport?.height || root.innerHeight;
        const viewLeft = root.visualViewport?.offsetLeft || 0;
        const viewWidth = root.visualViewport?.width || root.innerWidth;
        const rect = (options.anchorElement ?? trigger)?.getBoundingClientRect();
        const gap = options.gap ?? 8;
        const bottom = viewTop + viewHeight - 16;
        if (options.fitBelow && rect) {
            panel.style.removeProperty('--overlay-popup-available-height');
            const availableBelow = Math.floor(bottom - rect.bottom - gap);
            if (availableBelow >= Math.min(220, panel.offsetHeight)) {
                panel.style.setProperty('--overlay-popup-available-height', `${availableBelow}px`);
            }
        }
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const center = options.centerElement?.getBoundingClientRect();
        const preferredLeft = center ? center.left + (center.width - width) / 2 : rect?.left ?? viewLeft + (viewWidth - width) / 2;
        const left = Math.max(viewLeft + 16, Math.min(preferredLeft, viewLeft + viewWidth - width - 16));
        const preferred = rect ? rect.bottom + gap : viewTop + (viewHeight - height) / 2;
        const above = rect ? rect.top - height - gap : preferred;
        const top = Math.max(viewTop + 16, Math.min(preferred + height <= bottom ? preferred : above, bottom - height));
        let originLeft = 0, originTop = 0;
        if (center) {
            // 변환된 조상 안의 fixed 좌표를 뷰포트 좌표와 구분한다.
            for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (style.transform && style.transform !== 'none') {
                    const origin = parent.getBoundingClientRect();
                    originLeft = origin.left + parent.clientLeft - parent.scrollLeft;
                    originTop = origin.top + parent.clientTop - parent.scrollTop;
                    break;
                }
            }
        }
        panel.style.left = `${left - originLeft}px`;
        panel.style.top = `${top - originTop}px`;
    }

    function openPopup(panel, trigger, options = {}) {
        stopTransition(panel);
        popups.set(panel, { trigger, options });
        panel.hidden = false;
        panel.inert = false;
        placePopup(panel, trigger, options);
        animate(panel, null, true);
    }

    function closePopup(panel, onClose) {
        popups.delete(panel);
        panel.inert = true;
        animate(panel, null, false, {
            hide: () => { panel.hidden = true; },
            complete: onClose,
        });
    }

    // 내용 교체를 요청한 팝업만 모달·시트와 같은 높이 전환을 사용한다.
    function updatePopup(panel, update, trigger) {
        resizingPopups.add(panel);
        if (!panelSizes.has(panel)) {
            const rect = panelRect(panel);
            panelSizes.set(panel, { height:rect.height, width:rect.width, animation:null });
        }
        if (trigger !== undefined) popups.set(panel, { trigger, options: popups.get(panel)?.options || {} });
        update();
        syncPanelHeight(panel);
    }

    root.AppOverlays = {
        duration, installModal, openPopup, closePopup, placePopup, updatePopup, waitForHeightTransition,
        animateRowEntrance, animateRowExit, restoreRowExits,
    };
    root.addEventListener('resize', syncViewport);
    root.addEventListener('scroll', syncViewport, true);
    root.visualViewport?.addEventListener('resize', syncViewport);
    root.visualViewport?.addEventListener('scroll', syncViewport);
    syncViewport();
    observePanelSizes();
})(window);
