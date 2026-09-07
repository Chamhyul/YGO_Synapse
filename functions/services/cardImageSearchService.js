const sharp = require('sharp');
const { getBucket } = require('../config/firebase');

const SEARCH_INDEX_PATH = 'system/illustration-search/phash.json';
const ALGORITHM_VERSION = 'phash-dct-32x32-v1';
const SAMPLE_SIZE = 32;
const HASH_SIZE = 8;
const MAX_INPUT_BYTES = 6 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

const COSINE = Array.from({ length: HASH_SIZE }, (_, frequency) =>
  Array.from({ length: SAMPLE_SIZE }, (_, position) =>
    Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * SAMPLE_SIZE))));

let cachedIndex = null;
let cacheExpiresAt = 0;

function phashFromPixels(pixels) {
  if (!pixels || pixels.length !== SAMPLE_SIZE * SAMPLE_SIZE) {
    throw new Error(`pHash 입력은 ${SAMPLE_SIZE}x${SAMPLE_SIZE} 그레이스케일이어야 합니다.`);
  }
  const horizontal = Array.from({ length: SAMPLE_SIZE }, () => new Float64Array(HASH_SIZE));
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < SAMPLE_SIZE; x++) sum += pixels[y * SAMPLE_SIZE + x] * COSINE[u][x];
      horizontal[y][u] = sum;
    }
  }
  const low = [];
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      let sum = 0;
      for (let y = 0; y < SAMPLE_SIZE; y++) sum += horizontal[y][u] * COSINE[v][y];
      low.push(sum);
    }
  }
  const sorted = low.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = 0n;
  for (const value of low) bits = (bits << 1n) | (value >= median ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

function hammingDistance(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count++;
  }
  return count;
}

function decodeImage(value) {
  if (typeof value !== 'string' || !value) throw new Error('이미지 데이터가 없습니다.');
  const match = value.match(/^data:image\/(?:jpeg|png|webp);base64,(.+)$/i);
  const encoded = match ? match[1] : value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('올바른 base64 이미지가 아닙니다.');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) {
    throw new Error(`이미지는 ${MAX_INPUT_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
  }
  return buffer;
}

async function phashImage(buffer) {
  const pixels = await sharp(buffer, { limitInputPixels: 20_000_000, failOn: 'error' })
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .raw()
    .toBuffer();
  return phashFromPixels(pixels);
}

function validateIndex(index) {
  if (index?.algorithmVersion !== ALGORITHM_VERSION || !index.files) {
    throw new Error('지원하지 않는 일러스트 검색 인덱스입니다.');
  }
  return index;
}

async function loadSearchIndex(now = Date.now()) {
  if (cachedIndex && now < cacheExpiresAt) return cachedIndex;
  const [buffer] = await getBucket().file(SEARCH_INDEX_PATH).download();
  cachedIndex = validateIndex(JSON.parse(buffer.toString('utf8')));
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedIndex;
}

function findNearest(index, queryHash, maxResults = 5, maxDistance = 18) {
  return Object.entries(index.files || {})
    .map(([key, item]) => {
      const distance = hammingDistance(queryHash, item.phash);
      return {
        key,
        cid: String(item.cid),
        ciid: Number(item.ciid),
        distance,
        similarity: Number(((64 - distance) / 64).toFixed(4)),
      };
    })
    .filter(item => item.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || Number(a.cid) - Number(b.cid) || a.ciid - b.ciid)
    .slice(0, maxResults);
}

async function searchImage(image, options = {}) {
  const buffer = decodeImage(image);
  const [queryHash, index] = await Promise.all([phashImage(buffer), loadSearchIndex()]);
  return { queryHash, matches: findNearest(index, queryHash, options.maxResults, options.maxDistance) };
}

function resetCache() {
  cachedIndex = null;
  cacheExpiresAt = 0;
}

module.exports = {
  ALGORITHM_VERSION, MAX_INPUT_BYTES, phashFromPixels, hammingDistance, decodeImage,
  phashImage, validateIndex, loadSearchIndex, findNearest, searchImage, resetCache,
};
