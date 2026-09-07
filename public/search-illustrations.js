/* Individual card search artwork viewer. */
(function (root) {
    'use strict';
    const regions = ['한국', '일본', '아시아 영어', '중국', '영어권', '독일', '프랑스', '이탈리아', '스페인', '포르투갈'];
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
    function mount(box, cid, info) {
        if (!cid || !root.IllustrationImages) return;
        const header = box.querySelector('.target-sec-name');
        const content = document.createElement('div');
        content.className = 'search-card-details';
        [...box.children].filter(el => el !== header).forEach(el => content.append(el));
        box.append(content);
        const button = document.createElement('button');
        const imageIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>';
        const detailsIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h3M9 11h6M9 15h6M9 19h4"/></svg>';
        button.type = 'button';
        button.className = 'search-art-toggle';
        button.innerHTML = imageIcon;
        button.setAttribute('aria-label', '카드 일러스트 보기');
        button.setAttribute('aria-pressed', 'false');
        header.prepend(button);
        const gallery = document.createElement('div');
        gallery.className = 'search-art-gallery';
        gallery.hidden = true;
        box.append(gallery);
        let opened = false, switching = 0, heightAnimation = null;
        async function initialize() {
            gallery.textContent = '일러스트를 불러오는 중…';
            const index = await root.IllustrationImages.loadIndex().catch(() => null);
            if (!gallery.isConnected) return;
            const items = entries(info, index, cid);
            gallery.replaceChildren();
            if (!items.length) { gallery.textContent = '등록된 일러스트가 없습니다.'; return; }
            gallery.innerHTML = '<div class="search-art-stage"><div class="search-art-picture"></div></div><div class="search-art-caption"><button type="button" class="search-art-prev" aria-label="이전 일러스트">❮</button><div class="search-art-caption-meta"><span class="search-art-caption-label"></span><div class="search-art-region"><button type="button" aria-label="발매 지역" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg></button><div class="search-art-popup" hidden></div></div></div><button type="button" class="search-art-next" aria-label="다음 일러스트">❯</button></div><div class="search-art-strip-row"><button type="button" class="search-art-strip-prev" aria-label="이전 일러스트 선택">❮</button><div class="search-art-thumbs" aria-label="일러스트 목록"></div><button type="button" class="search-art-strip-next" aria-label="다음 일러스트 선택">❯</button></div>';
            const picture = gallery.querySelector('.search-art-picture');
            const strip = gallery.querySelector('.search-art-thumbs');
            const region = gallery.querySelector('.search-art-region');
            const globe = region.querySelector('button');
            const popup = region.querySelector('.search-art-popup');
            const showPopup = value => { popup.hidden = !value; globe.setAttribute('aria-expanded', String(value)); };
            globe.onclick = () => showPopup(popup.hidden);
            region.onpointerenter = event => { if (event.pointerType === 'mouse') showPopup(true); };
            region.onpointerleave = event => { if (event.pointerType === 'mouse') showPopup(false); };
            region.onfocusout = event => { if (!region.contains(event.relatedTarget)) showPopup(false); };
            gallery.addEventListener('keydown', event => { if (event.key === 'Escape') { showPopup(false); globe.focus(); } });
            let selected = 0, request = 0;
            const thumbs = items.map(([id], i) => {
                const thumb = document.createElement('button');
                thumb.type = 'button';
                thumb.setAttribute('aria-label', root.IllustrationImages.label(id));
                thumb.textContent = root.IllustrationImages.label(id);
                thumb.onclick = () => select(i);
                strip.append(thumb);
                root.IllustrationImages.preload(cid, id).then(result => {
                    if (result.url) { const img = document.createElement('img'); img.src = result.url; img.alt = root.IllustrationImages.label(id); thumb.replaceChildren(img); }
                });
                return thumb;
            });
            async function select(i) {
                selected = (i + items.length) % items.length;
                const token = ++request;
                const [id, released] = items[selected];
                box.dataset.selectedArtwork = String(id);
                gallery.querySelector('.search-art-caption-label').textContent = root.IllustrationImages.label(id);
                popup.textContent = released.size ? [...released].join(', ') : '발매 지역 정보 없음';
                showPopup(false);
                thumbs.forEach((thumb, n) => thumb.setAttribute('aria-pressed', String(n === selected)));
                const activeThumb = thumbs[selected];
                if (activeThumb.offsetLeft < strip.scrollLeft) strip.scrollLeft = activeThumb.offsetLeft;
                else if (activeThumb.offsetLeft + activeThumb.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = activeThumb.offsetLeft + activeThumb.offsetWidth - strip.clientWidth;
                picture.textContent = '이미지를 불러오는 중…';
                const result = await root.IllustrationImages.preload(cid, id);
                if (token !== request) return;
                if (!result.url) { picture.textContent = '이미지를 불러올 수 없습니다.'; return; }
                const img = document.createElement('img'); img.src = result.url; img.alt = `${root.IllustrationImages.label(id)} 일러스트`;
                picture.replaceChildren(img);
            }
            gallery.querySelector('.search-art-prev').onclick = () => select(selected - 1);
            gallery.querySelector('.search-art-next').onclick = () => select(selected + 1);
            gallery.querySelector('.search-art-strip-prev').onclick = () => select(selected - 1);
            gallery.querySelector('.search-art-strip-next').onclick = () => select(selected + 1);
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
        initialize();
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
        if (box.dataset.artworkOpen === 'true') button.click();
    }
    root.SearchIllustrations = { mount, entries };
    if (typeof module !== 'undefined') module.exports = { entries };
})(typeof window !== 'undefined' ? window : globalThis);
