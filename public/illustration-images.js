(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.IllustrationImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const BUCKET = 'ygo-synapse.firebasestorage.app';
    const INDEX_URL = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/public%2Findexes%2Fillustration_sources.json?alt=media`;
    const STORAGE_BASE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`;
    const MOMOBAKO_BASE = 'https://cdn.233.momobako.com/ygopro/pics';
    let indexPromise = null;
    const preloads = new Map();

    function ciidValue(value) {
        const text = String(value ?? '').trim();
        if (text === '기본') return '1';
        const match = text.match(/^(\d+)(?:st|nd|rd|th)?$/i);
        return match && Number(match[1]) > 0 ? String(Number(match[1])) : '';
    }

    function label(value) {
        const id = Number(ciidValue(value));
        if (!id) return '';
        if (id === 1) return '기본';
        const suffix = id % 100 >= 11 && id % 100 <= 13 ? 'th'
            : ({ 1: 'st', 2: 'nd', 3: 'rd' }[id % 10] || 'th');
        return `${id}${suffix}`;
    }

    function normalizeKey(cid, ciid) {
        const normalizedCid = String(cid || '').trim();
        const normalizedCiid = Number(ciid);
        if (!/^\d+$/.test(normalizedCid) || !Number.isInteger(normalizedCiid) || normalizedCiid < 1) return null;
        return `${normalizedCid}_${normalizedCiid}`;
    }

    function storageUrl(path, contentSha256) {
        const normalized = String(path || '').replace(/^\/+/, '');
        if (!normalized) return null;
        const version = contentSha256 ? `&v=${encodeURIComponent(String(contentSha256).slice(0, 12))}` : '';
        return `${STORAGE_BASE}${encodeURIComponent(normalized)}?alt=media${version}`;
    }

    function momobakoUrl(source) {
        if (!source?.sourceImageId || source.cdnAvailable === false) return null;
        const suffix = source.transform === 'artp' ? '!artp' : '!art';
        return `${MOMOBAKO_BASE}/${encodeURIComponent(source.sourceImageId)}.jpg${suffix}`;
    }

    async function loadIndex(fetchImpl = fetch) {
        if (!indexPromise) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            indexPromise = fetchImpl(INDEX_URL, { cache: 'no-cache', signal: controller.signal }).then(response => {
                if (!response.ok) throw new Error(`일러스트 소스 인덱스 요청 실패: HTTP ${response.status}`);
                return response.json();
            }).catch(error => {
                indexPromise = null;
                throw error;
            }).finally(() => clearTimeout(timer));
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
        return resolveFromIndex(await loadIndex().catch(() => null), cid, ciid);
    }

    // Keep the Image alive as well as its promise so opening a picker reuses a
    // completed/in-flight request. Failures expire so a later opening can retry.
    function preload(cid, ciid, options = {}) {
        const key = normalizeKey(cid, ciidValue(ciid));
        if (!key) return Promise.resolve({ status: 'error', url: null });
        const cached = preloads.get(key);
        if (cached && (!cached.failedAt || Date.now() - cached.failedAt < 30000)) return cached.promise;
        const entry = {};
        entry.promise = resolve(cid, ciidValue(ciid)).then(async resolved => {
            const image = options.createImage ? options.createImage() : new Image();
            entry.image = image;
            const request = url => new Promise(resolveRequest => {
                if (!url) return resolveRequest(false);
                const finish = ok => {
                    clearTimeout(timer);
                    image.onload = image.onerror = null;
                    resolveRequest(ok);
                };
                const timer = setTimeout(() => finish(false), options.timeoutMs ?? 3000);
                image.onload = () => finish(true);
                image.onerror = () => finish(false);
                image.src = url;
            });
            for (const url of [...new Set([resolved.primaryUrl, resolved.fallbackUrl].filter(Boolean))]) {
                if (await request(url)) return { status: 'loaded', url };
            }
            throw new Error('이미지 없음');
        }).catch(() => {
            entry.failedAt = Date.now();
            return { status: 'error', url: null };
        });
        preloads.set(key, entry);
        return entry.promise;
    }

    async function preloadCard(cid, ids = []) {
        if (!normalizeKey(cid, 1)) return [];
        // Start known IDs immediately; the index also covers name-only selection
        // where the card number and its options have not been selected yet.
        const pending = ids.map(id => preload(cid, id));
        const index = await loadIndex().catch(() => null);
        const prefix = `${cid}_`;
        for (const key of Object.keys(index?.files || {})) {
            if (key.startsWith(prefix)) pending.push(preload(cid, key.slice(prefix.length)));
        }
        return Promise.all(pending);
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
        preloads.clear();
    }

    return {
        INDEX_URL, normalizeKey, storageUrl, momobakoUrl, loadIndex, resolveFromIndex, resolve,
        displayResolvedImage, display, resetIndexCache, ciidValue, label, preload, preloadCard,
    };
});
