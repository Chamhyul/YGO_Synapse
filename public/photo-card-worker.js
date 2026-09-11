'use strict';

let cvPromise = null;

function getCv() {
    if (cvPromise) return cvPromise;
    cvPromise = new Promise((resolve, reject) => {
        const started = Date.now();
        let settled = false;
        // Do not resolve with `runtime` directly. OpenCV's module is a custom
        // thenable, so native Promise resolution would assimilate it forever.
        const finish = runtime => { if (!settled) { settled = true; resolve({ runtime }); } };
        const fail = error => { if (!settled) { settled = true; reject(error); } };
        const waitForApi = () => {
            const runtime = self.__opencvRuntimeThis?.Mat
                ? self.__opencvRuntimeThis
                : (self.cv?.Mat ? self.cv : (self.Module?.Mat ? self.Module : null));
            if (runtime) return finish(runtime);
            if (Date.now() - started > 1000 && !self.__opencvShapeReported) {
                self.__opencvShapeReported = true;
                self.postMessage({
                    type: 'progress', stage: 'api-pending',
                    cvType: typeof self.cv,
                    cvHasMat: Boolean(self.cv?.Mat),
                    cvHasThen: typeof self.cv?.then === 'function',
                    moduleType: typeof self.Module,
                    moduleHasMat: Boolean(self.Module?.Mat),
                });
            }
            if (Date.now() - started >= 115000) return fail(new Error('OpenCV Mat API 준비가 115초를 초과했습니다.'));
            setTimeout(waitForApi, 50);
        };
        self.Module = {
            onRuntimeInitialized: function () {
                self.__opencvRuntimeThis = this;
                // The generated bindings are attached at the end of this callback.
                // Check on the next task instead of treating the callback's `this`
                // value as the public cv module.
                setTimeout(() => {
                    const runtime = self.cv?.Mat ? self.cv
                        : (self.__opencvRuntimeThis?.Mat ? self.__opencvRuntimeThis : null);
                    self.postMessage({
                        type: 'progress', stage: 'runtime-initialized',
                        cvHasMat: Boolean(self.cv?.Mat),
                        runtimeHasMat: Boolean(self.__opencvRuntimeThis?.Mat),
                    });
                    if (runtime) finish(runtime);
                }, 0);
            },
            onAbort: reason => fail(new Error(`OpenCV 런타임 중단: ${reason || '알 수 없는 원인'}`)),
        };
        try {
            self.postMessage({ type: 'progress', stage: 'loading-script' });
            importScripts('vendor/opencv.js');
            self.postMessage({ type: 'progress', stage: 'script-loaded' });
            if (self.__opencvRuntimeThis?.Mat) return finish(self.__opencvRuntimeThis);
            waitForApi();
        } catch (error) {
            fail(error);
        }
    });
    return cvPromise;
}

