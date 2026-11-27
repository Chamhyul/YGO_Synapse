/* Individual card search artwork viewer. */
(function (root) {
    'use strict';
    const regions = ['한국', '일본', '아시아', '중국', '영어권', '독일', '프랑스', '이탈리아', '스페인', '포르투갈'];
    // These are the DB's locale ciid lists already included in the detail response.
    // Never infer release regions from an image source or an illustration count.
    function entries(info, index, cid) {
        const result = new Map();
        const add = (id, region) => {
            id = Number(id);
            if (!Number.isInteger(id) || id < 1) return;
            if (!result.has(id)) result.set(id, new Set());
            if (region) result.get(id).add(region);
        };
        regions.forEach((region, slot) => {
            const locale = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'][slot];
            const value = info?.[locale]?.ciid ?? info?.[slot]?.[1];
            const ids = Array.isArray(value) ? value : [];
            ids.forEach(id => add(id, region));
        });
        const prefix = `${cid}_`;
        Object.keys(index?.files || {}).forEach(key => { if (key.startsWith(prefix)) add(key.slice(prefix.length)); });
        return [...result].sort((a, b) => a[0] - b[0]);
    }
    const stripCleanups = new WeakMap();
    function mount(box, cid, info) {
        stripCleanups.get(box)?.();
        stripCleanups.delete(box);
        if (!cid || !root.IllustrationImages) return;
        const header = box.querySelector('.search-card__name');
        if (!header) return;
        const content = document.createElement('div');
        content.className = 'search-card-details';
        [...box.children].filter(el => el !== header).forEach(el => content.append(el));
        box.append(content);
        const button = document.createElement('button');
        const imageIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>';
        const detailsIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h3M9 11h6M9 15h6M9 19h4"/></svg>';
        button.type = 'button';
        button.className = 'search-art-toggle ui-button ui-button--text color-text-001';
        button.innerHTML = imageIcon;
        button.setAttribute('aria-label', '카드 일러스트 보기');
        button.setAttribute('aria-pressed', 'false');
        header.prepend(button);
        const gallery = document.createElement('div');
        gallery.className = 'search-art-gallery';
        gallery.hidden = true;
        box.append(gallery);
        let opened = false, switching = 0, heightAnimation = null, stripObserver = null;
        let syncStripEdges = () => {}, revealSelected = () => {}, stopStripScroll = () => {}, stopStripDrag = () => {};
        async function initialize() {
            gallery.textContent = '일러스트를 불러오는 중…';
            const items = typeof root.IllustrationImages.galleryEntries === 'function'
                ? await root.IllustrationImages.galleryEntries(cid)
                : entries(info, await root.IllustrationImages.loadIndex(fetch, cid).catch(() => null), cid);
            if (!gallery.isConnected) return;
            const labelArtwork = id => root.IllustrationImages.galleryLabel?.(cid, id) ?? root.IllustrationImages.label(id);
            const preloadArtwork = id => root.IllustrationImages.preload(cid, id, { gallery: true });
            gallery.replaceChildren();
            if (!items.length) { gallery.textContent = '표시할 수 있는 일러스트가 없습니다.'; return; }
            gallery.innerHTML = '<div class="search-art-picture"></div><div class="search-art-caption"><button type="button" class="search-art-prev" aria-label="이전 일러스트">❮</button><div class="search-art-caption-meta"><span class="search-art-caption-label"></span><div class="search-art-region"><button type="button" class="ui-button ui-button--text color-text-000" aria-label="발매 지역" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg></button><div class="search-art-popup ui-overlay__panel ui-overlay--popup color-surface-002 color-text-001 shape-rounded003" hidden></div></div></div><button type="button" class="search-art-next" aria-label="다음 일러스트">❯</button></div><div class="search-art-strip-row"><div class="search-art-thumbs" role="group" aria-label="일러스트 목록"></div></div>';
            for (const selector of ['.search-art-prev', '.search-art-next']) {
                gallery.querySelector(selector).className += ' ui-button color-type001 color-disabled ui-control--disabled shape-capsule';
            }
            const picture = gallery.querySelector('.search-art-picture');
            const strip = gallery.querySelector('.search-art-thumbs');
            const stripRow = gallery.querySelector('.search-art-strip-row');
            let wheelFrame = null, wheelTarget = null, wheelPosition = 0, lastWheelTime = 0;
            const clampScroll = value => Math.max(0, Math.min(value, strip.scrollWidth - strip.clientWidth));
            stopStripScroll = () => {
                if (wheelFrame !== null) root.cancelAnimationFrame(wheelFrame);
                wheelFrame = null; wheelTarget = null; lastWheelTime = 0;
            };
            syncStripEdges = () => {
                stripRow.setAttribute('data-scroll-before', String(strip.scrollLeft > 1));
                stripRow.setAttribute('data-scroll-after', String(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1));
            };
            const animateWheel = time => {
                if (!gallery.isConnected || gallery.hidden) { stopStripScroll(); return; }
                wheelTarget = clampScroll(wheelTarget);
                const remaining = wheelTarget - wheelPosition;
                if (Math.abs(remaining) <= 0.5) {
                    strip.scrollLeft = wheelTarget; stopStripScroll(); syncStripEdges(); return;
                }
                const elapsed = Math.min(40, time - (lastWheelTime || time - 16.7));
                wheelPosition += remaining * (1 - Math.exp(-elapsed / 65));
                strip.scrollLeft = wheelPosition;
                lastWheelTime = time;
                syncStripEdges();
                wheelFrame = root.requestAnimationFrame(animateWheel);
            };
            const revealThumb = thumb => {
                if (!thumb) return;
                stopStripScroll();
                const inset = 32;
                if (thumb.offsetLeft < strip.scrollLeft + inset) strip.scrollLeft = Math.max(0, thumb.offsetLeft - inset);
                else if (thumb.offsetLeft + thumb.offsetWidth > strip.scrollLeft + strip.clientWidth - inset)
                    strip.scrollLeft = thumb.offsetLeft + thumb.offsetWidth - strip.clientWidth + inset;
                syncStripEdges();
            };
            strip.addEventListener('scroll', syncStripEdges, { passive: true });
            strip.addEventListener('wheel', event => {
                if (event.ctrlKey || event.metaKey || strip.scrollWidth <= strip.clientWidth) return;
                // 정밀한 가로 트랙패드 입력은 브라우저의 기본 관성을 사용한다.
                if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) { stopStripScroll(); return; }
                event.preventDefault();
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
                const next = clampScroll((wheelTarget ?? strip.scrollLeft) + event.deltaY * unit);
                if (root.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    stopStripScroll(); strip.scrollLeft = next; syncStripEdges(); return;
                }
                wheelTarget = next;
                if (wheelFrame === null) { wheelPosition = strip.scrollLeft; wheelFrame = root.requestAnimationFrame(animateWheel); }
            }, { passive: false });
            let drag = null, suppressClick = false;
            stopStripDrag = event => {
                if (!drag || (event && event.pointerId !== drag.id)) return;
                const finished = drag;
                drag = null; suppressClick = finished.moved;
                strip.setAttribute('data-dragging', 'false');
                if (finished.capture.hasPointerCapture?.(finished.id)) finished.capture.releasePointerCapture(finished.id);
            };
            strip.addEventListener('pointerdown', event => {
                stopStripScroll();
                if (event.pointerType !== 'mouse' || event.button !== 0 || event.isPrimary === false) return;
                stopStripDrag(); suppressClick = false;
                if (strip.scrollWidth <= strip.clientWidth) return;
                const capture = event.target.closest('.search-art-thumb') || strip;
                drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: strip.scrollLeft, moved: false, capture };
                // 짧게 클릭했을 때 기존 썸네일 선택 대상이 유지되도록 누른 요소가 포인터를 잡는다.
                capture.setPointerCapture(event.pointerId);
            });
            strip.addEventListener('pointermove', event => {
                if (!drag || drag.id !== event.pointerId) return;
                if (!(event.buttons & 1)) { stopStripDrag(event); return; }
                const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
                if (!drag.moved && Math.hypot(dx, dy) < 6) return;
                drag.moved = true; strip.setAttribute('data-dragging', 'true');
                event.preventDefault();
                strip.scrollLeft = clampScroll(drag.left - dx);
                syncStripEdges();
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) strip.addEventListener(type, stopStripDrag);
            strip.addEventListener('click', event => {
                if (!suppressClick || event.detail === 0) return;
                suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
            }, true);
            strip.addEventListener('dragstart', event => event.preventDefault());
            strip.addEventListener('keydown', event => { stopStripScroll(); if (event.key === 'Escape') stopStripDrag(); });
            strip.addEventListener('focusin', event => { if (!drag && event.target.parentNode === strip) revealThumb(event.target); });
            stripCleanups.set(box, () => { stripObserver?.disconnect(); stopStripScroll(); stopStripDrag(); });
            if (typeof root.ResizeObserver === 'function') {
                stripObserver = new root.ResizeObserver(() => {
                    if (!gallery.isConnected) { stripObserver.disconnect(); stopStripScroll(); stopStripDrag(); return; }
                    stopStripScroll(); syncStripEdges();
                });
                if (opened) stripObserver.observe(strip);
            }
            const region = gallery.querySelector('.search-art-region');
            const globe = region.querySelector('button');
            const popup = region.querySelector('.search-art-popup');
            const showPopup = value => {
                globe.setAttribute('aria-expanded', String(value));
                if (window.AppOverlays) {
                    if (value) window.AppOverlays.openPopup(popup, globe, { centerElement: picture });
                    else window.AppOverlays.closePopup(popup);
                } else popup.hidden = !value;
            };
            globe.onclick = () => showPopup(globe.getAttribute('aria-expanded') !== 'true');
            region.onpointerenter = event => { if (event.pointerType === 'mouse') showPopup(true); };
            region.onpointerleave = event => { if (event.pointerType === 'mouse') showPopup(false); };
            region.onfocusout = event => { if (!region.contains(event.relatedTarget)) showPopup(false); };
            gallery.addEventListener('keydown', event => { if (event.key === 'Escape') { showPopup(false); globe.focus(); } });
            let selected = 0, request = 0;
            const thumbs = items.map(([id], i) => {
                const thumb = document.createElement('button');
                thumb.type = 'button';
                thumb.className = 'search-art-thumb shape-rounded002 color-text-001';
                thumb.dataset.artworkId = String(id);
                thumb.setAttribute('aria-label', labelArtwork(id));
                thumb.textContent = labelArtwork(id);
                thumb.onclick = () => select(i);
                strip.append(thumb);
                preloadArtwork(id).then(result => {
                    if (result.url) { const img = document.createElement('img'); img.src = result.url; img.alt = labelArtwork(id); img.draggable = false; thumb.replaceChildren(img); }
                });
                return thumb;
            });
            revealSelected = () => revealThumb(thumbs[selected]);
            async function select(i) {
                selected = (i + items.length) % items.length;
                const token = ++request;
                const [id, released] = items[selected];
                box.dataset.selectedArtwork = String(id);
                gallery.querySelector('.search-art-caption-label').textContent = labelArtwork(id);
                const regionLines = [regions.slice(0, 4), regions.slice(4)]
                    .map(group => group.filter(name => released.has(name)))
                    .filter(group => group.length);
                popup.replaceChildren();
                for (const names of regionLines) {
                    const line = document.createElement('div');
                    line.className = 'search-art-region-line';
                    line.textContent = names.join(', ');
                    popup.append(line);
                }
                if (!regionLines.length) popup.textContent = '발매 지역 정보 없음';
                showPopup(false);
                thumbs.forEach((thumb, n) => thumb.setAttribute('aria-pressed', String(n === selected)));
                revealSelected();
                picture.textContent = '이미지를 불러오는 중…';
                const result = await preloadArtwork(id);
                if (token !== request) return;
                if (!result.url) { picture.textContent = '이미지를 불러올 수 없습니다.'; return; }
                const img = document.createElement('img'); img.src = result.url; img.alt = `${labelArtwork(id)} 일러스트`;
                img.className = 'shape-rounded002';
                picture.replaceChildren(img);
            }
            gallery.querySelector('.search-art-prev').onclick = () => select(selected - 1);
            gallery.querySelector('.search-art-next').onclick = () => select(selected + 1);
            if (items.length === 1) {
                gallery.querySelector('.search-art-strip-row').hidden = true;
                gallery.querySelector('.search-art-prev').hidden = true;
                gallery.querySelector('.search-art-next').hidden = true;
            }
            const previous = items.findIndex(([id]) => String(id) === box.dataset.selectedArtwork);
            select(previous < 0 ? 0 : previous);
        }
        // Start resolving and loading every artwork as soon as the individual
        // card result mounts. Opening the gallery only changes the visible pane.
        const ready = initialize();
        button.onclick = async () => {
            const startHeight = box.getBoundingClientRect().height;
            if (heightAnimation) {
                heightAnimation.cancel();
                heightAnimation = null;
            }
            box.style.height = `${startHeight}px`;
            box.style.overflow = 'hidden';
            opened = !opened;
            box.dataset.artworkOpen = String(opened);
            const token = ++switching;
            button.setAttribute('aria-pressed', String(opened));
            button.setAttribute('aria-label', opened ? '카드 정보 보기' : '카드 일러스트 보기');
            button.innerHTML = opened ? detailsIcon : imageIcon;
            const outgoing = opened ? content : gallery;
            const incoming = opened ? gallery : content;
            const reduced = root.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (outgoing.animate && !reduced) await outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140 }).finished.catch(() => {});
            if (token !== switching || !gallery.isConnected) return;
            outgoing.hidden = true;
            incoming.hidden = false;
            if (opened) {
                stripObserver?.observe(gallery.querySelector('.search-art-thumbs'));
                revealSelected();
                syncStripEdges();
            } else { stripObserver?.disconnect(); stopStripScroll(); stopStripDrag(); }
            box.style.height = 'auto';
            const targetHeight = box.getBoundingClientRect().height;
            box.style.height = `${startHeight}px`;
            if (box.animate && !reduced && Math.abs(targetHeight - startHeight) > 1) {
                heightAnimation = box.animate(
                    [{ height: `${startHeight}px` }, { height: `${targetHeight}px` }],
                    { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
                );
                const currentAnimation = heightAnimation;
                currentAnimation.finished.catch(() => {}).finally(() => {
                    if (heightAnimation !== currentAnimation) return;
                    heightAnimation = null;
                    currentAnimation.cancel();
                    box.style.height = '';
                    box.style.overflow = '';
                });
            } else {
                box.style.height = '';
                box.style.overflow = '';
            }
            if (incoming.animate && !reduced) incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
        };
        if (box.dataset.artworkOpen === 'true') {
            // 메타데이터 보충 시 이미 열린 화면은 다시 전환하지 않습니다.
            opened = true;
            content.hidden = true;
            gallery.hidden = false;
            button.setAttribute('aria-pressed', 'true');
            button.setAttribute('aria-label', '카드 정보 보기');
            button.innerHTML = detailsIcon;
        }
        // 비동기 일러스트 선택지를 만든 뒤 같은 컨트롤로 초점을 복원할 수 있습니다.
        return ready;
    }
    root.SearchIllustrations = { mount, entries };
    if (typeof module !== 'undefined') module.exports = { entries };
})(typeof window !== 'undefined' ? window : globalThis);
