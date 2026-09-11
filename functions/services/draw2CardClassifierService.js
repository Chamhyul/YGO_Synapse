const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const { downloadProductionFile } = require('../config/firebase');

const MODEL_OBJECT_PATH = 'system/models/draw2-int8.onnx';
const CONFIG_OBJECT_PATH = 'system/models/draw2-config.json';
const CARDNAMES_OBJECT_PATH = 'system/models/draw2-cardnames.json';
const ILLUSTRATION_INDEX_OBJECT_PATH = 'private/illustrations-index.json';
const MAX_INPUT_BYTES = 6 * 1024 * 1024;
const MODEL_SIZE = 224;
const localModelDir = path.resolve(__dirname, '../../data/models');
let runtimePromise = null;
let passcodeIndexPromise = null;

function decodeImage(value) {
  if (typeof value !== 'string' || !value) throw new Error('이미지 데이터가 없습니다.');
  const match = value.match(/^data:image\/(?:jpeg|png|webp);base64,(.+)$/i);
  const encoded = match ? match[1] : value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('올바른 base64 이미지가 아닙니다.');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) throw new Error('이미지는 6MB 이하여야 합니다.');
  return buffer;
}

async function ensureAsset(localName, objectPath) {
  const configured = process.env[`DRAW2_${localName.replace(/\W/g, '_').toUpperCase()}_PATH`];
  if (configured && fs.existsSync(configured)) return configured;
  const local = path.join(localModelDir, localName);
  if (fs.existsSync(local)) return local;
  const cached = path.join(os.tmpdir(), localName);
  if (!fs.existsSync(cached)) await fsp.writeFile(cached, await downloadProductionFile(objectPath));
  return cached;
}

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [modelPath, configPath, cardnamesPath] = await Promise.all([
        ensureAsset('draw2-int8.onnx', MODEL_OBJECT_PATH),
        ensureAsset('draw2-config.json', CONFIG_OBJECT_PATH),
        ensureAsset('draw2-cardnames.json', CARDNAMES_OBJECT_PATH),
      ]);
      const options = { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' };
      const [session, config, cardnames] = await Promise.all([
        ort.InferenceSession.create(modelPath, options),
        fsp.readFile(configPath, 'utf8').then(JSON.parse),
        fsp.readFile(cardnamesPath, 'utf8').then(JSON.parse),
      ]);
      return { session, labels: config.id2label, cardnames };
    })().catch(error => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function buildPasscodeIndex(value, manifest = false) {
  const result = new Map();
  for (const [key, item] of Object.entries(value?.files || {})) {
    const passcode = manifest ? key : item.sourceImageId;
    if (!/^\d+$/.test(String(passcode || '')) || !item.cid || !item.ciid) continue;
    const candidate = { cid: String(item.cid), ciid: Number(item.ciid) };
    const previous = result.get(String(passcode));
    if (!previous || candidate.ciid < previous.ciid) result.set(String(passcode), candidate);
  }
  return result;
}

async function loadPasscodeIndex() {
  if (!passcodeIndexPromise) {
    passcodeIndexPromise = (async () => {
      const localManifest = path.resolve(__dirname, '../../data/illustration-sync/manifest.json');
      if (fs.existsSync(localManifest)) {
        return buildPasscodeIndex(JSON.parse(await fsp.readFile(localManifest, 'utf8')), true);
      }
      const index = JSON.parse((await downloadProductionFile(ILLUSTRATION_INDEX_OBJECT_PATH)).toString('utf8'));
      return buildPasscodeIndex(index);
    })().catch(error => {
      passcodeIndexPromise = null;
      throw error;
    });
  }
  return passcodeIndexPromise;
}

async function imageTensor(value) {
  const { data } = await sharp(decodeImage(value), { limitInputPixels: 20_000_000, failOn: 'error' })
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const area = MODEL_SIZE * MODEL_SIZE;
  const values = new Float32Array(area * 3);
  for (let pixel = 0; pixel < area; pixel++) {
    values[pixel] = data[pixel * 3] / 127.5 - 1;
    values[area + pixel] = data[pixel * 3 + 1] / 127.5 - 1;
    values[area * 2 + pixel] = data[pixel * 3 + 2] / 127.5 - 1;
  }
  return new ort.Tensor('float32', values, [1, 3, MODEL_SIZE, MODEL_SIZE]);
}

function topCandidates(logits, labels, cardnames, count = 5) {
  const indexes = Array.from(logits, (_, index) => index)
    .sort((left, right) => logits[right] - logits[left]).slice(0, count);
  const maximum = Math.max(...logits);
  let sum = 0;
  for (const value of logits) sum += Math.exp(value - maximum);
  return indexes.map(index => {
    const label = labels[String(index)] || '';
    const passcode = label.match(/-(\d+)$/)?.[1] || '';
    return {
      passcode,
      cardName: cardnames[passcode]?.EN || label.replace(/-\d+$/, '').replaceAll('-', ' '),
      score: Number((Math.exp(logits[index] - maximum) / sum).toFixed(6)),
    };
  });
}

function resolveCandidate(candidate, passcodeIndex) {
  const mapped = passcodeIndex.get(candidate.passcode);
  return { ...candidate, cid: mapped?.cid || null, ciid: mapped?.ciid || 1 };
}

async function classifyImages(images, options = {}) {
  if (!Array.isArray(images) || !images.length) throw new Error('분석할 이미지가 없습니다.');
  if (images.length > 10) throw new Error('한 번에 최대 10개의 카드 영역을 분석할 수 있습니다.');
  const [runtime, passcodeIndex] = await Promise.all([loadRuntime(), loadPasscodeIndex()]);
  const results = [];
  for (let regionIndex = 0; regionIndex < images.length; regionIndex++) {
    const tensor = await imageTensor(images[regionIndex]);
    const output = await runtime.session.run({ [runtime.session.inputNames[0]]: tensor });
    const logits = output[runtime.session.outputNames[0]].data;
    const maxResults = options.maxResults || 5;
    const raw = topCandidates(logits, runtime.labels, runtime.cardnames, Math.min(20, maxResults * 3));
    const matches = raw.map(candidate => resolveCandidate(candidate, passcodeIndex))
      .filter(candidate => candidate.cid).slice(0, maxResults);
    results.push({ regionIndex, matches });
  }
  return results;
}

function resetRuntime() { runtimePromise = null; passcodeIndexPromise = null; }

module.exports = { decodeImage, imageTensor, topCandidates, buildPasscodeIndex, classifyImages, loadRuntime, loadPasscodeIndex, resetRuntime };
