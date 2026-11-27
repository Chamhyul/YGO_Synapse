/* 사진 편집·후보 선택의 표시 동작. 분석 상태와 등록은 PhotoCardSearch에서 관리한다. */
(function (root) {
    'use strict';

    const panels = new WeakMap();
    let nameSuggestions = null;

    function trackPhotoBackdrop(frame, layer, image, backdrop) {
        let featherFrame = 0;
        const updateFeather = () => {
            featherFrame = 0;
            const bounds = frame.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            const edges = image.getBoundingClientRect();
            const tolerance = 0.5;
            const clippedEdges = [
                edges.left <= bounds.left + tolerance && 'left',
                edges.right >= bounds.right - tolerance && 'right',
                edges.top <= bounds.top + tolerance && 'top',
                edges.bottom >= bounds.bottom - tolerance && 'bottom',
            ].filter(Boolean).join(' ');
            if (image.dataset.photoUiClippedEdges !== clippedEdges) {
                image.dataset.photoUiClippedEdges = clippedEdges;
            }
            if (layer.getAnimations().some(animation => animation.playState === 'running')) {
                featherFrame = requestAnimationFrame(updateFeather);
            }
        };
        const update = () => {
            const bounds = frame.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            const area = layer.parentElement.getBoundingClientRect();
            const imageWidth = area.width * parseFloat(layer.style.width) / 100;
            const imageHeight = area.height * parseFloat(layer.style.height) / 100;
            const x = area.left - bounds.left + area.width * parseFloat(layer.style.left) / 100
                + (parseFloat(getComputedStyle(layer).translate) || 0) + (imageWidth - bounds.width) / 2;
            const y = area.top - bounds.top + area.height * parseFloat(layer.style.top) / 100
                + (imageHeight - bounds.height) / 2;
            const zoom = Math.max(imageWidth / bounds.width, imageHeight / bounds.height);
            const scale = 1 + Math.min(.45, Math.max(0, zoom - 1) * .4);
            // Reserve room for the Gaussian blur at each frame edge after panning.
            const maxShift = (expanded, viewport) => Math.max(0, (expanded * scale - viewport) / 2 - 48 * scale);
            const limitX = maxShift(backdrop.offsetWidth, bounds.width);
            const limitY = maxShift(backdrop.offsetHeight, bounds.height);
            const panX = Math.max(-limitX, Math.min(limitX, x * .45));
            const panY = Math.max(-limitY, Math.min(limitY, y * .45));
            setBackdropTransform(backdrop, `translate(${panX}px, ${panY}px) scale(${scale})`);
            if (!featherFrame) updateFeather();
        };
        const position = new MutationObserver(update);
        position.observe(layer, { attributes: true, attributeFilter: ['style'] });
        const size = new ResizeObserver(update);
        size.observe(frame);
        update();
        return () => {
            position.disconnect();
            size.disconnect();
            cancelAnimationFrame(featherFrame);
        };
    }

    function arrangeRegionEditor(host, mobile) {
        const setup = host.querySelector('.photo-region-setup');
        if (setup?.querySelector('.photo-ui-region-tools')) return;
        const header = host.closest('.photo-search-sheet-panel')?.querySelector('.ui-overlay__header');
        const headerCount = header?.querySelector('.photo-ui-region-count');
        if (!setup) {
            headerCount?.remove();
            return;
        }
        const add = setup.querySelector('[data-add-region]');
        const editActions = host.querySelector('.photo-region-edit-overlay-actions');
        const showAll = editActions?.querySelector('[data-show-all]') ?? document.createElement('button');
        setup.classList.add('photo-ui-region-setup');
        const thumbnails = setup.querySelectorAll('.photo-region-thumb-item');
        for (const thumbnail of thumbnails) {
            thumbnail.classList.add('shape-rounded001');
            thumbnail.querySelector('.photo-region-thumb').classList.add('color-surface-001', 'border-basic');
            thumbnail.querySelector('.photo-region-thumb-remove').classList.add('color-surface-001', 'border-basic');
        }
        add.classList.add('color-surface-001', 'border-dashed', 'ui-control--disabled', 'color-disabled');
        const addLabel = add.querySelector('span');
        addLabel.textContent = '영역 추가';
        showAll.type = 'button';
        showAll.setAttribute('data-show-all', '');
        showAll.setAttribute('aria-label', '전체 보기');
        showAll.setAttribute('aria-pressed', String(!editActions));
        showAll.classList.add('photo-ui-region-overview', 'ui-button', 'shape-rounded003', 'border-basic',
            editActions ? 'color-type000' : 'color-type002');
        showAll.innerHTML = '<i class="material-icons" aria-hidden="true">grid_view</i><span>전체 보기</span>';
        const count = headerCount ?? document.createElement('p');
        count.className = 'photo-ui-region-count color-text-001';
        const countText = `총 ${thumbnails.length}장 확인`;
        if (count.textContent !== countText) count.textContent = countText;
        if (!headerCount) {
            if (header) header.querySelector('.photo-sheet-close').before(count);
            else setup.prepend(count);
        }
        const tools = document.createElement('div');
        tools.className = 'photo-ui-region-tools';
        if (mobile) {
            add.setAttribute('aria-label', addLabel.textContent);
            tools.append(showAll, add);
        } else {
            tools.append(add, showAll);
        }
        setup.append(tools);
        if (editActions) {
            const preview = host.querySelector('.photo-preview');
            showAll.addEventListener('click', () => {
                if (document.activeElement !== showAll) return;
                requestAnimationFrame(() => host.querySelector('.photo-ui-region-overview[aria-pressed="true"]')?.focus({ preventScroll: true }));
            }, { capture: true });
            const frame = document.createElement('div');
            frame.className = 'photo-preview photo-ui-edit-frame';
            preview.classList.add('photo-ui-drag-area');
            editActions.classList.add('photo-ui-region-edit-actions');
            for (const button of editActions.querySelectorAll('button')) {
                button.classList.add('ui-button', 'ui-control--disabled', 'color-disabled');
            }
            editActions.querySelector('[data-confirm-edit]').setAttribute('aria-label', '확인');
            preview.replaceWith(frame);
            frame.append(preview, editActions);
        }
    }

    function beforeRender(host) {
        const panel = panels.get(host);
        panel?.dispose();
        panels.delete(host);
        if (nameSuggestions && host.contains(nameSuggestions.input)) nameSuggestions.dispose();
        const backdrop = host.querySelector('.photo-ui-image-extension');
        return backdrop ? { backdrop, transform: getComputedStyle(backdrop).transform } : null;
    }

    function dispose(host) {
        if (!host) return;
        const previous = beforeRender(host);
        if (previous) releaseDesktopCardGeometry(previous.backdrop);
        releaseDesktopCardGeometry(host);
    }

    function mountBackdrop(host, previous) {
        const frame = host.querySelector('.photo-analysis-left .photo-preview');
        const layer = frame?.querySelector('.photo-image-layer');
        const image = layer?.querySelector('img');
        if (!image) return;
        const reuse = previous?.backdrop.src === image.src;
        const backdrop = reuse ? previous.backdrop : new Image();
        backdrop.className = 'photo-ui-image-extension is-positioning';
        if (!reuse) {
            backdrop.src = image.src;
            backdrop.alt = '';
            backdrop.draggable = false;
        } else {
            setBackdropTransform(backdrop, previous.transform);
        }
        image.classList.add('photo-ui-feathered-image');
        frame.prepend(backdrop);
        backdrop.getBoundingClientRect();
        backdrop.classList.remove('is-positioning');
        return trackPhotoBackdrop(frame, layer, image, backdrop);
    }

    function setBackdropTransform(backdrop, transform) {
        getDesktopCardGeometry(backdrop).transform = transform;
    }

    function afterRender(host, previous, { mobile, failed, busy, onFile }) {
        const upload = host.querySelector('.photo-upload-panel');
        if (upload && !mobile) {
            upload.querySelector('strong + span').textContent = '이미지를 이곳에 놓거나 파일을 선택하세요.';
            for (const type of ['dragover', 'dragleave', 'drop']) {
                upload.addEventListener(type, event => {
                    if (type === 'dragleave' && upload.contains(event.relatedTarget)) return;
                    event.preventDefault();
                    upload.classList.toggle('photo-ui-dragging', type === 'dragover');
                    if (type === 'drop' && event.dataTransfer.files[0]) onFile(event.dataTransfer.files[0]);
                });
            }
        }
        const loading = host.querySelector('.photo-detection-loading');
        if (busy && loading) {
            loading.querySelector('strong').textContent = '카드 후보를 찾고 있습니다';
            loading.querySelector('span').textContent = '선택한 카드 영역을 분석하고 있습니다.';
        }
        const footer = host.querySelector('.photo-analysis-actions');
        for (const button of footer?.querySelectorAll('.photo-analysis-action-button') ?? []) {
            button.classList.remove('photo-analysis-action-button');
            button.classList.add('ui-button', 'color-theme', 'shape-capsule', 'ui-control--disabled', 'color-disabled');
        }
        for (const button of footer?.querySelectorAll('.btn-flat') ?? []) {
            button.classList.remove('btn-flat');
            button.classList.add('ui-button', 'ui-button--text', 'color-text-001', 'shape-capsule');
        }
        if (mobile) footer?.classList.add('color-surface-001');
        if (failed && footer) {
            const analyze = footer.querySelector('[data-analyze]');
            if (analyze) analyze.textContent = '다시 분석';
            const message = document.createElement('p');
            message.className = 'photo-ui-error color-text-red';
            message.setAttribute('role', 'status');
            message.textContent = '카드 후보를 불러오지 못했습니다.';
            footer.prepend(message);
        }
        const finish = footer?.querySelector('[data-finish]');
        if (finish) finish.textContent = '추가';
        const stopBackdrop = mountBackdrop(host, previous);
        const preview = host.querySelector('.photo-analysis-left .photo-preview');
        const desktopSearch = host.id === 'desktop-photo-search-panel';
        const measure = () => {
            if (mobile || !host.isConnected || host.hidden) return;
            if (preview) {
                const height = Math.ceil(preview.getBoundingClientRect().height);
                if (height) getDesktopCardGeometry(host).setProperty('--photo-content-height', `${height}px`);
            }
            if (desktopSearch) {
                const height = Math.ceil(host.getBoundingClientRect().height);
                if (height) getDesktopCardGeometry(host.closest('#search-wrapper')).setProperty('--dropdown-height', `${height}px`);
            }
        };
        const resize = new ResizeObserver(measure);
        if (!mobile && preview) resize.observe(preview);
        if (desktopSearch) resize.observe(host);
        measure();
        panels.set(host, { dispose() {
            resize.disconnect();
            stopBackdrop?.();
        } });
        if (previous && !previous.backdrop.isConnected) releaseDesktopCardGeometry(previous.backdrop);
    }

    function button(icon, name, attribute) {
        const control = document.createElement('button');
        control.type = 'button';
        control.setAttribute(attribute, '');
        control.setAttribute('aria-label', name);
        const symbol = document.createElement('i');
        symbol.className = 'material-icons';
        symbol.setAttribute('aria-hidden', 'true');
        symbol.textContent = icon;
        control.append(symbol);
        return control;
    }

    function prepareCandidates(host, region, regions, mobile) {
        const panel = host.querySelector('.photo-candidate-content');
        const options = panel.querySelector('.photo-editor-content');
        const index = regions.indexOf(region);
        const last = index === regions.length - 1;
        const selected = region.selected;
        const rows = [...panel.querySelectorAll('.photo-candidate[data-candidate]')];
        for (const candidate of rows) {
            const name = region.candidates[Number(candidate.dataset.candidate)].cardName;
            candidate.setAttribute('aria-label', name);
            candidate.querySelector('small')?.remove();
            const score = candidate.querySelector('.photo-candidate-score');
            if (score) {
                score.className = 'photo-ui-candidate-name';
                score.textContent = name;
            }
        }
        if (!mobile) {
            const heading = panel.querySelector('.photo-candidate-heading');
            const navigation = document.createElement('div');
            navigation.className = 'photo-ui-navigation';
            navigation.setAttribute('role', 'group');
            navigation.setAttribute('aria-label', '카드 이동');
            const count = document.createElement('span');
            count.textContent = `${index + 1}/${regions.length}`;
            for (const control of heading.querySelectorAll('button')) navigation.append(control);
            navigation.insertBefore(count, navigation.querySelector('[data-region-next]'));
            host.querySelector('.photo-preview').append(navigation);
            heading.remove();
            options.classList.add('photo-ui-desktop-options');
            for (const candidate of options.querySelectorAll('.photo-candidate')) candidate.classList.add('border-basic');
            const manual = options.querySelector('[data-manual-name]');
            if (manual) {
                manual.parentElement.querySelector('small')?.remove();
                if (manual.readOnly) manual.tabIndex = -1;
                manual.classList.remove('photo-manual-name');
                manual.classList.add('browser-default', 'ui-input--filled', 'border-basic', 'shape-rounded003', 'color-type000');
            }
            for (const navigation of options.querySelectorAll('.photo-candidate-navigation')) {
                navigation.querySelector('[data-region-previous]')?.remove();
                if (last) navigation.remove();
                else navigation.classList.add('photo-ui-inner-next');
            }
        }
        if (region.status === 'manual' && selected?.cid) {
            const manual = options.querySelector('.photo-manual-candidate');
            const row = manual.closest('.photo-candidate-row');
            const result = document.createElement('div');
            result.className = 'photo-candidate photo-ui-manual-result selected border-basic';
            const artwork = document.createElement('span');
            artwork.className = 'photo-candidate-image';
            artwork.dataset.cid = selected.cid;
            if (selected.artworkSlot) artwork.dataset.ciid = selected.artworkSlot;
            const label = document.createElement('strong');
            label.className = mobile ? 'photo-ui-candidate-name' : '';
            label.textContent = selected.cardName;
            result.append(artwork, label);
            manual.replaceWith(result);
            const reset = button('refresh', '초기화', 'data-photo-reset-manual');
            reset.className = 'photo-ui-manual-reset';
            const navigation = mobile ? host.querySelector('.mobile-photo-footer-navigation')
                : row.querySelector('.photo-candidate-navigation') ?? document.createElement('span');
            if (!mobile) {
                navigation.className = 'photo-region-navigation photo-candidate-navigation photo-ui-inner-next';
                if (!navigation.isConnected) row.append(navigation);
            }
            navigation.insertBefore(reset, navigation.querySelector('[data-region-next]'));
        }
    }

    function bindManualName(input, onConfirm) {
        if (!input || input.readOnly) return;
        const dropdown = document.createElement('ul');
        dropdown.id = 'photo-ui-manual-suggestions';
        dropdown.className = 'global-dropdown custom-options desktop-card-dropdown border-basic color-surface-001 shape-rounded003 shadow-medium photo-ui-manual-name-dropdown';
        dropdown.dataset.cardSearchField = 'name';
        dropdown.setAttribute('role', 'listbox');
        dropdown.setAttribute('aria-label', '카드 이름 추천');
        document.body.append(dropdown);
        input.autocomplete = 'off';
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-label', '카드 이름');
        input.setAttribute('aria-controls', dropdown.id);
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        let request;
        let entries = [];
        let active = -1;
        const events = new AbortController();
        const options = { signal: events.signal };
        const position = () => {
            if (!dropdown.classList.contains('active')) return;
            const bounds = input.getBoundingClientRect();
            const below = bounds.bottom + 6;
            const height = Math.min(250, dropdown.scrollHeight + 2);
            const geometry = getDesktopCardGeometry(dropdown);
            geometry.top = `${below + height > innerHeight && bounds.top > height + 6 ? bounds.top - height - 6 : below}px`;
            geometry.left = `${bounds.left}px`;
            geometry.width = `${bounds.width}px`;
        };
        const hide = () => {
            request?.abort();
            active = -1;
            entries = [];
            dropdown.classList.remove('active');
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        };
        const choose = candidate => {
            hide();
            onConfirm(candidate);
        };
        const fetchNames = debounce(async query => {
            request = new AbortController();
            const { signal } = request;
            const isCurrent = () => !signal.aborted && input.isConnected
                && document.activeElement === input && input.value.trim() === query;
            let results;
            try {
                results = await root.AppBackend?.registrationSuggestions?.(query, 'name', signal) ?? [];
            } catch (_) {
                results = [];
            }
            if (!isCurrent()) return;
            entries = results.slice(0, 5);
            if (!entries.length) return;
            dropdown.replaceChildren(...entries.map((candidate, index) => {
                const item = document.createElement('li');
                item.id = `${dropdown.id}-${index}`;
                item.className = 'custom-option';
                item.textContent = candidate.value;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', 'false');
                item.onclick = () => choose(candidate);
                return item;
            }));
            dropdown.classList.add('active');
            input.setAttribute('aria-expanded', 'true');
            position();
        }, 100);
        const show = () => {
            hide();
            fetchNames.cancel();
            if (input.value.trim()) fetchNames(input.value.trim());
        };
        const close = () => { fetchNames.cancel(); hide(); };
        dropdown.addEventListener('mousedown', event => event.preventDefault(), options);
        input.addEventListener('input', show, options);
        input.addEventListener('focus', show, options);
        input.addEventListener('blur', close, options);
        input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && input.value.trim()) {
                event.preventDefault();
                event.stopPropagation();
                choose(entries[active] ?? entries.find(entry => entry.value === input.value.trim()) ?? { value: input.value.trim() });
            } else if (event.key === 'Escape' && entries.length) {
                event.preventDefault();
                event.stopPropagation();
                close();
            } else if (entries.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                active = active < 0 ? (event.key === 'ArrowDown' ? 0 : entries.length - 1)
                    : (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
                [...dropdown.children].forEach((item, index) => {
                    item.classList.toggle('selected', index === active);
                    item.setAttribute('aria-selected', String(index === active));
                });
                input.setAttribute('aria-activedescendant', dropdown.children[active].id);
                dropdown.children[active].scrollIntoView({ block: 'nearest' });
            }
        }, options);
        root.addEventListener('resize', position, options);
        document.addEventListener('scroll', position, { ...options, capture: true });
        nameSuggestions = { input, dispose() {
            close();
            events.abort();
            releaseDesktopCardGeometry(dropdown);
            dropdown.remove();
            nameSuggestions = null;
        } };
        if (document.activeElement === input) show();
    }

    root.PhotoCardUI = { beforeRender, afterRender, dispose, arrangeRegionEditor, prepareCandidates, bindManualName };
})(globalThis);
