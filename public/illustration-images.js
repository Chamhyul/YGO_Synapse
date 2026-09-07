(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.IllustrationImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const BUCKET = 'ygo-synapse.firebasestorage.app';
    const INDEX_URL = `https://storage.googleapis.com/${BUCKET}/public/indexes/illustration_sources.json`;
    const STORAGE_BASE = `https://storage.googleapis.com/${BUCKET}/`;
    const MOMOBAKO_BASE = 'https://cdn.233.momobako.com/ygopro/pics';
    let indexPromise = null;

    function normalizeKey(cid, ciid) {
        const normalizedCid = String(cid || '').trim();
        const normalizedCiid = Number(ciid);
        if (!/^\d+$/.test(normalizedCid) || !Number.isInteger(normalizedCiid) || normalizedCiid < 1) return null;
        return `${normalizedCid}_${normalizedCiid}`;
    }

    function storageUrl(path, contentSha256) {
        const normalized = String(path || '').replace(/^\/+/, '');
        if (!normalized) return null;
        const version = contentSha256 ? `?v=${encodeURIComponent(String(contentSha256).slice(0, 12))}` : '';
        return `${STORAGE_BASE}${normalized.split('/').map(encodeURIComponent).join('/')}${version}`;
    }

    function momobakoUrl(source) {
        if (!source?.sourceImageId || source.cdnAvailable === false) return null;
        const suffix = source.transform === 'artp' ? '!artp' : '!art';
        return `${MOMOBAKO_BASE}/${encodeURIComponent(source.sourceImageId)}.jpg${suffix}`;
    }

    async function loadIndex(fetchImpl = fetch) {
        if (!indexPromise) {
            indexPromise = fetchImpl(INDEX_URL, { cache: 'no-cache' }).then(response => {
                if (!response.ok) throw new Error(`일러스트 소스 인덱스 요청 실패: HTTP ${response.status}`);
                return response.json();
            }).catch(error => {
                indexPromise = null;
                throw error;
            });
        }
        return indexPromise;
    }

    function resolveFromIndex(index, cid, ciid) {
        const key = normalizeKey(cid, ciid);
        if (!key) return null;
        const source = index?.files?.[key];
        const fallbackPath = source?.storagePath || `public/resources/illustrations/${key}.webp`;
        return {
            key,
            primaryUrl: momobakoUrl(source),
            fallbackUrl: storageUrl(fallbackPath, source?.contentSha256),
            source: source || null,
        };
    }

    async function resolve(cid, ciid = 1) {
        return resolveFromIndex(await loadIndex(), cid, ciid);
    }

    function displayResolvedImage(image, resolved, options = {}) {
        if (!image || !resolved) return () => {};
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000;
        const fallback = () => {
            cleanup();
            if (resolved.fallbackUrl && image.src !== resolved.fallbackUrl) image.src = resolved.fallbackUrl;
        };
        const loaded = () => cleanup();
        let timer = null;
        const cleanup = () => {
            image.removeEventListener?.('error', fallback);
            image.removeEventListener?.('load', loaded);
            if (timer) clearTimeout(timer);
            timer = null;
        };

        if (!resolved.primaryUrl) {
            image.src = resolved.fallbackUrl;
            return cleanup;
        }
        image.addEventListener?.('error', fallback, { once: true });
        image.addEventListener?.('load', loaded, { once: true });
        timer = setTimeout(fallback, timeoutMs);
        image.src = resolved.primaryUrl;
        return cleanup;
    }

    async function display(image, cid, ciid = 1, options = {}) {
        const resolved = await resolve(cid, ciid);
        return displayResolvedImage(image, resolved, options);
    }

    function resetIndexCache() {
        indexPromise = null;
    }

    return {
        INDEX_URL, normalizeKey, storageUrl, momobakoUrl, loadIndex, resolveFromIndex, resolve,
        displayResolvedImage, display, resetIndexCache,
    };
});
