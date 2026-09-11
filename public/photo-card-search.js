(function (root) {
    'use strict';

    const MAX_REGIONS = 100;
    const ANALYSIS_BATCH_SIZE = 10;
    const CARD_ART_CROPS = [
        { x: 0, y: 0, width: 1, height: 1 },
    ];

    function createState(purpose) {
        return {
            file: null, image: null, objectUrl: '', regions: [], selectedId: null,
            purpose, root: null, busy: false, phase: 'upload', nextId: 1, revision: 0, pixels: null,
            viewMode: 'all', editDraft: null, editDirty: false, searchUiSuspended: false,
        };
    }
    const states = { search: createState('search'), register: createState('register') };
    let state = states.search;
    let cvRuntime = null;
    let detectorRequestId = 0;
    let detectorWorker = null;
    let detectorReadyPromise = null;
    let detectorStatus = 'idle';
    const detectorPending = new Map();
    let learnedDetectorWorker = null;
    let learnedDetectorReadyPromise = null;
    let learnedDetectorRequestId = 0;
    const learnedDetectorPending = new Map();

    function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
    function iou(a, b) {
        const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
        const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
    }

    function normalizeRegions(regions, options = {}) {
        const prepared = regions
            .map(r => ({ ...r, x: clamp(r.x), y: clamp(r.y), width: clamp(r.width, 0.05), height: clamp(r.height, 0.05), score: r.score || 0 }))
            .filter(r => r.x + r.width <= 1.02 && r.y + r.height <= 1.02)
            // Oversized quads are usually a desk mat, acrylic holder or the
            // photograph boundary. If a photo truly contains only a tightly
            // cropped card, readFile() still supplies the full-image fallback.
            .filter(r => options.learned || r.width * r.height <= 0.72)
            .filter(r => {
                if (options.learned) return true;
                const touchedEdges = Number(r.x <= 0.015) + Number(r.y <= 0.015)
                    + Number(r.x + r.width >= 0.985) + Number(r.y + r.height >= 0.985);
                return touchedEdges < 2;
            });
        const areas = prepared.map(region => region.width * region.height).sort((a, b) => a - b);
        const medianArea = areas[Math.floor(areas.length / 2)] || 0;
        const sizeBalanced = !options.learned && prepared.length >= 4
            ? prepared.filter(region => region.width * region.height <= medianArea * 1.75)
            : prepared;
        return sizeBalanced
            .sort((a, b) => b.score - a.score)
            .filter((region, index, all) => !all.slice(0, index).some(kept => {
                const overlap = iou(region, kept);
                const x1 = Math.max(region.x, kept.x), y1 = Math.max(region.y, kept.y);
                const x2 = Math.min(region.x + region.width, kept.x + kept.width);
                const y2 = Math.min(region.y + region.height, kept.y + kept.height);
                const contained = Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / (region.width * region.height || 1);
                return overlap > 0.55 || contained > 0.82;
            }))
            .slice(0, MAX_REGIONS);
    }

    function sortRegionsReadingOrder(regions) {
        const rows = [];
        [...regions].sort((left, right) => (left.y + left.height / 2) - (right.y + right.height / 2)).forEach(region => {
            const centerY = region.y + region.height / 2;
            let row = rows.find(item => Math.abs(centerY - item.centerY) <= Math.max(region.height, item.averageHeight) * .42);
            if (!row) {
                row = { regions: [], centerY, averageHeight: region.height };
                rows.push(row);
            }
            row.regions.push(region);
            row.centerY = row.regions.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.regions.length;
            row.averageHeight = row.regions.reduce((sum, item) => sum + item.height, 0) / row.regions.length;
        });
        return rows.sort((left, right) => left.centerY - right.centerY)
            .flatMap(row => row.regions.sort((left, right) => (left.x + left.width / 2) - (right.x + right.width / 2)));
    }

    function orderQuad(points) {
        if (!Array.isArray(points) || points.length !== 4) return null;
        const topLeft = points.reduce((best, p) => p.x + p.y < best.x + best.y ? p : best);
        const bottomRight = points.reduce((best, p) => p.x + p.y > best.x + best.y ? p : best);
        const topRight = points.reduce((best, p) => p.x - p.y > best.x - best.y ? p : best);
        const bottomLeft = points.reduce((best, p) => p.x - p.y < best.x - best.y ? p : best);
        return [topLeft, topRight, bottomRight, bottomLeft];
    }

    function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    function regionFromQuad(points, width, height, areaRatio) {
        const ordered = orderQuad(points);
        if (!ordered || new Set(ordered).size !== 4) return null;
        const horizontal = (distance(ordered[0], ordered[1]) + distance(ordered[3], ordered[2])) / 2;
        const vertical = (distance(ordered[0], ordered[3]) + distance(ordered[1], ordered[2])) / 2;
        const ratio = Math.min(horizontal, vertical) / Math.max(horizontal, vertical);
        if (ratio < 0.52 || ratio > 0.80) return null;
        const xs = ordered.map(p => p.x), ys = ordered.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        return {
            x: minX / width, y: minY / height, width: (maxX - minX) / width, height: (maxY - minY) / height,
            polygon: ordered.map(p => ({ x: p.x / width, y: p.y / height })),
            score: areaRatio + (1 - Math.abs(ratio - 59 / 86)),
        };
    }

    async function getOpenCv() {
        const started = Date.now();
        while (!root.cv && Date.now() - started < 12000) await new Promise(resolve => setTimeout(resolve, 50));
        if (!root.cv) throw new Error('카드 영역 분석기를 불러오지 못했습니다.');
        cvRuntime = typeof root.cv.then === 'function' ? await root.cv : root.cv;
        if (!cvRuntime?.Mat) throw new Error('카드 영역 분석기를 초기화하지 못했습니다.');
        return cvRuntime;
    }

    // Lightweight edge-component detector. Identity matching never uses the frame;
    // the frame is only a locator for the artwork crops produced below.
    function detectRegionsFromImageData(imageData) {
        const { data, width, height } = imageData;
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
        const edge = new Uint8Array(gray.length);
        let total = 0, samples = 0;
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            const magnitude = Math.abs(gray[p + 1] - gray[p - 1]) + Math.abs(gray[p + width] - gray[p - width]);
            total += magnitude; samples++;
        }
        const threshold = Math.max(30, (total / Math.max(1, samples)) * 2.2);
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            const magnitude = Math.abs(gray[p + 1] - gray[p - 1]) + Math.abs(gray[p + width] - gray[p - width]);
            if (magnitude >= threshold) edge[p] = 1;
        }
        // Join small gaps so the four card edges form one component.
        const joined = edge.slice();
        for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
            const p = y * width + x;
            let count = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) count += edge[p + dy * width + dx];
            if (count >= 3) joined[p] = 1;
        }
        const visited = new Uint8Array(joined.length), found = [];
        for (let start = 0; start < joined.length; start++) {
            if (!joined[start] || visited[start]) continue;
            const queue = [start]; visited[start] = 1;
            let head = 0, minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
            while (head < queue.length) {
                const p = queue[head++], x = p % width, y = Math.floor(p / width);
                minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
                for (const offset of [-1, 1, -width, width]) {
                    const n = p + offset;
                    if (n < 0 || n >= joined.length || visited[n] || !joined[n]) continue;
                    if ((offset === -1 || offset === 1) && Math.floor(n / width) !== y) continue;
                    visited[n] = 1; queue.push(n);
                }
            }
            const boxW = maxX - minX + 1, boxH = maxY - minY + 1, area = boxW * boxH;
            const areaRatio = area / (width * height), ratio = Math.min(boxW, boxH) / Math.max(boxW, boxH);
            const density = count / area;
            if (areaRatio >= 0.025 && areaRatio <= 0.92 && ratio >= 0.48 && ratio <= 0.82 && density >= 0.025) {
                found.push({ x: minX / width, y: minY / height, width: boxW / width, height: boxH / height, score: areaRatio + density });
            }
        }
        return normalizeRegions(found);
    }

    function ensureDetectorWorker() {
        if (detectorReadyPromise) return detectorReadyPromise;
        detectorStatus = 'loading';
        detectorWorker = new Worker('photo-card-worker.js?v=23');
        detectorReadyPromise = new Promise((resolve, reject) => {
            const initializationTimer = setTimeout(() => reject(new Error('OpenCV 초기화가 120초를 초과했습니다.')), 120000);
            detectorWorker.onmessage = event => {
                const message = event.data || {};
                if (message.type === 'progress') {
                    console.info(`[PhotoCardSearch] OpenCV Worker: ${JSON.stringify(message)}`);
                    return;
                }
                if (message.type === 'ready') {
                    clearTimeout(initializationTimer);
                    detectorStatus = 'ready';
                    console.info('[PhotoCardSearch] OpenCV Worker ready');
                    resolve(detectorWorker);
                    return;
                }
                if (message.type === 'init-error') {
                    clearTimeout(initializationTimer);
                    detectorStatus = 'error';
                    reject(new Error(`OpenCV 초기화 실패: ${message.error}`));
                    return;
                }
                if (message.type !== 'result') return;
                const pending = detectorPending.get(message.requestId);
                if (!pending) return;
                detectorPending.delete(message.requestId);
                clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(`OpenCV 분석 실패: ${message.error}`));
                else pending.resolve(normalizeRegions(message.regions || []));
            };
            detectorWorker.onerror = event => {
                clearTimeout(initializationTimer);
                detectorStatus = 'error';
                const error = new Error(`OpenCV Worker 오류: ${event.message || '알 수 없는 오류'}`);
                detectorPending.forEach(pending => { clearTimeout(pending.timer); pending.reject(error); });
                detectorPending.clear();
                reject(error);
            };
            detectorWorker.postMessage({ type: 'init' });
        });
        return detectorReadyPromise;
    }

    async function detectWithOpenCv(imageData) {
        const worker = await ensureDetectorWorker();
        const requestId = ++detectorRequestId;
        detectorStatus = 'analyzing';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                detectorPending.delete(requestId);
                reject(new Error('OpenCV 사진 분석이 30초를 초과했습니다.'));
            }, 30000);
            detectorPending.set(requestId, {
                resolve: regions => { detectorStatus = 'ready'; resolve(regions); },
                reject: error => { detectorStatus = 'ready'; reject(error); },
                timer,
            });
            worker.postMessage({ type: 'analyze', requestId, imageData });
        });
    }

    function ensureLearnedDetectorWorker() {
        if (learnedDetectorReadyPromise) return learnedDetectorReadyPromise;
        learnedDetectorWorker = new Worker('photo-card-model-worker.js?v=2');
        learnedDetectorReadyPromise = new Promise((resolve, reject) => {
            const worker = learnedDetectorWorker;
            const fail = error => {
                clearTimeout(timer); worker.terminate();
                learnedDetectorPending.forEach(pending => { clearTimeout(pending.timer); pending.reject(error); });
                learnedDetectorPending.clear(); learnedDetectorReadyPromise = null; learnedDetectorWorker = null;
                reject(error);
            };
            const timer = setTimeout(() => fail(new Error('학습형 카드 검출기 초기화가 120초를 초과했습니다.')), 120000);
            learnedDetectorWorker.onmessage = event => {
                const message = event.data || {};
                if (message.type === 'progress') {
                    console.info(`[PhotoCardSearch] DRAW 2: ${message.stage}`);
                    return;
                }
                if (message.type === 'ready') {
                    clearTimeout(timer);
                    resolve(learnedDetectorWorker);
                    return;
                }
                if (message.type === 'init-error') {
                    fail(new Error(`학습형 카드 검출기 초기화 실패: ${message.error}`));
                    return;
                }
                if (message.type !== 'result') return;
                const pending = learnedDetectorPending.get(message.requestId);
                if (!pending) return;
                learnedDetectorPending.delete(message.requestId);
                clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(`학습형 카드 검출 실패: ${message.error}`));
                else pending.resolve(normalizeRegions(message.regions || [], { learned: true }));
            };
            learnedDetectorWorker.onerror = event => {
                fail(new Error(`학습형 카드 검출기 오류: ${event.message || '알 수 없는 오류'}`));
            };
            learnedDetectorWorker.postMessage({ type: 'init' });
        });
        return learnedDetectorReadyPromise;
    }

    async function detectWithLearnedModel(imageData) {
        const worker = await ensureLearnedDetectorWorker();
        const requestId = ++learnedDetectorRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                learnedDetectorPending.delete(requestId);
                worker.terminate(); learnedDetectorWorker = null; learnedDetectorReadyPromise = null;
                reject(new Error('학습형 카드 검출이 30초를 초과했습니다.'));
            }, 30000);
            learnedDetectorPending.set(requestId, { resolve, reject, timer });
            worker.postMessage({ type: 'analyze', requestId, imageData });
        });
    }

    async function detectRegions(image) {
        // Keep narrow gaps between adjacent cards and sleeve borders intact.
        // The former 480px cap erased these features before OpenCV saw them.
        const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        if (typeof Worker !== 'function') return detectRegionsFromImageData(imageData);
        try {
            const learnedRegions = await detectWithLearnedModel(imageData);
            if (learnedRegions.length) return learnedRegions;
            console.warn('[PhotoCardSearch] DRAW 2가 카드 영역을 찾지 못해 OpenCV로 전환합니다.');
        } catch (learnedError) {
            console.warn('[PhotoCardSearch]', learnedError);
        }
        try {
            return await detectWithOpenCv(imageData);
        } catch (openCvError) {
            console.warn('[PhotoCardSearch]', openCvError);
            if (typeof showToast === 'function') showToast('학습형·OpenCV 검출에 실패해 경량 검출기로 전환합니다.', 'toast-error');
            return detectRegionsFromImageData(imageData);
        }
    }

    function makeRegion(box, source = 'auto') {
        return { id: `photo-region-${state.nextId++}`, source, ...box, status: 'unresolved', candidates: [], searchCrops: [], selected: null, manualName: '', reviewed: false };
    }

    function regionPolygon(region) {
        const { x, y, width, height } = region;
        return (region.polygon || [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }])
            .map(point => ({ x: clamp(point.x), y: clamp(point.y) }));
    }

    function boundsFromPolygon(polygon) {
        const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, width: Math.max(.01, Math.max(...xs) - x), height: Math.max(.01, Math.max(...ys) - y) };
    }

    function orderedRegionPolygon(region) {
        const polygon = regionPolygon(region);
        const ordered = orderQuad(polygon);
        return ordered && new Set(ordered).size === 4 ? ordered.map(point => ({ ...point })) : polygon;
    }

    function beginRegionEdit(region, scrollPosition = null) {
        state.selectedId = region.id;
        state.viewMode = 'edit';
        state.editDraft = orderedRegionPolygon(region);
        state.editDirty = false;
        render();
        if (scrollPosition) requestAnimationFrame(() => {
            const scroll = state.root?.querySelector('.photo-region-grid-scroll');
            if (scroll) {
                scroll.scrollLeft = scrollPosition.left || 0;
                scroll.scrollTop = scrollPosition.top || 0;
            }
        });
    }

    function cancelRegionEdit() {
        const region = state.regions.find(item => item.id === state.selectedId);
        if (!region) return;
        state.editDraft = orderedRegionPolygon(region);
        state.editDirty = false;
        render();
    }

    function confirmRegionEdit() {
        if (!state.editDirty || !state.editDraft) return;
        const region = state.regions.find(item => item.id === state.selectedId);
        if (!region) return;
        const polygon = orderedRegionPolygon({ ...region, polygon: state.editDraft });
        Object.assign(region, boundsFromPolygon(polygon), { polygon, candidates: [], searchCrops: [], selected: null, status: 'unresolved', reviewed: false, thumbnail: '' });
        state.editDirty = false;
        render();
    }

    function showAllRegions() {
        state.viewMode = 'all';
        state.selectedId = null;
        state.editDraft = null;
        state.editDirty = false;
        render();
    }

    function removeRegion(regionId) {
        state.regions = state.regions.filter(region => region.id !== regionId);
        if (state.selectedId === regionId) showAllRegions();
        else render();
    }

    function regionThumbnail(region) {
        if (!state.image) return '';
        if (region.thumbnail) return region.thumbnail;
        const canvas = document.createElement('canvas');
        canvas.width = 120; canvas.height = 120;
        const context = canvas.getContext('2d');
        if (root.PhotoCardGeometry) {
            try {
                if (!state.pixels) {
                    const source = document.createElement('canvas');
                    const scale = Math.min(1, 1800 / Math.max(state.image.naturalWidth, state.image.naturalHeight));
                    source.width = Math.round(state.image.naturalWidth * scale);
                    source.height = Math.round(state.image.naturalHeight * scale);
                    const sourceContext = source.getContext('2d', { willReadFrequently: true });
                    sourceContext.drawImage(state.image, 0, 0, source.width, source.height);
                    state.pixels = sourceContext.getImageData(0, 0, source.width, source.height);
                }
                const crop = root.PhotoCardGeometry.cropPixels(
                    state.pixels,
                    regionPolygon(region),
                    { x: 0, y: 0, width: 1, height: 1 },
                    120,
                    120,
                );
                context.putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);
                region.thumbnail = canvas.toDataURL('image/jpeg', .82);
                return region.thumbnail;
            } catch (error) {
                console.warn('[PhotoCardSearch] 영역 썸네일 원근 보정 실패', error);
            }
        }
        const padding = .04;
        const x = clamp(region.x - padding), y = clamp(region.y - padding);
        const width = Math.min(1 - x, region.width + padding * 2), height = Math.min(1 - y, region.height + padding * 2);
        const sourceRatio = (width * state.image.naturalWidth) / (height * state.image.naturalHeight);
        let drawWidth = 120, drawHeight = 120, dx = 0, dy = 0;
        if (sourceRatio > 1) { drawHeight = 120 / sourceRatio; dy = (120 - drawHeight) / 2; }
        else { drawWidth = 120 * sourceRatio; dx = (120 - drawWidth) / 2; }
        context.fillStyle = '#111'; context.fillRect(0, 0, 120, 120);
        context.drawImage(state.image, x * state.image.naturalWidth, y * state.image.naturalHeight,
            width * state.image.naturalWidth, height * state.image.naturalHeight, dx, dy, drawWidth, drawHeight);
        region.thumbnail = canvas.toDataURL('image/jpeg', .78);
        return region.thumbnail;
    }

    function previewLayerStyle(region = null, maximumWidth = null) {
        const aspect = state.image.naturalWidth / state.image.naturalHeight;
        if (!region) {
            const width = aspect >= 1 ? 100 : 100 * aspect;
            const height = aspect >= 1 ? 100 / aspect : 100;
            return `left:${(100 - width) / 2}%;top:${(100 - height) / 2}%;width:${width}%;height:${height}%;`;
        }
        const bounds = boundsFromPolygon(state.editDraft || regionPolygon(region));
        let width = 78 / Math.max(bounds.width, bounds.height / aspect);
        if (Number.isFinite(maximumWidth)) width = Math.min(width, maximumWidth);
        const height = width / aspect;
        const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
        return `left:${50 - width * centerX}%;top:${50 - height * centerY}%;width:${width}%;height:${height}%;`;
    }

    function renderPreview(editing, showAllFrames = true) {
        const selected = state.regions.find(region => region.id === state.selectedId);
        const layerStyle = previewLayerStyle(editing ? selected : null);
        let overlays = '';
        if (editing && selected && state.editDraft) {
            const points = state.editDraft.map(point => `${point.x * 1000},${point.y * 1000}`).join(' ');
            const handles = state.editDraft.map((point, index) => `<button type="button" class="photo-region-handle corner-${index}" data-handle="${index}" aria-label="${index + 1}번 꼭짓점" style="left:${point.x * 100}%;top:${point.y * 100}%"></button>`).join('');
            overlays = `<svg class="photo-region-edit-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none"><polygon points="${points}"></polygon></svg>${handles}`;
        } else if (showAllFrames) {
            overlays = state.regions.map((region, index) => {
                const clip = region.polygon ? `clip-path:polygon(${region.polygon.map(point => `${((point.x - region.x) / region.width) * 100}% ${((point.y - region.y) / region.height) * 100}%`).join(',')});` : '';
                const resolved = Boolean(region.reviewed && (region.selected || (region.status === 'manual' && region.manualName.trim())));
                return `<button type="button" class="photo-region-box${region.id === state.selectedId ? ' selected' : ''}${resolved ? ' resolved' : ''}" data-region-id="${region.id}" style="left:${region.x * 100}%;top:${region.y * 100}%;width:${region.width * 100}%;height:${region.height * 100}%;${clip}"><span>${index + 1}</span></button>`;
            }).join('');
        }
        return `<div class="photo-preview"><div class="photo-image-layer" style="${layerStyle}"><img src="${state.objectUrl}" alt="분석할 사진">${overlays}</div></div>`;
    }

    function cropArtwork(image, region, pattern) {
        if (root.PhotoCardGeometry) {
            if (!state.pixels) {
                const source = document.createElement('canvas');
                const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
                source.width = Math.round(image.naturalWidth * scale); source.height = Math.round(image.naturalHeight * scale);
                const ctx = source.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0, source.width, source.height);
                state.pixels = ctx.getImageData(0, 0, source.width, source.height);
            }
            const {x,y,width,height} = region;
            const polygon = region.polygon || [{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}];
            const crop = root.PhotoCardGeometry.cropPixels(state.pixels, polygon, pattern, 224, 224);
            const canvas = document.createElement('canvas'); canvas.width=crop.width; canvas.height=crop.height;
            canvas.getContext('2d').putImageData(new ImageData(crop.data,crop.width,crop.height),0,0);
            return canvas.toDataURL('image/jpeg', .9);
        }
        let rx = region.x, ry = region.y, rw = region.width, rh = region.height;
        // Axis-aligned portrait/landscape correction for 90-degree photos.
        const landscape = rw > rh;
        const canvas = document.createElement('canvas');
        canvas.width = 224; canvas.height = 224;
        const context = canvas.getContext('2d');
        if (!landscape) {
            context.drawImage(image,
                (rx + rw * pattern.x) * image.naturalWidth, (ry + rh * pattern.y) * image.naturalHeight,
                rw * pattern.width * image.naturalWidth, rh * pattern.height * image.naturalHeight,
                0, 0, canvas.width, canvas.height);
        } else {
            context.save(); context.translate(canvas.width, 0); context.rotate(Math.PI / 2);
            context.drawImage(image,
                (rx + rw * pattern.y) * image.naturalWidth, (ry + rh * (1 - pattern.x - pattern.width)) * image.naturalHeight,
                rw * pattern.height * image.naturalWidth, rh * pattern.width * image.naturalHeight,
                0, 0, canvas.height, canvas.width);
            context.restore();
        }
        return canvas.toDataURL('image/jpeg', 0.86);
    }

    function cropPerspectiveArtwork(image, region, pattern) {
        const cv = cvRuntime;
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight;
        sourceCanvas.getContext('2d').drawImage(image, 0, 0);
        const source = cv.imread(sourceCanvas), warped = new cv.Mat();
        const points = orderQuad(region.polygon).map(point => ({ x: point.x * image.naturalWidth, y: point.y * image.naturalHeight }));
        const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, points.flatMap(point => [point.x, point.y]));
        const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 590, 0, 590, 860, 0, 860]);
        const transform = cv.getPerspectiveTransform(srcPoints, dstPoints);
        cv.warpPerspective(source, warped, transform, new cv.Size(590, 860), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        const rect = new cv.Rect(Math.round(pattern.x * 590), Math.round(pattern.y * 860), Math.round(pattern.width * 590), Math.round(pattern.height * 860));
        const artwork = warped.roi(rect), output = document.createElement('canvas');
        cv.imshow(output, artwork);
        const resized = document.createElement('canvas'); resized.width = 224; resized.height = 224;
        resized.getContext('2d').drawImage(output, 0, 0, 224, 224);
        artwork.delete(); transform.delete(); srcPoints.delete(); dstPoints.delete(); warped.delete(); source.delete();
        return resized.toDataURL('image/jpeg', 0.9);
    }

    async function readFile(file) {
        if (!file || !file.type.startsWith('image/')) throw new Error('이미지 파일을 선택해주세요.');
        if (file.size > 12 * 1024 * 1024) throw new Error('사진은 12MB 이하여야 합니다.');
        const revision = ++state.revision;
        state.busy = false; state.phase = 'detecting'; state.image = null; state.pixels = null;
        syncSearchControls(); keepDesktopPhotoPanelOpen(); render();
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = URL.createObjectURL(file);
        const image = new Image();
        try {
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('사진을 열 수 없습니다.')); image.src = state.objectUrl; });
        } catch (error) { if (revision === state.revision) { state.phase = 'upload'; syncSearchControls(); render(); } throw error; }
        if (revision !== state.revision) return;
        state.file = file; state.image = image; state.regions = []; state.selectedId = null;
        state.phase = 'detecting';
        keepDesktopPhotoPanelOpen(); render();
        try {
            const detected = await detectRegions(image);
            if (revision !== state.revision) return;
            state.regions = sortRegionsReadingOrder((detected.length ? detected : [{ x: 0, y: 0, width: 1, height: 1, score: 0 }]).map(box => makeRegion(box)));
            state.selectedId = null;
            state.viewMode = 'all'; state.editDraft = null; state.editDirty = false;
            state.phase = 'selecting';
        } catch (error) {
            if (revision !== state.revision) return;
            state.phase = 'upload'; state.image = null; state.file = null; syncSearchControls();
            throw error;
        } finally { if (revision === state.revision) render(); }
    }

    async function candidateName(cid) {
        try {
            const response = await callApi('getCardMetadata', { cid });
            const language = typeof extractLangData === 'function' ? extractLangData(response) : null;
            return language?.[0] || response?.name || `CID ${cid}`;
        } catch (_) { return `CID ${cid}`; }
    }

    async function analyze() {
        if (!state.image || state.busy) return;
        if (!state.regions.length) {
            if (typeof showToast === 'function') showToast('분석할 영역을 하나 이상 추가해주세요.', 'toast-warn');
            return;
        }
        const revision = state.revision;
        state.busy = true; render();
        try {
            state.regions = sortRegionsReadingOrder(state.regions);
            const images = [];
            state.regions.forEach(region => {
                region.searchCrops = CARD_ART_CROPS.map(pattern => cropArtwork(state.image, region, pattern));
                images.push(...region.searchCrops);
            });
            const analyzedRegions = [];
            for (let offset = 0; offset < images.length; offset += ANALYSIS_BATCH_SIZE) {
                const response = await callApi('searchCardByImage', {}, {
                    images: images.slice(offset, offset + ANALYSIS_BATCH_SIZE),
                    maxResults: 5,
                });
                if (revision !== state.revision) return;
                if (!response?.success) throw new Error(response?.message || '사진 분석에 실패했습니다.');
                if (!Array.isArray(response.regions)) throw new Error('사진 검색 서버 응답을 확인해주세요.');
                analyzedRegions.push(...response.regions);
            }
            for (let regionIndex = 0; regionIndex < state.regions.length; regionIndex++) {
                const candidates = (analyzedRegions[regionIndex]?.matches || []).slice(0, 5);
                await Promise.all(candidates.map(async candidate => {
                    if (candidate.cid) candidate.cardName = await candidateName(candidate.cid);
                }));
                if (revision !== state.revision) return;
                state.regions[regionIndex].candidates = candidates;
                state.regions[regionIndex].reviewed = false;
                if (candidates.length) {
                    const candidate = candidates[0];
                    state.regions[regionIndex].selected = {
                        cid: candidate.cid ? String(candidate.cid) : null,
                        passcode: candidate.passcode,
                        ciid: Number(candidate.ciid),
                        cardName: candidate.cardName,
                    };
                    state.regions[regionIndex].manualName = '';
                    state.regions[regionIndex].status = 'matched';
                } else {
                    state.regions[regionIndex].selected = null;
                    state.regions[regionIndex].status = 'manual';
                }
            }
            if (!state.selectedId) state.selectedId = state.regions[0]?.id || null;
        } catch (error) {
            if (typeof showToast === 'function') showToast(error.message, 'toast-error');
        } finally { if (revision === state.revision) { state.busy = false; render(); } }
    }

    function selectCandidate(region, candidate) {
        const scrollTop = state.root?.querySelector('.photo-editor-content')?.scrollTop || 0;
        region.selected = { cid: candidate.cid ? String(candidate.cid) : null, passcode: candidate.passcode, ciid: Number(candidate.ciid), cardName: candidate.cardName };
        region.manualName = ''; region.status = 'matched'; render();
        requestAnimationFrame(() => {
            const content = state.root?.querySelector('.photo-editor-content');
            if (content) content.scrollTop = scrollTop;
        });
    }

    function moveSelectedRegion(direction) {
        if (!state.regions.length) return;
        const current = Math.max(0, state.regions.findIndex(region => region.id === state.selectedId));
        const next = (current + direction + state.regions.length) % state.regions.length;
        state.selectedId = state.regions[next].id;
        render();
    }

    function regionNavigation(className = '') {
        if (state.regions.length <= 1) return '';
        return `<span class="photo-region-navigation ${className}"><button type="button" data-region-previous aria-label="이전 카드"><i class="material-icons">chevron_left</i></button><button type="button" data-region-next aria-label="다음 카드"><i class="material-icons">chevron_right</i></button></span>`;
    }

    function bindMobileScrollIndicator(element) {
        if (!element) return;
        let scrollFadeTimer = null;
        element.addEventListener('scroll', () => {
            element.classList.add('is-scrolling');
            clearTimeout(scrollFadeTimer);
            scrollFadeTimer = setTimeout(() => element.classList.remove('is-scrolling'), 650);
        }, { passive: true });
    }

    function closeManualNameSheet() {
        const sheet = document.getElementById('photo-manual-sheet');
        if (!sheet) return;
        sheet.classList.remove('visible');
        state.root?.closest('.photo-search-sheet-panel')?.removeAttribute('inert');
        setTimeout(() => sheet.classList.remove('open'), 300);
    }

    function openManualNameSheet(region) {
        let sheet = document.getElementById('photo-manual-sheet');
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.id = 'photo-manual-sheet';
            sheet.className = 'photo-manual-sheet';
            sheet.innerHTML = '<div class="photo-manual-backdrop"></div><div class="photo-manual-panel"><div class="photo-manual-illustration"><i class="material-icons">edit</i></div><input class="photo-manual-input" type="text" placeholder="카드 이름 직접 입력"><div class="photo-manual-actions"><button type="button" class="btn-flat" data-manual-cancel>취소</button><button type="button" class="btn cyan-theme" data-manual-confirm>확인</button></div></div>';
            document.body.append(sheet);
            sheet.querySelector('.photo-manual-backdrop').onclick = closeManualNameSheet;
            sheet.querySelector('[data-manual-cancel]').onclick = closeManualNameSheet;
        }
        const input = sheet.querySelector('.photo-manual-input');
        input.value = region.manualName || '';
        const confirm = () => {
            const value = input.value.trim();
            if (!value) return;
            region.selected = null;
            region.manualName = value;
            region.status = 'manual';
            region.reviewed = true;
            closeManualNameSheet();
            render();
        };
        sheet.querySelector('[data-manual-confirm]').onclick = confirm;
        input.onkeydown = event => { if (event.key === 'Enter') confirm(); };
        state.root?.closest('.photo-search-sheet-panel')?.setAttribute('inert', '');
        sheet.classList.add('open');
        requestAnimationFrame(() => { sheet.classList.add('visible'); input.focus(); });
    }

    function returnToRegionSetup() {
        state.regions.forEach(region => Object.assign(region, {
            candidates: [], searchCrops: [], selected: null, manualName: '', status: 'unresolved', reviewed: false,
        }));
        state.selectedId = null; state.viewMode = 'all'; state.editDraft = null;
        state.editDirty = false;
        render();
    }

    function searchSelectedCandidate() {
        const region = state.regions.find(item => item.id === state.selectedId) || state.regions[0];
        const manualQuery = region?.status === 'manual' ? region.manualName.trim() : '';
        if (manualQuery) {
            dismissPhotoSearch();
            const input = document.getElementById('card-search');
            if (input) input.value = manualQuery;
            if (typeof root.startSearch === 'function') root.startSearch(true, 'auto', false);
            else document.getElementById('search-btn')?.click();
            return;
        }
        if (!region?.selected?.cid) {
            if (typeof showToast === 'function') showToast('검색할 카드 후보를 선택해주세요.', 'toast-warn');
            return;
        }
        const cid = region.selected.cid;
        dismissPhotoSearch();
        renderTargetByCid(cid);
    }

    function addRegion() {
        if (state.regions.length >= MAX_REGIONS) return;
        const offset = Math.min(.08, state.regions.length * .008);
        const region = makeRegion({ x: .29 + offset, y: .19 + offset, width: .42, height: .62, score: 0 }, 'manual');
        state.regions.push(region);
        beginRegionEdit(region);
    }

    function removeSelected() {
        if (state.regions.length <= 1) return;
        state.regions = state.regions.filter(region => region.id !== state.selectedId);
        state.selectedId = state.regions[0]?.id || null; render();
    }

    function bindRegionEditor(host) {
        const layer = host.querySelector('.photo-image-layer');
        const overlay = host.querySelector('.photo-region-edit-overlay');
        if (!layer || !overlay || !state.editDraft) return;
        layer.querySelectorAll('[data-handle]').forEach(handle => {
            handle.addEventListener('pointerdown', event => {
                event.preventDefault();
                const index = Number(handle.dataset.handle);
                const initialRect = layer.getBoundingClientRect();
                const pointerOffset = {
                    x: initialRect.left + state.editDraft[index].x * initialRect.width - event.clientX,
                    y: initialRect.top + state.editDraft[index].y * initialRect.height - event.clientY,
                };
                handle.setPointerCapture(event.pointerId);
                const move = moveEvent => {
                    const rect = layer.getBoundingClientRect();
                    state.editDraft[index] = {
                        x: clamp((moveEvent.clientX + pointerOffset.x - rect.left) / rect.width),
                        y: clamp((moveEvent.clientY + pointerOffset.y - rect.top) / rect.height),
                    };
                    state.editDirty = true;
                    const polygon = overlay.querySelector('polygon');
                    polygon?.setAttribute('points', state.editDraft.map(point => `${point.x * 1000},${point.y * 1000}`).join(' '));
                    handle.style.left = `${state.editDraft[index].x * 100}%`;
                    handle.style.top = `${state.editDraft[index].y * 100}%`;
                    host.querySelector('[data-cancel-edit]')?.removeAttribute('disabled');
                    host.querySelector('[data-confirm-edit]')?.removeAttribute('disabled');
                    host.querySelector('[data-analyze]')?.setAttribute('disabled', '');
                    const previewRect = layer.closest('.photo-preview')?.getBoundingClientRect();
                    const safeZone = 28;
                    if (previewRect && (moveEvent.clientX <= previewRect.left + safeZone
                        || moveEvent.clientX >= previewRect.right - safeZone
                        || moveEvent.clientY <= previewRect.top + safeZone
                        || moveEvent.clientY >= previewRect.bottom - safeZone)) {
                        const currentWidth = (layer.getBoundingClientRect().width / previewRect.width) * 100;
                        layer.style.cssText = previewLayerStyle(state.regions.find(region => region.id === state.selectedId), currentWidth);
                    }
                };
                const end = () => {
                    layer.style.cssText = previewLayerStyle(state.regions.find(region => region.id === state.selectedId));
                    handle.removeEventListener('pointermove', move);
                    handle.removeEventListener('pointerup', end);
                    handle.removeEventListener('pointercancel', end);
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', end);
                handle.addEventListener('pointercancel', end);
            });
        });
    }

    async function finishRegistration() {
        const resolved = state.regions.map(region => region.selected || (region.manualName.trim() ? { cardName: region.manualName.trim(), ciid: 1 } : null));
        if (resolved.some(item => !item)) { showToast('모든 영역의 카드 이름을 확정해주세요.', 'toast-warn'); return; }
        const mobile = document.documentElement.classList.contains('is-mobile-device');
        const list = document.getElementById(mobile ? 'mobile-cards-list-general' : 'desktop-cards-list-general');
        if (!list) return;
        list.innerHTML = '';
        const prepared = resolved.map(item => {
            const row = mobile ? mobileAddEntry('add', 'general') : desktopAddEntry('add', 'general');
            const nameInput = row?.querySelector('[data-field="name"]');
            if (nameInput) nameInput.value = item.cardName;
            return { item, row, nameInput };
        });
        if (mobile) closeRegistrationSheet(false);
        switchAddSubMode('general');
        await Promise.allSettled(prepared.map(async ({ item, row, nameInput }) => {
            if (!row || !nameInput) return;
            await fetchCardByName(nameInput, true);
            const illustration = row.querySelector('[data-field="illust"]');
            if (illustration && item.ciid) {
                setIllustrationValue(illustration, String(item.ciid));
                illustration.dataset.raw = String(item.ciid);
            }
        }));
    }

    function render() {
        const host = state.root;
        if (!host) return;
        if (state.phase === 'detecting' || state.busy) {
            host.innerHTML = `<div class="photo-detection-loading" role="status" aria-live="polite"><div class="photo-detection-spinner"></div><strong>${state.busy ? '일러스트를 비교하고 있습니다' : '사진에서 카드 영역을 찾고 있습니다'}</strong><span>분석이 완료되면 카드 후보를 표시합니다.</span></div>`;
            return;
        }
        if (!state.image) {
            host.innerHTML = `<div class="photo-upload-panel"><i class="material-icons">add_photo_alternate</i><strong>카드가 보이는 사진을 추가하세요</strong><span>한 장에서 여러 카드를 인식할 수 있습니다.</span><div class="photo-upload-actions"><label class="btn cyan-theme">이미지 업로드<input type="file" accept="image/*" data-photo-file hidden></label><label class="btn-flat">사진 촬영<input type="file" accept="image/*" capture="environment" data-photo-file hidden></label></div></div>`;
            host.querySelectorAll('[data-photo-file]').forEach(input => input.onchange = event => readFile(event.target.files[0]).catch(error => showToast(error.message, 'toast-error')));
            return;
        }
        const selected = state.regions.find(region => region.id === state.selectedId) || state.regions[0];
        const mobileLayout = document.documentElement.classList.contains('is-mobile-device');
        const regionSetupPhase = !state.regions.some(region => region.searchCrops?.length);
        if (regionSetupPhase) {
            const editing = state.viewMode === 'edit' && Boolean(state.regions.find(region => region.id === state.selectedId));
            const thumbnails = state.regions.map((region, index) => `<div class="photo-region-thumb-item${region.id === state.selectedId ? ' selected' : ''}"><button type="button" class="photo-region-thumb" data-edit-region="${region.id}" aria-label="${index + 1}번 영역 편집"><img src="${regionThumbnail(region)}" alt=""></button><button type="button" class="photo-region-thumb-remove" data-remove-region-id="${region.id}" aria-label="${index + 1}번 영역 제거"><i class="material-icons">close</i></button></div>`).join('');
            const preview = renderPreview(editing);
            const showAllAction = editing ? '<button type="button" class="photo-show-all" data-show-all>전체 보기</button>' : '';
            const editActions = editing ? `<div class="photo-region-edit-actions"><button type="button" class="photo-region-cancel" data-cancel-edit ${state.editDirty ? '' : 'disabled'}>취소</button><button type="button" class="photo-region-save" data-confirm-edit ${state.editDirty ? '' : 'disabled'}>저장</button></div>` : '';
            const mobileEditActions = editing ? `<div class="mobile-photo-region-edit-actions"><button type="button" data-show-all aria-label="전체 보기"><i class="material-icons">fullscreen</i></button><button type="button" data-cancel-edit aria-label="되돌리기" ${state.editDirty ? '' : 'disabled'}><i class="material-icons">undo</i></button><button type="button" data-confirm-edit aria-label="저장" ${state.editDirty ? '' : 'disabled'}><i class="material-icons">check</i></button></div>` : '';
            const addRegionButton = `<button type="button" class="photo-region-add" data-add-region ${state.regions.length >= MAX_REGIONS ? 'disabled' : ''}><i class="material-icons">add</i><span>추가하기</span></button>`;
            const regionSetup = `<div class="photo-region-setup"><div class="photo-region-grid-scroll"><div class="photo-region-grid">${addRegionButton}${thumbnails}</div></div></div>`;
            const desktopSetupMarkup = `<div class="photo-analysis-layout photo-region-setup-layout"><div class="photo-analysis-left">${preview}<div class="photo-region-meta-row">${showAllAction}${editActions}</div></div><section class="photo-candidate-panel">${regionSetup}<div class="photo-analysis-actions"><button type="button" class="btn-flat photo-image-select" data-replace>이미지 변경</button><button type="button" class="btn cyan-theme" data-analyze ${state.regions.length && !state.editDirty ? '' : 'disabled'}>분석 시작</button></div></section></div>`;
            const mobileSetupMarkup = `<div class="photo-analysis-layout photo-region-setup-layout mobile-photo-region-setup"><div class="photo-analysis-left">${preview}${mobileEditActions}</div><section class="photo-candidate-panel">${regionSetup}<div class="photo-analysis-actions"><button type="button" class="btn-flat photo-image-select" data-replace>이미지 변경</button><button type="button" class="btn cyan-theme" data-analyze ${state.regions.length && !state.editDirty ? '' : 'disabled'}>분석 시작</button></div></section></div>`;
            host.innerHTML = mobileLayout ? mobileSetupMarkup : desktopSetupMarkup;
            host.querySelector('[data-show-all]')?.addEventListener('click', showAllRegions);
            host.querySelectorAll('[data-region-id]').forEach(button => button.onclick = () => {
                const region = state.regions.find(item => item.id === button.dataset.regionId);
                if (region) beginRegionEdit(region);
            });
            host.querySelectorAll('[data-edit-region]').forEach(button => button.onclick = () => {
                const region = state.regions.find(item => item.id === button.dataset.editRegion);
                const scroll = host.querySelector('.photo-region-grid-scroll');
                const scrollPosition = { left: scroll?.scrollLeft || 0, top: scroll?.scrollTop || 0 };
                if (region) beginRegionEdit(region, scrollPosition);
            });
            host.querySelectorAll('[data-remove-region-id]').forEach(button => button.onclick = event => {
                event.stopPropagation(); removeRegion(button.dataset.removeRegionId);
            });
            host.querySelector('[data-add-region]').onclick = addRegion;
            host.querySelector('[data-replace]').onclick = resetPhoto;
            host.querySelector('[data-analyze]').onclick = analyze;
            host.querySelector('[data-cancel-edit]')?.addEventListener('click', cancelRegionEdit);
            host.querySelector('[data-confirm-edit]')?.addEventListener('click', confirmRegionEdit);
            if (mobileLayout) bindMobileScrollIndicator(host.querySelector('.photo-region-grid-scroll'));
            bindRegionEditor(host);
            syncDesktopPanelHeight();
            return;
        }
        selected.reviewed = true;
        const boxes = state.regions.map((region, index) => {
            const clip = region.polygon ? `clip-path:polygon(${region.polygon.map(point => `${((point.x - region.x) / region.width) * 100}% ${((point.y - region.y) / region.height) * 100}%`).join(',')});` : '';
            const resolved = Boolean(region.reviewed && (region.selected || (region.status === 'manual' && region.manualName.trim())));
            return `<button type="button" class="photo-region-box${region.id === state.selectedId ? ' selected' : ''}${resolved ? ' resolved' : ''}" data-region-id="${region.id}" style="left:${region.x * 100}%;top:${region.y * 100}%;width:${region.width * 100}%;height:${region.height * 100}%;${clip}"><span>${index + 1}</span></button>`;
        }).join('');
        const desktopCandidates = selected.candidates.length ? selected.candidates.map((candidate, index) => {
            const candidateSelected = selected.selected?.passcode === candidate.passcode;
            return `<div class="photo-candidate-row"><button type="button" class="photo-candidate${candidateSelected ? ' selected' : ''}" data-candidate="${index}"><span class="photo-candidate-image" ${candidate.cid ? `data-cid="${candidate.cid}" data-ciid="${candidate.ciid}"` : ''}></span><span><strong>${escapeHTML(candidate.cardName)}</strong><small>${(Number(candidate.score || 0) * 100).toFixed(2)}%</small></span></button>${candidateSelected ? regionNavigation('photo-candidate-navigation') : ''}</div>`;
        }).join('') : '';
        const mobileCandidates = selected.candidates.length ? selected.candidates.map((candidate, index) => {
            const candidateSelected = selected.selected?.passcode === candidate.passcode;
            return `<div class="photo-candidate-row"><button type="button" class="photo-candidate${candidateSelected ? ' selected' : ''}" data-candidate="${index}" aria-label="${escapeHTML(candidate.cardName)}, ${(Number(candidate.score || 0) * 100).toFixed(2)}%"><span class="photo-candidate-image" ${candidate.cid ? `data-cid="${candidate.cid}" data-ciid="${candidate.ciid}"` : ''}></span><span class="photo-candidate-score">${(Number(candidate.score || 0) * 100).toFixed(2)}%</span></button></div>`;
        }).join('') : '';
        const manualSelected = selected.status === 'manual';
        const manualCandidate = `<div class="photo-candidate-row"><div class="photo-candidate photo-manual-candidate${manualSelected ? ' selected' : ''}" data-manual-option role="button" tabindex="0"><span class="photo-candidate-image"><i class="material-icons">edit</i></span><span><input type="text" class="photo-manual-name" data-manual-name placeholder="직접 입력" value="${escapeHTML(selected.manualName)}" ${manualSelected ? '' : 'readonly aria-disabled="true"'}><small>선택지에 없는 경우 사용하세요.</small></span></div>${manualSelected ? regionNavigation('photo-candidate-navigation') : ''}</div>`;
        const candidateTitle = `${state.regions.indexOf(selected) + 1}번 카드`;
        const headingNavigation = state.regions.length > 1
            ? `<button type="button" class="photo-region-heading-nav" data-region-previous aria-label="이전 카드"><i class="material-icons">chevron_left</i></button><h6>${candidateTitle}</h6><button type="button" class="photo-region-heading-nav" data-region-next aria-label="다음 카드"><i class="material-icons">chevron_right</i></button>`
            : `<h6>${candidateTitle}</h6>`;
        const desktopCandidateList = `<div class="photo-candidate-content"><div class="photo-candidate-heading">${headingNavigation}</div><div class="photo-editor-content">${desktopCandidates}${manualCandidate}</div></div>`;
        const mobileManualCandidate = `<div class="photo-candidate-row"><button type="button" class="photo-candidate photo-manual-candidate${manualSelected ? ' selected' : ''}" data-mobile-manual-option><span class="photo-candidate-image"><i class="material-icons">edit</i></span><span class="photo-candidate-score">직접 입력</span></button></div>`;
        const mobileCandidateList = `<div class="photo-candidate-content mobile-photo-candidate-content"><div class="photo-editor-content">${mobileCandidates}${mobileManualCandidate}</div></div>`;
        const editor = mobileLayout
            ? mobileCandidateList
            : desktopCandidateList;
        const desktopLeftContent = `${renderPreview(false)}<div class="photo-region-meta-row"></div>`;
        const mobileLeftContent = `<div class="mobile-photo-preview-wrap">${renderPreview(false)}</div>`;
        const leftContent = mobileLayout ? mobileLeftContent : desktopLeftContent;
        const allRegionsResolved = state.regions.every(region => region.selected || region.manualName.trim());
        const selectedSearchReady = Boolean(selected.selected || (manualSelected && selected.manualName.trim()));
        const selectionPrimary = state.purpose === 'search'
            ? `<button type="button" class="btn cyan-theme" data-search-selected ${selectedSearchReady ? '' : 'disabled'}>검색</button>`
            : `<button type="button" class="btn cyan-theme" data-finish ${allRegionsResolved ? '' : 'disabled'}>등록 정보 작성</button>`;
        const desktopSelectionActions = `<button type="button" class="btn-flat" data-previous>이전</button>${selectionPrimary}`;
        const selectedRegionNumber = state.regions.indexOf(selected) + 1;
        const mobileRegionNavigation = `<div class="mobile-photo-footer-navigation"><button type="button" data-region-previous aria-label="이전 카드" ${state.regions.length > 1 ? '' : 'disabled'}><i class="material-icons">chevron_left</i></button><span>${selectedRegionNumber} / ${state.regions.length}</span><button type="button" data-region-next aria-label="다음 카드" ${state.regions.length > 1 ? '' : 'disabled'}><i class="material-icons">chevron_right</i></button></div>`;
        const mobileSelectionActions = `<button type="button" class="btn-flat mobile-photo-previous" data-previous>이전</button>${mobileRegionNavigation}<div class="mobile-photo-primary-action">${selectionPrimary}</div>`;
        const selectionActions = mobileLayout ? mobileSelectionActions : desktopSelectionActions;
        host.innerHTML = `<div class="photo-analysis-layout${mobileLayout ? ' mobile-photo-candidate-layout' : ''}"><div class="photo-analysis-left">${leftContent}</div><section class="photo-candidate-panel">${editor}<div class="photo-analysis-actions">${selectionActions}</div></section></div>`;
        host.querySelectorAll('[data-region-id]').forEach(button => button.onclick = () => { state.selectedId = button.dataset.regionId; render(); });
        host.querySelector('[data-add-region]')?.addEventListener('click', addRegion);
        host.querySelector('[data-remove-region]')?.addEventListener('click', removeSelected);
        host.querySelector('[data-replace]')?.addEventListener('click', resetPhoto);
        host.querySelector('[data-analyze]')?.addEventListener('click', analyze);
        host.querySelector('[data-previous]')?.addEventListener('click', returnToRegionSetup);
        host.querySelector('[data-search-selected]')?.addEventListener('click', searchSelectedCandidate);
        const noCandidate = host.querySelector('[data-no-candidate]');
        if (noCandidate) noCandidate.onclick = () => { selected.selected = null; selected.status = 'manual'; render(); };
        const manualOption = host.querySelector('[data-manual-option]');
        if (manualOption) {
            const activateManual = event => {
                if (manualSelected && event?.target?.closest('[data-manual-name]')) return;
                selected.selected = null; selected.status = 'manual'; render();
                requestAnimationFrame(() => host.querySelector('[data-manual-name]')?.focus());
            };
            manualOption.addEventListener('click', activateManual);
            manualOption.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateManual(event); }
            });
        }
        host.querySelector('[data-mobile-manual-option]')?.addEventListener('click', () => openManualNameSheet(selected));
        const manual = host.querySelector('[data-manual-name]');
        if (manual) {
            manual.oninput = () => {
                selected.manualName = manual.value; selected.status = 'manual';
                const primary = host.querySelector(state.purpose === 'search' ? '[data-search-selected]' : '[data-finish]');
                if (primary) primary.disabled = state.purpose === 'search'
                    ? !manual.value.trim()
                    : !state.regions.every(region => region.selected || region.manualName.trim());
            };
            manual.onkeydown = event => {
                if (event.key === 'Enter' && state.purpose === 'search' && manual.value.trim()) searchSelectedCandidate();
            };
        }
        host.querySelectorAll('[data-candidate]').forEach(button => button.onclick = () => {
            const candidate = selected.candidates[Number(button.dataset.candidate)];
            selectCandidate(selected, candidate);
        });
        host.querySelectorAll('[data-region-previous]').forEach(button => button.onclick = event => {
            event.preventDefault(); event.stopPropagation(); moveSelectedRegion(-1);
        });
        host.querySelectorAll('[data-region-next]').forEach(button => button.onclick = event => {
            event.preventDefault(); event.stopPropagation(); moveSelectedRegion(1);
        });
        bindMobileScrollIndicator(host.querySelector('.mobile-photo-candidate-content .photo-editor-content'));
        host.querySelectorAll('.photo-candidate-image').forEach(holder => root.IllustrationImages?.preload(holder.dataset.cid, holder.dataset.ciid).then(result => { if (result.url && holder.isConnected) { const img = new Image(); img.src = result.url; img.alt = ''; holder.append(img); } }));
        host.querySelector('[data-finish]')?.addEventListener('click', finishRegistration);
        syncDesktopPanelHeight();
    }

    function openPicker(purpose, host) {
        state = states[purpose] || states.search;
        state.root = host;
        if (!state.image && state.phase !== 'detecting') state.phase = 'upload';
        syncSearchControls();
        render();
    }

    function resetPhoto() {
        state.revision++; state.image = null; state.pixels = null; state.file = null;
        state.regions = []; state.busy = false; state.phase = 'upload';
        state.viewMode = 'all'; state.editDraft = null; state.editDirty = false; state.searchUiSuspended = false;
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = ''; syncSearchControls(); render();
    }

    function hasSearchPhoto() {
        const searchState = states.search;
        return Boolean(searchState.image || searchState.file || searchState.phase === 'detecting' || searchState.busy);
    }

    function syncSearchControls() {
        const active = hasSearchPhoto() && !states.search.searchUiSuspended;
        const desktopInput = document.getElementById('card-search');
        const mobileInput = document.getElementById('mobile-card-search');
        const desktopButton = document.getElementById('desktop-photo-search-btn');
        const mobileButton = document.getElementById('mobile-photo-search-btn');
        const wrapper = document.getElementById('search-wrapper');
        if (desktopInput) desktopInput.disabled = active;
        if (mobileInput) mobileInput.disabled = active;
        wrapper?.classList.toggle('photo-image-active', active);
        for (const button of [desktopButton, mobileButton]) {
            if (!button) continue;
            const icon = button.querySelector('.material-icons');
            if (icon) icon.textContent = button === mobileButton ? 'photo_camera' : (active ? 'cancel' : 'photo_camera');
            button.setAttribute('aria-label', active ? '사진 검색 닫기' : '사진으로 카드 검색');
        }
        if (desktopButton) desktopButton.hidden = active ? false : !(document.activeElement === desktopInput && !desktopInput?.value.trim());
    }

    function closePhotoSearch() {
        state = states.search;
        dismissPhotoSearch();
    }

    function hidePhotoSearchPreservingState() {
        state = states.search;
        const wrapper = document.getElementById('search-wrapper');
        const dropdown = document.getElementById('custom-dropdown');
        state.searchUiSuspended = true;
        closeDesktopInline();
        wrapper?.classList.remove('active', 'photo-search-open');
        wrapper?.style.setProperty('--dropdown-height', '0px');
        if (dropdown) { dropdown.classList.remove('active'); dropdown.style.display = ''; }
        syncSearchControls();
    }

    function isDesktopPanelOpen() {
        const panel = document.getElementById('desktop-photo-search-panel');
        return Boolean(panel && !panel.hidden && document.getElementById('search-wrapper')?.classList.contains('photo-search-open'));
    }

    function dismissPhotoSearch() {
        state = states.search;
        const wrapper = document.getElementById('search-wrapper');
        const input = document.getElementById('card-search');
        input?.blur();
        if (wrapper) wrapper.dataset.suppressDropdownUntil = String(Date.now() + 500);
        resetPhoto();
        closeDesktopInline();
        closeManualNameSheet();
        const photoSheet = document.getElementById('photo-search-sheet');
        photoSheet?.classList.remove('visible');
        if (photoSheet) setTimeout(() => photoSheet.classList.remove('open'), 350);
        const dropdown = document.getElementById('custom-dropdown');
        wrapper?.classList.remove('active', 'photo-search-open');
        wrapper?.style.setProperty('--dropdown-height', '0px');
        if (dropdown) { dropdown.classList.remove('active'); dropdown.style.display = ''; }
    }

    function syncDesktopPanelHeight() {
        const host = state.root;
        if (!host || (host.id !== 'desktop-photo-search-panel' && host.id !== 'photo-registration-root')) return;
        requestAnimationFrame(() => {
            if (!host.isConnected || host.hidden) return;
            const left = host.querySelector('.photo-analysis-left');
            if (!left) return;
            const layout = host.querySelector('.photo-analysis-layout');
            const preview = left.querySelector('.photo-preview');
            if (layout && preview) layout.style.setProperty('--photo-content-height', `${Math.ceil(preview.getBoundingClientRect().height)}px`);
            if (host.id !== 'desktop-photo-search-panel') return;
            const height = '344px';
            host.style.height = height;
            document.getElementById('search-wrapper')?.style.setProperty('--dropdown-height', height);
        });
    }

    function keepDesktopPhotoPanelOpen() {
        if (state.root?.id !== 'desktop-photo-search-panel') return;
        const wrapper = document.getElementById('search-wrapper');
        const dropdown = document.getElementById('custom-dropdown');
        state.root.removeAttribute('hidden');
        wrapper?.classList.add('active', 'photo-search-open');
        if (!state.root.style.height) state.root.style.height = '344px';
        wrapper?.style.setProperty('--dropdown-height', state.root.style.height);
        if (dropdown) { dropdown.classList.remove('active'); dropdown.style.display = 'none'; }
    }

    function syncMobileSheetHeight(sheet) {
        if (!sheet?.classList.contains('open')) return;
        requestAnimationFrame(() => {
            const panel = sheet.querySelector('.photo-search-sheet-panel');
            const header = sheet.querySelector('.photo-search-sheet-header');
            const content = sheet.querySelector('.photo-search-sheet-content');
            if (!panel || !header || !content) return;
            const style = getComputedStyle(panel);
            const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            panel.style.height = `${Math.min(window.innerHeight * .92, header.offsetHeight + content.scrollHeight + padding)}px`;
        });
    }

    function openSearchSheet() {
        let sheet = document.getElementById('photo-search-sheet');
        if (!sheet) {
            sheet = document.createElement('div'); sheet.id = 'photo-search-sheet'; sheet.className = 'photo-search-sheet';
            sheet.innerHTML = '<div class="photo-search-sheet-backdrop"></div><div class="photo-search-sheet-panel"><div class="photo-search-sheet-header"><span class="photo-search-sheet-title">사진 검색</span><button class="photo-sheet-close" aria-label="닫기"><i class="material-icons">close</i></button></div><div class="photo-search-sheet-content"></div></div>';
            document.body.append(sheet);
            sheet.querySelector('.photo-search-sheet-backdrop').onclick = closePhotoSearch;
            sheet.querySelector('.photo-sheet-close').onclick = closePhotoSearch;
            new ResizeObserver(() => syncMobileSheetHeight(sheet)).observe(sheet.querySelector('.photo-search-sheet-content'));
        }
        sheet.classList.add('open');
        openPicker('search', sheet.querySelector('.photo-search-sheet-content'));
        syncMobileSheetHeight(sheet);
        requestAnimationFrame(() => sheet.classList.add('visible'));
    }

    function closeRegistrationSheet(returnToGeneral = true) {
        state = states.register;
        resetPhoto();
        closeManualNameSheet();
        const sheet = document.getElementById('photo-registration-sheet');
        sheet?.classList.remove('visible');
        if (sheet) setTimeout(() => sheet.classList.remove('open'), 350);
        if (returnToGeneral && typeof root.switchAddSubMode === 'function') root.switchAddSubMode('general');
    }

    function openRegistrationSheet() {
        let sheet = document.getElementById('photo-registration-sheet');
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.id = 'photo-registration-sheet';
            sheet.className = 'photo-search-sheet photo-registration-sheet';
            sheet.innerHTML = '<div class="photo-search-sheet-backdrop"></div><div class="photo-search-sheet-panel"><div class="photo-search-sheet-header"><span class="photo-search-sheet-title">사진 등록</span><button class="photo-sheet-close" aria-label="닫기"><i class="material-icons">close</i></button></div><div class="photo-search-sheet-content"></div></div>';
            document.body.append(sheet);
            sheet.querySelector('.photo-search-sheet-backdrop').onclick = () => closeRegistrationSheet();
            sheet.querySelector('.photo-sheet-close').onclick = () => closeRegistrationSheet();
            new ResizeObserver(() => syncMobileSheetHeight(sheet)).observe(sheet.querySelector('.photo-search-sheet-content'));
        }
        sheet.classList.add('open');
        openPicker('register', sheet.querySelector('.photo-search-sheet-content'));
        syncMobileSheetHeight(sheet);
        requestAnimationFrame(() => sheet.classList.add('visible'));
    }

    function openDesktopInline() {
        const wrapper = document.getElementById('search-wrapper');
        const background = wrapper?.querySelector('.search-expansion-bg');
        const dropdown = document.getElementById('custom-dropdown');
        if (!wrapper || !background) return;
        state.searchUiSuspended = false;
        let panel = document.getElementById('desktop-photo-search-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'desktop-photo-search-panel';
            panel.className = 'desktop-photo-search-panel';
            panel.addEventListener('mousedown', event => event.preventDefault());
            background.append(panel);
        }
        panel.removeAttribute('hidden');
        panel.style.height = '344px';
        if (dropdown) { dropdown.classList.remove('active'); dropdown.style.display = 'none'; }
        wrapper.classList.add('active', 'photo-search-open');
        wrapper.style.setProperty('--dropdown-height', '344px');
        openPicker('search', panel);
    }

    function closeDesktopInline() {
        const wrapper = document.getElementById('search-wrapper');
        wrapper?.classList.remove('photo-search-open');
        const panel = document.getElementById('desktop-photo-search-panel');
        panel?.setAttribute('hidden', '');
        if (panel) panel.style.height = '';
    }

    function init() {
        // Load detection runtimes only after a photo is selected; login and
        // ordinary text search must not compete with WASM initialization.
        const desktopButton = document.getElementById('desktop-photo-search-btn');
        desktopButton?.addEventListener('mousedown', event => event.preventDefault());
        desktopButton?.addEventListener('click', () => {
            if (hasSearchPhoto() && isDesktopPanelOpen()) closePhotoSearch();
            else openDesktopInline();
        });
        document.getElementById('mobile-photo-search-btn')?.addEventListener('click', () => hasSearchPhoto() ? closePhotoSearch() : openSearchSheet());
        const input = document.getElementById('card-search');
        const syncCamera = syncSearchControls;
        input?.addEventListener('focus', syncCamera);
        input?.addEventListener('input', () => { syncCamera(); if (input.value.trim()) closeDesktopInline(); });
        input?.addEventListener('blur', () => setTimeout(() => {
            syncCamera();
            const wrapper = document.getElementById('search-wrapper');
            if (!wrapper?.classList.contains('active')) closeDesktopInline();
        }, 100));
        document.addEventListener('pointerdown', event => {
            const wrapper = document.getElementById('search-wrapper');
            if (isDesktopPanelOpen() && wrapper && !wrapper.contains(event.target)) hidePhotoSearchPreservingState();
        });
        syncCamera();
    }

    root.PhotoCardSearch = { init, openPicker, openRegistrationSheet, detectRegionsFromImageData, normalizeRegions, sortRegionsReadingOrder, orderQuad, regionFromQuad, getDetectorStatus: () => detectorStatus, isDesktopBusy: () => (states.search.phase === 'detecting' || states.search.busy) && states.search.root?.id === 'desktop-photo-search-panel', hasDesktopPhoto: () => hasSearchPhoto() && states.search.root?.id === 'desktop-photo-search-panel', CARD_ART_CROPS, MAX_REGIONS, ANALYSIS_BATCH_SIZE };
    if (typeof module === 'object' && module.exports) module.exports = { detectRegionsFromImageData, normalizeRegions, sortRegionsReadingOrder, orderQuad, regionFromQuad, iou, CARD_ART_CROPS, MAX_REGIONS, ANALYSIS_BATCH_SIZE };
    else document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