function orderQuad(points) {
    const bySum = [...points].sort((a, b) => a.x + a.y - b.x - b.y);
    const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
    return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function regionFromQuad(points, width, height, areaRatio) {
    const ordered = orderQuad(points);
    const horizontal = (distance(ordered[0], ordered[1]) + distance(ordered[3], ordered[2])) / 2;
    const vertical = (distance(ordered[0], ordered[3]) + distance(ordered[1], ordered[2])) / 2;
    const ratio = Math.min(horizontal, vertical) / Math.max(horizontal, vertical);
    if (ratio < 0.52 || ratio > 0.80) return null;
    const xs = ordered.map(point => point.x), ys = ordered.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return {
        x: minX / width, y: minY / height,
        width: (maxX - minX) / width, height: (maxY - minY) / height,
        polygon: ordered.map(point => ({ x: point.x / width, y: point.y / height })),
        score: areaRatio + (1 - Math.abs(ratio - 59 / 86)),
    };
}

function contourPoints(approx) {
    const points = [];
    for (let row = 0; row < approx.rows; row++) {
        const ptr = approx.intPtr(row, 0);
        points.push({ x: ptr[0], y: ptr[1] });
    }
    return points;
}

function collectCardContours(cv, binary, imageData, found) {
    const contours = new cv.MatVector(), hierarchy = new cv.Mat();
    try {
        cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let index = 0; index < contours.size(); index++) {
            const contour = contours.get(index);
            try {
                const area = Math.abs(cv.contourArea(contour));
                const areaRatio = area / (imageData.width * imageData.height);
                if (areaRatio < 0.008 || areaRatio > 0.80) continue;
                const perimeter = cv.arcLength(contour, true);
                let accepted = false;
                for (const epsilon of [0.012, 0.02, 0.032, 0.05]) {
                    const approx = new cv.Mat();
                    try {
                        cv.approxPolyDP(contour, approx, perimeter * epsilon, true);
                        if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
                        const region = regionFromQuad(contourPoints(approx), imageData.width, imageData.height, areaRatio);
                        if (region) { found.push(region); accepted = true; break; }
                    } finally { approx.delete(); }
                }
                // Foil reflections often break one or more straight edges, so a
                // contour may not simplify to exactly four points. Recover its
                // oriented rectangle when the contour substantially fills it.
                if (!accepted && typeof cv.minAreaRect === 'function' && cv.RotatedRect?.points) {
                    const rotated = cv.minAreaRect(contour);
                    const rectArea = Math.max(1, rotated.size.width * rotated.size.height);
                    if (area / rectArea >= 0.50) {
                        const points = cv.RotatedRect.points(rotated);
                        const region = regionFromQuad(points, imageData.width, imageData.height, areaRatio * 0.85);
                        if (region) found.push(region);
                    }
                }
            } finally { contour.delete(); }
        }
    } finally { contours.delete(); hierarchy.delete(); }
}

function clusterLines(values, tolerance) {
    const clusters = [];
    values.sort((a, b) => a.position - b.position).forEach(value => {
        const cluster = clusters.find(item => Math.abs(item.position - value.position) <= tolerance);
        if (!cluster) clusters.push({ ...value });
        else {
            const weight = cluster.weight + value.weight;
            cluster.position = (cluster.position * cluster.weight + value.position * value.weight) / weight;
            cluster.weight = weight;
        }
    });
    return clusters.sort((a, b) => b.weight - a.weight).slice(0, 24).sort((a, b) => a.position - b.position);
}

function collectLineQuads(cv, edges, imageData, found) {
    if (typeof cv.HoughLinesP !== 'function') return;
    const lines = new cv.Mat();
    try {
        const shortest = Math.min(imageData.width, imageData.height);
        cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 45, shortest * 0.11, shortest * 0.035);
        const vertical = [], horizontal = [];
        for (let row = 0; row < lines.rows; row++) {
            const ptr = lines.intPtr(row, 0);
            const [x1, y1, x2, y2] = [ptr[0], ptr[1], ptr[2], ptr[3]];
            const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1), length = Math.hypot(dx, dy);
            if (dy > dx * 3) vertical.push({ position: (x1 + x2) / 2, weight: length });
            else if (dx > dy * 3) horizontal.push({ position: (y1 + y2) / 2, weight: length });
        }
        const xs = clusterLines(vertical, Math.max(6, shortest * 0.012));
        const ys = clusterLines(horizontal, Math.max(6, shortest * 0.012));
        for (let left = 0; left < xs.length; left++) for (let right = left + 1; right < xs.length; right++) {
            const width = xs[right].position - xs[left].position;
            if (width < shortest * 0.12) continue;
            for (let top = 0; top < ys.length; top++) for (let bottom = top + 1; bottom < ys.length; bottom++) {
                const height = ys[bottom].position - ys[top].position;
                const areaRatio = width * height / (imageData.width * imageData.height);
                if (areaRatio < 0.008 || areaRatio > 0.72) continue;
                const support = xs[left].weight + xs[right].weight + ys[top].weight + ys[bottom].weight;
                const region = regionFromQuad([
                    { x: xs[left].position, y: ys[top].position }, { x: xs[right].position, y: ys[top].position },
                    { x: xs[right].position, y: ys[bottom].position }, { x: xs[left].position, y: ys[bottom].position },
                ], imageData.width, imageData.height, Math.min(0.35, areaRatio) + support / (shortest * 100));
                if (region) found.push(region);
            }
        }
    } finally { lines.delete(); }
}

