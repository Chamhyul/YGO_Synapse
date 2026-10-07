/* 공통 외곽의 표시만 담당한다. 값 확정·취소와 기존 잠금/초점 수명주기는 호출자가 소유한다. */
(function (root) {
    'use strict';
    const transitions = new WeakMap();
    const popups = new Map();
    const panelSizes = new Map();

    // 열린 모달·시트의 내용 변경을 관찰한다. 높이 전환은 표시 수명주기와 별개다.
    function panelRect(panel) {
        if (panel.isConnected === false || panel.closest('[hidden], [inert], [aria-hidden="true"]')) {
            return { height: 0, width: 0 };
        }
        return panel.getBoundingClientRect();
    }

    function stopHeightTransition(state) {
        const animation = state.animation;
        state.animation = null;
        animation?.cancel();
    }

    function syncPanelHeight(panel, immediate = false) {
        const state = panelSizes.get(panel);
        if (!state) return;
        const visible = panelRect(panel);
        const from = state.animation ? visible.height : state.height;
        stopHeightTransition(state);
        const next = panelRect(panel);
        const widthChanged = Math.abs(state.width - next.width) > 1;
        state.height = next.height;
        state.width = next.width;
        const time = duration();
        if (immediate || !panel.matches('.ui-overlay--modal, .ui-overlay--sheet') ||
            transitions.has(panel) || widthChanged || !from || !next.height ||
            Math.abs(from - next.height) < 1 || !panel.animate || !time) return;
        const animation = panel.animate([
            { height: `${from}px` }, { height: `${next.height}px` }
        ], { duration: time, easing: 'ease' });
        state.animation = animation;
        animation.finished.then(() => {
            if (state.animation !== animation) return;
            state.animation = null;
            state.height = panelRect(panel).height;
        }, () => {});
    }

    function observePanelSizes() {
        if (!root.ResizeObserver || !root.MutationObserver) return;
        const selector = '.ui-overlay__panel';
        const resize = new root.ResizeObserver(entries => {
            for (const { target } of entries) {
                const state = panelSizes.get(target);
                // 전환 중간 크기를 새 자연 높이로 처리하지 않는다.
                if (state && !state.animation) syncPanelHeight(target);
            }
        });
        const register = panel => {
            if (panelSizes.has(panel) || !panel.matches('.ui-overlay--modal, .ui-overlay--sheet')) return;
            const rect = panelRect(panel);
            panelSizes.set(panel, { height: rect.height, width: rect.width, animation: null });
            resize.observe(panel);
        };
        document.querySelectorAll(selector).forEach(register);
        const mutations = new root.MutationObserver(records => {
            const changed = new Set();
            for (const record of records) {
                const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
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
        for (const [panel, trigger] of popups) {
            if (panel.isConnected === false) {
                stopTransition(panel);
                popups.delete(panel);
            } else placePopup(panel, trigger);
        }
    }

    function stopTransition(panel) {
        const previous = transitions.get(panel);
        transitions.delete(panel);
        previous?.animations.forEach(animation => animation.cancel());
        if (previous?.timer) clearTimeout(previous.timer);
    }

    function animate(panel, backdrop, opening, complete) {
        stopTransition(panel);
        syncPanelHeight(panel, true);
        const state = { animations: [], timer: null };
        transitions.set(panel, state);
        const finish = () => {
            if (transitions.get(panel) !== state) return;
            transitions.delete(panel);
            if (!opening) panel.style.display = 'none';
            state.animations.forEach(animation => animation.cancel());
            panel.style.opacity = opening ? '1' : '0';
            if (backdrop) backdrop.style.opacity = opening ? '0.4' : '0';
            syncPanelHeight(panel, true);
            complete();
        };
        const time = duration();
        const sheet = panel.classList.contains('ui-overlay--sheet');
        const moved = sheet ? 'translateY(100%)' : 'translateY(-8px)';
        if (panel.animate && time) {
            const current = getComputedStyle(panel);
            const from = { opacity: current.opacity, transform: current.transform };
            const to = { opacity: opening ? 1 : 0, transform: opening ? 'translateY(0)' : moved };
            state.animations.push(panel.animate([opening ? { opacity: 0, transform: moved } : from, to],
                { duration: time, easing: 'ease', fill: 'forwards' }));
            if (backdrop) state.animations.push(backdrop.animate(
                [{ opacity: opening ? 0 : getComputedStyle(backdrop).opacity }, { opacity: opening ? 0.4 : 0 }],
                { duration: time, easing: 'ease', fill: 'forwards' }));
            Promise.all(state.animations.map(animation => animation.finished)).then(finish, () => {});
        } else if (time) state.timer = setTimeout(finish, time);
        else finish();
    }

    function installModal(instance) {
        if (!instance || !instance.el.classList.contains('ui-overlay') || instance._commonOverlayInstalled) return;
        instance._commonOverlayInstalled = true;
        const backdrop = instance.$overlay[0];
        backdrop.classList.add('ui-overlay__backdrop', 'color-surface-black');
        instance.options.preventScrolling = false; // 기존 공통 수명주기가 중첩 창의 잠금을 소유한다.
        instance._animateIn = function () {
            const sheet = document.documentElement.classList.contains('is-mobile-device');
            this.el.classList.toggle('ui-overlay--sheet', sheet);
            this.el.classList.toggle('ui-overlay--modal', !sheet);
            this.el.classList.toggle('shadow-mobile-sheet', sheet);
            this.el.classList.toggle('shadow-modal', !sheet);
            syncViewport();
            this.el.style.display = 'flex';
            this.el.style.removeProperty('top');
            this.el.style.removeProperty('bottom');
            this.el.style.removeProperty('transform');
            backdrop.style.display = 'block';
            backdrop.style.pointerEvents = 'auto';
            animate(this.el, backdrop, true, () => this.options.onOpenEnd?.call(this, this.el));
        };
        instance._animateOut = function () {
            animate(this.el, backdrop, false, () => {
                this.$overlay.remove();
                this.options.onCloseEnd?.call(this, this.el);
            });
        };
    }

    function placePopup(panel, trigger) {
        const viewTop = root.visualViewport?.offsetTop || 0;
        const viewHeight = root.visualViewport?.height || root.innerHeight;
        const viewLeft = root.visualViewport?.offsetLeft || 0;
        const viewWidth = root.visualViewport?.width || root.innerWidth;
        const rect = trigger?.getBoundingClientRect();
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const left = Math.max(viewLeft + 16, Math.min(rect?.left ?? viewLeft + (viewWidth - width) / 2, viewLeft + viewWidth - width - 16));
        const preferred = rect ? rect.bottom + 8 : viewTop + (viewHeight - height) / 2;
        const above = rect ? rect.top - height - 8 : preferred;
        const top = Math.max(viewTop + 16, Math.min(preferred + height <= viewTop + viewHeight - 16 ? preferred : above, viewTop + viewHeight - height - 16));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }

    function openPopup(panel, trigger) {
        stopTransition(panel);
        popups.set(panel, trigger);
        panel.hidden = false;
        panel.inert = false;
        panel.style.removeProperty('display');
        placePopup(panel, trigger);
        animate(panel, null, true, () => {});
    }

    function closePopup(panel, onClose) {
        popups.delete(panel);
        panel.inert = true;
        animate(panel, null, false, () => { panel.hidden = true; onClose?.(); });
    }

    root.AppOverlays = { duration, installModal, openPopup, closePopup, placePopup };
    root.addEventListener('resize', syncViewport);
    root.addEventListener('scroll', syncViewport, true);
    root.visualViewport?.addEventListener('resize', syncViewport);
    root.visualViewport?.addEventListener('scroll', syncViewport);
    syncViewport();
    observePanelSizes();
})(window);
