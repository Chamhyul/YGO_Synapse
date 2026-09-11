// SPDX-License-Identifier: AGPL-3.0-only
// Based on HichTala/draw2 docs/scripts/pipeline.js; upstream rights retained.
// Modified 2026-09-08 for YGO Synapse evaluation inputs and outputs.
// See ../THIRD_PARTY_NOTICES.md for source revision and attribution.
'use strict';

const ort = require('onnxruntime-web');
const sharp = require('sharp');

const MODEL_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.2;

function corners(cx, cy, width, height, angle) {
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

function iou(left, right) {
  const a = bounds(left.points), b = bounds(right.points);
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const intersection = width * height;
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  return intersection / (areaA + areaB - intersection || 1);
}

function parse(output, originalWidth, originalHeight, scale, padX, padY) {
  const [batch, first, second] = output.dims;
  if (batch !== 1) throw new Error(`Unexpected output shape: ${output.dims.join('x')}`);
  const featuresFirst = first < second;
  const rows = featuresFirst ? second : first;
  const columns = featuresFirst ? first : second;
  const at = (row, column) => featuresFirst ? output.data[column * rows + row] : output.data[row * columns + column];
  const candidates = [];
  for (let row = 0; row < rows; row++) {
    const confidence = at(row, 4);
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    const points = corners(
      (at(row, 0) - padX) / scale,
      (at(row, 1) - padY) / scale,
      at(row, 2) / scale,
      at(row, 3) / scale,
      at(row, 5),
    ).map(point => ({
      x: Math.max(0, Math.min(originalWidth, point.x)),
      y: Math.max(0, Math.min(originalHeight, point.y)),
    }));
    candidates.push({ confidence, points });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const candidate of candidates) {
    if (!kept.some(other => iou(candidate, other) > 0.5)) kept.push(candidate);
  }
  return kept;
}

async function preprocess(path) {
  // metadata() reports the encoded dimensions before EXIF rotation.
  const oriented = await sharp(path).rotate().toBuffer();
  const image = sharp(oriented);
  const metadata = await image.metadata();
  const scale = Math.min(MODEL_SIZE / metadata.width, MODEL_SIZE / metadata.height);
  const width = Math.round(metadata.width * scale), height = Math.round(metadata.height * scale);
  const padX = Math.floor((MODEL_SIZE - width) / 2), padY = Math.floor((MODEL_SIZE - height) / 2);
  const { data } = await image.resize(width, height).removeAlpha().extend({
    top: padY, bottom: MODEL_SIZE - height - padY,
    left: padX, right: MODEL_SIZE - width - padX,
    background: { r: 0, g: 0, b: 0 },
  }).raw().toBuffer({ resolveWithObject: true });
  const tensor = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const area = MODEL_SIZE * MODEL_SIZE;
  for (let pixel = 0; pixel < area; pixel++) {
    tensor[pixel] = data[pixel * 3] / 255;
    tensor[area + pixel] = data[pixel * 3 + 1] / 255;
    tensor[area * 2 + pixel] = data[pixel * 3 + 2] / 255;
  }
  return { tensor, width: metadata.width, height: metadata.height, scale, padX, padY };
}

async function main() {
  const [modelPath, ...imagePaths] = process.argv.slice(2);
  if (!modelPath || !imagePaths.length) throw new Error('Usage: node scripts/evaluate_draw2_detector.js MODEL IMAGE...');
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['wasm'] });
  for (const imagePath of imagePaths) {
    const input = await preprocess(imagePath);
    const outputMap = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input.tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]) });
    const detections = parse(outputMap[session.outputNames[0]], input.width, input.height, input.scale, input.padX, input.padY);
    console.log(JSON.stringify({ image: imagePath, detections }, null, 2));
  }
}

module.exports = { preprocess, parse };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
