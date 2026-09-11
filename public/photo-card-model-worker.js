// SPDX-License-Identifier: AGPL-3.0-only
// Based on HichTala/draw2 docs/scripts/pipeline.js; upstream rights retained.
// Modified 2026-09-08 for YGO Synapse worker integration.
// See /legal/THIRD_PARTY_NOTICES.md for source revision and attribution.
'use strict';

const MODEL_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.2;
let sessionPromise = null;

function loadSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
        self.postMessage({ type: 'progress', stage: 'loading-runtime' });
        importScripts('vendor/ort.min.js');
        // ORT uses dynamic import for its .mjs runtime; a bare relative
        // specifier such as vendor/... cannot be resolved by the browser.
        ort.env.wasm.wasmPaths = new URL('vendor/', self.location.href).href;
        ort.env.wasm.numThreads = 1;
        self.postMessage({ type: 'progress', stage: 'loading-model' });
        const session = await ort.InferenceSession.create(new URL('vendor/ygo-card-detector.onnx', self.location.href).href, {
            executionProviders: ['wasm'], logSeverityLevel: 3,
        });
        self.postMessage({ type: 'progress', stage: 'warming-up' });
        const inputName = session.inputNames[0];
        await session.run({
            [inputName]: new ort.Tensor('float32', new Float32Array(3 * MODEL_SIZE * MODEL_SIZE), [1, 3, MODEL_SIZE, MODEL_SIZE]),
        });
        return session;
    })();
    return sessionPromise;
}

function xywhrToCorners(cx, cy, width, height, angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const halfWidth = width / 2, halfHeight = height / 2;
    return [
        [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
        [halfWidth, halfHeight], [-halfWidth, halfHeight],
    ].map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }));
}

function bounds(points) {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function approximateIou(left, right) {
    const a = bounds(left.points), b = bounds(right.points);
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const intersection = width * height;
    const areaA = (a.right - a.left) * (a.bottom - a.top);
    const areaB = (b.right - b.left) * (b.bottom - b.top);
    return intersection / (areaA + areaB - intersection || 1);
}

function preprocess(imageData) {
    const scale = Math.min(MODEL_SIZE / imageData.width, MODEL_SIZE / imageData.height);
    const width = Math.round(imageData.width * scale), height = Math.round(imageData.height * scale);
    const padX = Math.floor((MODEL_SIZE - width) / 2), padY = Math.floor((MODEL_SIZE - height) / 2);
    const source = new OffscreenCanvas(imageData.width, imageData.height);
    source.getContext('2d').putImageData(imageData, 0, 0);
    const resized = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
    const context = resized.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#000';
    context.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    context.drawImage(source, 0, 0, imageData.width, imageData.height, padX, padY, width, height);
    const pixels = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const tensor = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE), area = MODEL_SIZE * MODEL_SIZE;
    for (let pixel = 0; pixel < area; pixel++) {
        tensor[pixel] = pixels[pixel * 4] / 255;
        tensor[area + pixel] = pixels[pixel * 4 + 1] / 255;
        tensor[area * 2 + pixel] = pixels[pixel * 4 + 2] / 255;
    }
    return { tensor, scale, padX, padY };
}

function parseOutput(output, imageData, transform) {
    const [batch, first, second] = output.dims;
    if (batch !== 1) throw new Error(`지원하지 않는 검출 출력: ${output.dims.join('x')}`);
    const featuresFirst = first < second;
    const rows = featuresFirst ? second : first, columns = featuresFirst ? first : second;
    const at = (row, column) => featuresFirst ? output.data[column * rows + row] : output.data[row * columns + column];
    const detections = [];
    for (let row = 0; row < rows; row++) {
        const confidence = at(row, 4);
        if (confidence < CONFIDENCE_THRESHOLD) continue;
        const points = xywhrToCorners(
            (at(row, 0) - transform.padX) / transform.scale,
            (at(row, 1) - transform.padY) / transform.scale,
            at(row, 2) / transform.scale,
            at(row, 3) / transform.scale,
            at(row, 5),
        ).map(point => ({
            x: Math.max(0, Math.min(imageData.width, point.x)),
            y: Math.max(0, Math.min(imageData.height, point.y)),
        }));
        detections.push({ confidence, points });
    }
    detections.sort((left, right) => right.confidence - left.confidence);
    const kept = [];
    for (const detection of detections) {
        if (!kept.some(other => approximateIou(detection, other) > 0.5)) kept.push(detection);
    }
    return kept;
}

function toRegion(detection, width, height) {
    const box = bounds(detection.points);
    return {
        x: box.left / width, y: box.top / height,
        width: (box.right - box.left) / width, height: (box.bottom - box.top) / height,
        polygon: detection.points.map(point => ({ x: point.x / width, y: point.y / height })),
        score: detection.confidence,
        detector: 'draw2',
    };
}

self.onmessage = async event => {
    if (event.data?.type === 'init') {
        try {
            await loadSession();
            self.postMessage({ type: 'ready' });
        } catch (error) {
            self.postMessage({ type: 'init-error', error: error?.message || String(error) });
        }
        return;
    }
    const { requestId, imageData } = event.data || {};
    try {
        const session = await loadSession();
        const transform = preprocess(imageData);
        const inputs = {
            [session.inputNames[0]]: new ort.Tensor('float32', transform.tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
        };
        const outputs = await session.run(inputs);
        const detections = parseOutput(outputs[session.outputNames[0]], imageData, transform);
        self.postMessage({
            type: 'result', requestId,
            regions: detections.map(detection => toRegion(detection, imageData.width, imageData.height)),
        });
    } catch (error) {
        self.postMessage({ type: 'result', requestId, error: error?.message || String(error) });
    }
};
