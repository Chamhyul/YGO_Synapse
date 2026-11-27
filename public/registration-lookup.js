(() => {
    'use strict';

    const sheet = document.getElementById('registration-lookup-sheet');
    if (!sheet) return;

    const backdrop = sheet.querySelector('.ui-overlay__backdrop');
    const sheetPanel = sheet.querySelector('.ui-overlay__panel');
    const lookupTemplate = document.getElementById('registration-lookup-controls');
    const inlineViewport = document.getElementById('manage-registration-inline');
    const inlineWorkspace = inlineViewport?.parentElement;
    const inlineContainer = inlineViewport?.closest('.manage-registration-add');
    const inlineAddButton = inlineContainer?.querySelector('.manage-registration-add__input-row > button');
    const inlineTemplate = document.getElementById('manage-registration-inline-template');
    const title = sheet.querySelector('h2');
    const titles = { photo: '사진 등록', pack: '팩 검색', deck: '덱코드' };
    const paneOrder = Object.keys(titles);
    const panes = new Map();
    let active = null;
    let inline = null;
    let leaving = null;

    function abortLookup() {
        const session = active;
        active = null;
        session.view.closePackSuggestions?.();
        session.controller.abort();
    }

    function close() {
        if (!active) return;
        if (active.inline) {
            closeInline();
            return;
        }
        if (active.packTrigger) closePackLookupInput();
        abortLookup();
        closeManagedSheet(sheet, { backdrop });
    }

    function slidePane(pane, from, to, onFinish) {
        pane.slide?.cancel();
        pane.slide = null;
        const duration = window.AppOverlays?.duration() || 0;
        if (!duration || !pane.panel.animate) {
            onFinish?.();
            return;
        }
        const animation = pane.panel.animate([{ transform: from }, { transform: to }],
            { duration, easing: 'ease' });
        pane.slide = animation;
        animation.finished.then(() => {
            if (pane.slide !== animation) return;
            pane.slide = null;
            onFinish?.();
        }, () => {});
    }

    function removePane(pane) {
        pane.slide?.cancel();
        pane.slide = null;
        pane.collapse = null;
        pane.panel.remove();
        pane.panel.classList.remove('is-leaving');
        pane.photo?.replaceChildren();
        if (leaving === pane) leaving = null;
    }

    function deactivatePane(pane) {
        inline = null;
        pane.panel.inert = true;
        pane.trigger.setAttribute('aria-expanded', 'false');
        if (pane.photo) window.PhotoCardSearch?.closeInlineRegistration();
        else if (active?.inline) abortLookup();
    }

    function leavePane(pane, from, direction) {
        leaving = pane;
        pane.panel.classList.add('is-leaving');
        slidePane(pane, from, `translateX(${direction * 100}%)`, () => removePane(pane));
    }

    function setInlineExpanded(expanded) {
        inlineContainer.classList.toggle('is-expanded', expanded);
        inlineWorkspace.classList.toggle('color-surface-002', expanded);
        inlineViewport.classList.toggle('color-surface-001', expanded);
        if (expanded) inlineAddButton.setAttribute('aria-label', '입력란 추가, 작업 영역 접기');
        else inlineAddButton.removeAttribute('aria-label');
    }

    function closeInline(restoreFocus = true, returnTarget = null) {
        const pane = inline;
        if (leaving && (pane || !restoreFocus)) removePane(leaving);
        if (!pane) return;
        deactivatePane(pane);
        setInlineExpanded(false);
        if (!restoreFocus) {
            removePane(pane);
            return;
        }
        focusModalReturnTarget(returnTarget || pane.trigger);
        pane.slide?.cancel();
        pane.slide = null;
        leaving = pane;
        pane.panel.classList.add('is-leaving');
        // 줄어드는 외곽으로 패널을 가린다.
        const collapse = window.AppOverlays.waitForHeightTransition(inlineContainer);
        pane.collapse = collapse;
        collapse.then(() => {
            if (pane.collapse === collapse) removePane(pane);
        });
    }

    function getInlinePane(kind) {
        if (panes.has(kind)) return panes.get(kind);
        const panel = inlineTemplate.content.firstElementChild.cloneNode(true);
        panel.setAttribute('aria-label', titles[kind]);
        panel.dataset.registrationPane = kind;
        const content = panel.querySelector('.manage-registration-inline__content');
        const pane = { kind, panel };
        if (kind === 'photo') {
            pane.photo = document.createElement('div');
            pane.photo.id = 'photo-registration-root';
            content.append(pane.photo);
        } else {
            pane.lookup = mountLookup(content, kind);
        }
        panel.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeInline();
        });
        panes.set(kind, pane);
        return pane;
    }

    function openInline(kind, trigger) {
        if (!inlineViewport || !paneOrder.includes(kind) || isMobile()
            || UIStore.mode !== 'add') return;
        if (kind === 'photo' && !window.PhotoCardSearch?.openInlineRegistration) return;
        if (inline?.kind === kind) {
            closeInline();
            return;
        }
        const previous = inline;
        const pane = getInlinePane(kind);
        const direction = previous && Math.sign(paneOrder.indexOf(kind) - paneOrder.indexOf(previous.kind));
        const previousTransform = previous && getComputedStyle(previous.panel).transform;
        const previousOffset = previous
            ? previous.panel.getBoundingClientRect().left - inlineViewport.getBoundingClientRect().left
            : 0;
        const resuming = previous && pane === leaving;
        // 새 패널을 현재 표시 중인 패널의 옆에 붙여 수평으로 함께 이동시킨다.
        const from = resuming ? getComputedStyle(pane.panel).transform
            : `translateX(calc(${direction * 100}% + ${previousOffset}px))`;
        if (resuming) leaving = null;
        else if (leaving) removePane(leaving);
        if (previous) deactivatePane(previous);

        inline = pane;
        pane.trigger = trigger;
        pane.panel.classList.remove('is-leaving');
        inlineViewport.append(pane.panel);
        pane.panel.inert = false;
        trigger.setAttribute('aria-expanded', 'true');
        if (!previous) setInlineExpanded(true);
        if (previous) {
            leavePane(previous, previousTransform, -direction);
            slidePane(pane, from, 'translateX(0)');
        }
        if (pane.photo) {
            window.PhotoCardSearch.openInlineRegistration(pane.photo, closeInline);
            focusModalReturnTarget(pane.panel);
        } else {
            open(kind, trigger, pane.lookup);
        }
    }

    function setStatus(session, message, error = false) {
        const { status } = session.view;
        status.classList.toggle('color-text-red', error);
        status.textContent = message;
    }

    function setPackEdition(session, edition) {
        const { packSummary, packEditions, packDetail, packRegion, packCount, packReset, addButton } = session.view;
        session.edition = edition;
        packSummary.hidden = false;
        packEditions.hidden = Boolean(edition);
        packDetail.hidden = !edition;
        packReset.hidden = !edition || session.result.editions.length < 2;
        addButton.disabled = !edition;
        setStatus(session, '');
        if (!edition) return;
        packRegion.textContent = regionMap[edition.locale] || edition.locale;
        const hasCount = Number.isInteger(edition.totalCards) && edition.totalCards >= 0;
        packCount.hidden = !hasCount;
        packCount.previousElementSibling.hidden = !hasCount;
        packCount.lastElementChild.textContent = hasCount ? `${edition.totalCards}장` : '';
    }

    function showPackResult(session, name, editions) {
        session.result = { name, editions };
        const choices = editions.length > 1 ? editions : [];
        session.view.packEditions.replaceChildren(...choices.map((edition, index) => {
            const label = document.createElement('label');
            const radio = document.createElement('input');
            const region = regionMap[edition.locale] || edition.locale;
            const sameRegion = editions.some(other => other !== edition && other.locale === edition.locale);
            radio.type = 'radio';
            radio.name = session.inline ? 'registration-pack-edition-inline' : 'registration-pack-edition-sheet';
            radio.value = String(index);
            label.append(radio, sameRegion ? `${region} (${edition.targetUrl})` : region);
            return label;
        }));
        setPackEdition(session, choices.length ? null : editions[0]);
    }

    function clearResult(session) {
        session.revision++;
        session.result = null;
        session.edition = null;
        session.submit.disabled = false;
        const { packSummary, packEditions, addButton } = session.view;
        packSummary.hidden = true;
        packEditions.replaceChildren();
        addButton.disabled = true;
        session.clear.hidden = !session.input.value;
        if (session.packTrigger) {
            session.packTrigger.textContent = session.input.value || session.input.placeholder;
            session.packTrigger.toggleAttribute('data-empty', !session.input.value);
        }
        setStatus(session, '');
    }

    function mountLookup(host, kind) {
        const content = lookupTemplate.content.cloneNode(true);
        const packDetail = content.querySelector('.registration-lookup__pack-detail');
        const [packRegion, packCount] = packDetail.querySelectorAll('dd');
        const view = {
            forms: [...content.querySelectorAll('form[data-registration-lookup]')],
            status: content.querySelector('.registration-lookup__status'),
            packSuggestions: content.querySelector('.registration-lookup__suggestions'),
            packSummary: content.querySelector('.registration-lookup__pack-summary'),
            packEditions: content.querySelector('.registration-lookup__pack-editions'),
            packReset: content.querySelector('.registration-lookup__pack-reset'),
            packDetail, packRegion, packCount,
            addButton: content.querySelector('[data-lookup-add]'),
        };
        if (kind) {
            const form = view.forms.find(item => item.dataset.registrationLookup === kind);
            view.forms.filter(item => item !== form).forEach(item => item.remove());
            view.forms = [form];
            form.querySelector('input').id += '-inline';
        }
        for (const form of view.forms) {
            form.addEventListener('keydown', event => {
                if (event.key === 'Enter' && event.isComposing) event.preventDefault();
            });
            form.addEventListener('submit', event => {
                event.preventDefault();
                if (active?.form !== form) return;
                if (active.packTrigger) openMobilePackInput(active);
                else void search();
            });
            form.addEventListener('input', () => {
                if (active?.form === form) clearResult(active);
            });
            form.querySelector('.mobile-search__clear').addEventListener('click', () => {
                if (active?.form !== form) return;
                active.input.value = '';
                active.input.dispatchEvent(new Event('input', { bubbles: true }));
                focusModalReturnTarget(active.packTrigger || active.input);
            });
            form.querySelector('[data-pack-lookup-trigger]')?.addEventListener('click', () => {
                if (active?.form === form) openMobilePackInput(active);
            });
        }
        view.packEditions.addEventListener('change', event => {
            const session = active;
            if (session?.view !== view || session.kind !== 'pack' || session.adding) return;
            const edition = session.result?.editions[Number(event.target.value)];
            if (!edition) return;
            setPackEdition(session, edition);
            focusModalReturnTarget(view.packReset);
        });
        view.packReset.addEventListener('click', () => {
            const session = active;
            if (session?.view !== view || session.kind !== 'pack' || session.adding || !session.edition) return;
            const checked = view.packEditions.querySelector(':checked');
            if (checked) checked.checked = false;
            setPackEdition(session, null);
            view.packEditions.scrollLeft = 0;
            focusModalReturnTarget(view.packEditions.querySelector('input'));
        });
        view.addButton.addEventListener('click', addCards);
        host.append(content);
        return view;
    }

    function open(kind, trigger, view = sheetLookup) {
        if (active || UIStore.mode !== 'add') return;
        const { forms } = view;
        const form = forms.find(item => item.dataset.registrationLookup === kind);
        if (!form) return;
        const usePackOverlay = kind === 'pack' && view === sheetLookup && isMobile();
        if (kind === 'pack' && !usePackOverlay && !view.packAutocompleteReady) {
            view.packAutocompleteReady = true;
            view.closePackSuggestions = setupPackNameAutocomplete(form.querySelector('input'), view.packSuggestions, () => {
                if (active?.form === form) void search();
            });
        }
        const input = form.querySelector('input');
        const submit = form.querySelector('[type="submit"]');
        const clear = form.querySelector('.mobile-search__clear');
        const packTrigger = form.querySelector('[data-pack-lookup-trigger]');
        if (packTrigger) {
            input.hidden = usePackOverlay;
            packTrigger.hidden = !usePackOverlay;
            packTrigger.disabled = false;
        }
        active = { kind, view, form, input, submit, clear, revision: 0,
            packTrigger: usePackOverlay ? packTrigger : null,
            controller: new AbortController(), adding: false, inline: view !== sheetLookup };
        for (const item of forms) item.hidden = item !== form;
        input.value = '';
        input.disabled = false;
        clear.disabled = false;
        clearResult(active);
        if (active.inline) {
            focusModalReturnTarget(input);
        } else {
            title.textContent = titles[kind];
            openManagedSheet(sheet, { backdrop, trigger, initialFocus: isMobile() ? sheet : input, onDismiss: close });
            if (usePackOverlay) openMobilePackInput(active);
        }
    }

    function openMobilePackInput(session) {
        if (!session.packTrigger || session.adding) return;
        openSheetInputOverlay('pack', session.packTrigger, session.input.placeholder, session.input.value, value => {
            if (active !== session) return;
            session.input.value = value;
            void search();
        });
    }

    function isMobile() {
        return document.documentElement.classList.contains('is-mobile-device');
    }

    async function search() {
        const session = active;
        if (!session || session.adding) return;
        const { addButton } = session.view;
        const pack = session.kind === 'pack';
        if (pack) session.view.closePackSuggestions?.();
        clearResult(session);
        const query = session.input.value.trim();
        if (!query) {
            setStatus(session, pack ? '팩 이름을 입력해 주세요.' : '뉴런 덱 코드를 입력해 주세요.', true);
            focusModalReturnTarget(session.packTrigger || session.input);
            return;
        }
        const revision = session.revision;
        const isCurrent = () => active === session && session.revision === revision;
        setStatus(session, '검색 중…');
        session.submit.disabled = true;
        try {
            const result = await (pack
                ? callApi('searchPack', { packName: query })
                : callApi('searchDeck', { deckCode: query, locale: UIStore.currentRegion }));
            if (!isCurrent()) return;
            if (!result || result.isError) throw new Error(result?.message || '검색 결과를 가져오지 못했습니다.');
            if (pack) {
                const variants = result.isMultiple ? result.foundLocales : [{
                    locale: result.validLocale || UIStore.currentRegion || 'ko',
                    targetUrl: result.packId,
                    totalCards: result.totalCards,
                }];
                const editions = variants?.filter(edition => edition.targetUrl && edition.locale) || [];
                if (!editions.length) throw new Error('이 팩의 발매 정보를 찾을 수 없습니다.');
                showPackResult(session, result.packName || query, editions);
            } else {
                if (!result.detailUrl || !result.deckName) throw new Error('이 덱의 상세 정보를 찾을 수 없습니다.');
                session.result = result;
                setStatus(session, result.deckName);
                addButton.disabled = false;
            }
        } catch (error) {
            if (isCurrent()) setStatus(session, error.message || '검색에 실패했습니다. 다시 시도해 주세요.', true);
        } finally {
            if (isCurrent()) session.submit.disabled = false;
        }
    }

    async function loadPackCards(result, edition, signal) {
        const params = { packId: edition.targetUrl, locale: edition.locale };
        const summary = await callApi('getPackCids', params);
        if (summary?.isError || !Array.isArray(summary?.cids) || !summary.cids.length) {
            throw new Error(summary?.message || '팩의 수록 카드를 찾을 수 없습니다.');
        }
        const cards = [];
        const pageSize = 20;
        for (let offset = 0; offset < summary.cids.length; offset += pageSize) {
            signal.throwIfAborted();
            const cids = summary.cids.slice(offset, offset + pageSize);
            const page = await callApi('crawlPackCardsBatch', { ...params, offset, packName: result.name },
                window.AppBackend ? { cids, signal } : { cids });
            if (page?.isError || !Array.isArray(page?.cards) || page.cards.length !== cids.length || page.cards.some((card, index) =>
                card.isError || String(card.cid) !== String(cids[index]) || (!card.cardNo && !card.name))) {
                throw new Error(page?.message || '팩의 수록 카드 일부를 불러오지 못했습니다.');
            }
            cards.push(...page.cards);
        }
        return cards;
    }

    async function loadDeckCards(result, signal) {
        const response = await callApi('getDeckCards', { url: result.detailUrl });
        signal.throwIfAborted();
        if (!response?.success || !Array.isArray(response.cards) || !response.cards.length || response.cards.some(card => !card.name?.trim())) {
            throw new Error(response?.message || '덱의 카드를 불러오지 못했습니다.');
        }
        const cids = await window.AppBackend?.resolveDeckCardIds?.(response.cards.map(card => card.name)).catch(() => undefined);
        return response.cards.map(card => {
            const cid = cids?.get(card.name.normalize('NFC').trim());
            return { name: card.name, cid, unresolved: Boolean(cids && !cid) };
        });
    }

    function appendCards(cards) {
        const mobile = isMobile();
        const list = document.getElementById(mobile ? 'mobile-cards-list-general' : 'desktop-cards-list-general');
        const lastRow = [...list.children].findLast(row => row.hasAttribute('data-index'));
        const emptyRow = lastRow && [...lastRow.querySelectorAll('[data-field]')].every(input =>
            !String(input.dataset.raw || input.value || '').trim());
        const pending = cards.map((card, index) => {
            const row = index === 0 && emptyRow ? lastRow : manageAddEntry();
            const name = row.querySelector('[data-field="name"]');
            const number = row.querySelector('[data-field="no"]');
            row.querySelector('[data-field="qty"]').value = '1';
            name.value = card.name || '';
            number.value = card.cardNo || '';
            if (mobile) updateMobileCardDisplay(row);
            return { row, card, name, number };
        });
        // 카드 조회는 일반 등록 입력란과 동일한 번호·이름 처리로 이어지며, 기존 행을 다시 렌더링하지 않는다.
        void Promise.allSettled(pending.map(async ({ row, card, name, number }) => {
            if (card.cardNo) await fetchCardByNumber(number, true);
            else await fetchCardByName(name, true, card.cid, card.unresolved);
            if (mobile && row.isConnected) updateMobileCardDisplay(row);
        }));
    }

    async function addCards() {
        const session = active;
        if (!session?.result || session.adding) return;
        const pack = session.kind === 'pack';
        if (pack && !session.edition) return;
        const { packSummary, addButton } = session.view;
        if (pack) session.view.closePackSuggestions?.();
        session.adding = true;
        session.input.disabled = true;
        if (session.packTrigger) session.packTrigger.disabled = true;
        session.submit.disabled = true;
        session.clear.disabled = true;
        packSummary.hidden = true;
        addButton.disabled = true;
        setStatus(session, '카드 목록을 불러오는 중…');
        try {
            const { result, controller } = session;
            const cards = await (pack
                ? loadPackCards(result, session.edition, controller.signal)
                : loadDeckCards(result, controller.signal));
            if (active !== session || controller.signal.aborted) return;
            appendCards(cards);
            close();
            showToast(`일반 등록 목록에 ${cards.length}장을 추가했습니다.`, 'rounded');
        } catch (error) {
            if (active === session) setStatus(session, error.message || '카드 목록을 불러오지 못했습니다.', true);
        } finally {
            if (active === session) {
                session.adding = false;
                session.input.disabled = false;
                if (session.packTrigger) session.packTrigger.disabled = false;
                session.submit.disabled = false;
                session.clear.disabled = false;
                if (pack) packSummary.hidden = false;
                addButton.disabled = false;
            }
        }
    }

    const sheetLookup = mountLookup(sheetPanel);
    inlineAddButton?.addEventListener('click', event => {
        if (inline) {
            manageAddEntry();
            closeInline(true, inlineAddButton);
        } else if (!leaving) {
            addMultipleRows(event);
        }
    });
    inlineAddButton?.addEventListener('keydown', event => {
        if (!inline && !leaving) handleAddButtonKey(event, 'add');
    });
    backdrop.addEventListener('click', close);
    sheet.querySelector('.ui-overlay__header [data-lookup-close]').addEventListener('click', close);
    window.RegistrationLookup = { open, close, openInline, closeInline };
})();
