/* Shared image selector. Values belong to the caller; labels never replace them. */
(function () {
    'use strict';
    let active = null;
    let returningHistory = false;

    function close(fromHistory = false, restoreFocus = true) {
        if (!active) return;
        const state = active;
        active = null;
        state.observer.disconnect();
        state.root.remove();
        state.anchor.setAttribute('aria-expanded', 'false');
        window.removeEventListener('resize', state.position);
        window.removeEventListener('scroll', state.position, true);
        window.visualViewport?.removeEventListener('resize', state.position);
        if (state.mobile && !fromHistory && history.state?.illustrationPicker) {
            returningHistory = true;
            history.back();
        }
        if (restoreFocus && state.anchor.isConnected) state.anchor.focus({ preventScroll: true });
    }

    window.addEventListener('popstate', event => {
        if (returningHistory) {
            returningHistory = false;
            event.stopImmediatePropagation();
        } else if (active?.mobile) {
            close(true);
            event.stopImmediatePropagation();
        }
    }, true);

    function open({ anchor, cid, options, value, onSelect, mobile = false }) {
        if (options.length < 2 || returningHistory) return;
        if (active?.anchor === anchor) return;
        close(false, false);
        const root = document.createElement('div');
        root.className = mobile ? 'illustration-picker-root is-sheet' : 'illustration-picker-root';
        const panel = document.createElement('section');
        panel.className = 'illustration-picker-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '일러스트 선택');
        if (mobile) panel.setAttribute('aria-modal', 'true');
        const header = document.createElement('div');
        header.className = 'illustration-picker-header';
        const title = document.createElement('strong');
        title.textContent = '일러스트 선택';
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'illustration-picker-close';
        dismiss.textContent = '닫기';
        dismiss.onclick = () => close();
        header.append(title, dismiss);
        const grid = document.createElement('div');
        grid.className = 'illustration-picker-grid';
        panel.append(header, grid);
        root.append(panel);
        const state = { root, anchor, mobile };
        active = state;
        const buttons = options.map(opt => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'illustration-picker-option';
            const label = IllustrationImages.label(opt.val) || opt.text;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-pressed', String(IllustrationImages.ciidValue(opt.val) === IllustrationImages.ciidValue(value)));
            const preview = document.createElement('span');
            preview.className = 'illustration-picker-preview';
            preview.textContent = '불러오는 중…';
            const caption = document.createElement('span');
            caption.className = 'illustration-picker-caption';
            caption.textContent = label;
            button.append(preview, caption);
            button.onclick = () => {
                close();
                onSelect(opt);
            };
            grid.append(button);
            IllustrationImages.preload(cid, opt.val).then(result => {
                if (active !== state) return;
                if (result.status !== 'loaded') {
                    preview.textContent = '이미지 없음';
                    return;
                }
                const image = document.createElement('img');
                image.alt = '';
                image.src = result.url;
                image.onerror = () => { preview.textContent = '이미지 없음'; };
                preview.replaceChildren(image);
            });
            return button;
        });
        state.position = () => {
            if (!anchor.isConnected || !anchor.getClientRects().length) return close(false, false);
            const viewport = window.visualViewport;
            const width = viewport?.width || window.innerWidth;
            const height = viewport?.height || window.innerHeight;
            if (mobile) {
                panel.style.maxHeight = `${height * 0.85}px`;
            } else {
                const rect = anchor.getBoundingClientRect();
                const panelWidth = Math.min(560, width - 24, Math.min(options.length, 4) * 132 + 32);
                panel.style.width = `${panelWidth}px`;
                panel.style.left = `${Math.max(12, Math.min(rect.left, width - panelWidth - 12))}px`;
                panel.style.top = `${rect.bottom + 6}px`;
                panel.style.maxHeight = `${Math.max(60, height - rect.bottom - 18)}px`;
            }
            const columns = Math.max(1, Math.min(4, options.length, Math.floor((grid.clientWidth + 10) / 120)));
            grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        };
        // Closing/removing/resetting a row must invalidate the visible selector.
        const wrapper = anchor.closest('.custom-select-wrapper');
        state.observer = new MutationObserver(records => {
            if (!anchor.isConnected || records.some(record => record.target === wrapper)) close(false, false);
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
        if (wrapper) state.observer.observe(wrapper, { attributes: true, attributeFilter: ['data-options'] });
        document.body.append(root);
        if (mobile) history.pushState({ ...history.state, illustrationPicker: true }, '');
        anchor.setAttribute('aria-expanded', 'true');
        state.position();
        window.addEventListener('resize', state.position);
        window.addEventListener('scroll', state.position, true);
        window.visualViewport?.addEventListener('resize', state.position);
        root.addEventListener('click', event => { if (event.target === root) close(); });
        panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); close(); return;
            }
            const index = buttons.indexOf(document.activeElement);
            const columns = grid.style.gridTemplateColumns.match(/repeat\((\d+)/)?.[1] || 1;
            const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: Number(columns), ArrowUp: -Number(columns) }[event.key];
            if (step && index >= 0) {
                event.preventDefault();
                buttons[(index + step + buttons.length) % buttons.length].focus();
            }
            if (event.key === 'Tab') {
                const controls = [dismiss, ...buttons];
                const current = controls.indexOf(document.activeElement);
                if (event.shiftKey && current === 0) { event.preventDefault(); controls.at(-1).focus(); }
                else if (!event.shiftKey && current === controls.length - 1) { event.preventDefault(); dismiss.focus(); }
            }
        });
        (buttons.find(button => button.getAttribute('aria-pressed') === 'true') || buttons[0]).focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', event => {
        if (active && !active.mobile && !active.root.contains(event.target) && !active.anchor.closest('.custom-select-wrapper')?.contains(event.target)) close(false, false);
    }, true);
    window.IllustrationPicker = { open, close };
})();