function distinctRegionCount(regions) {
    const centers = [];
    for (const region of regions) {
        const center = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
        if (centers.every(item => Math.hypot(item.x - center.x, item.y - center.y) > 0.14)) centers.push(center);
    }
    return centers.length;
}

self.onmessage = async event => {
    if (event.data?.type === 'init') {
        try {
            await getCv();
            self.postMessage({ type: 'ready' });
        } catch (error) {
            self.postMessage({ type: 'init-error', error: error?.message || String(error) });
        }
        return;
    }
    const { requestId, imageData } = event.data;
    try {
        const { runtime: cv } = await getCv();
        const source = cv.matFromImageData(imageData);
        const gray = new cv.Mat(), blurred = new cv.Mat();
        const found = [];
        try {
            cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
            for (const [low, high, kernelSize] of [[28, 90, 3], [55, 150, 5], [90, 230, 7]]) {
                const edges = new cv.Mat();
                const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize));
                try {
                    cv.Canny(blurred, edges, low, high, 3, true);
                    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
                    collectCardContours(cv, edges, imageData, found);
                    // Hough combinations recover a single glare-broken card but
                    // create many artwork-frame boxes in multi-card grids. Use
                    // them only while contour detection has not already found a
                    // spatially distributed group of cards.
                    if (low === 55 && distinctRegionCount(found) < 3) collectLineQuads(cv, edges, imageData, found);
                } finally { kernel.delete(); edges.delete(); }
            }
            // A second family of masks restores the filled-rectangle detection
            // that is valuable for pale sleeves/cards on a dark play mat.
            for (const mode of ['otsu', 'adaptive']) {
                const mask = new cv.Mat();
                const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
                const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
                try {
                    if (mode === 'otsu') cv.threshold(blurred, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
                    else cv.adaptiveThreshold(blurred, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 7);
                    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
                    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);
                    collectCardContours(cv, mask, imageData, found);
                } finally { openKernel.delete(); closeKernel.delete(); mask.delete(); }
            }
            // Reject geometrically plausible rectangles that contain only the
            // play mat/background. Real card faces retain substantially more
            // luminance variation even under sleeves and glare.
            for (let index = found.length - 1; index >= 0; index--) {
                const region = found[index];
                const x = Math.max(0, Math.floor(region.x * gray.cols));
                const y = Math.max(0, Math.floor(region.y * gray.rows));
                const width = Math.min(gray.cols - x, Math.max(1, Math.ceil(region.width * gray.cols)));
                const height = Math.min(gray.rows - y, Math.max(1, Math.ceil(region.height * gray.rows)));
                const roi = gray.roi(new cv.Rect(x, y, width, height));
                const mean = new cv.Mat(), deviation = new cv.Mat();
                try {
                    cv.meanStdDev(roi, mean, deviation);
                    const contrast = deviation.data64F[0];
                    if (contrast < 16) found.splice(index, 1);
                    else region.score += Math.min(0.5, contrast / 100);
                } finally { deviation.delete(); mean.delete(); roi.delete(); }
            }
        } finally {
            blurred.delete(); gray.delete(); source.delete();
        }
        self.postMessage({ type: 'result', requestId, regions: found });
    } catch (error) {
        self.postMessage({ type: 'result', requestId, error: error?.message || String(error) });
    }
};
