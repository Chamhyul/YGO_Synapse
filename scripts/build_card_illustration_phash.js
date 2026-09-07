#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_IMAGE_DIR = path.join(ROOT_DIR, 'resources', 'illustrations');
const DEFAULT_MANIFEST_PATH = path.join(ROOT_DIR, 'data', 'illustration-sync', 'manifest.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, 'data', 'illustration-sync', 'phash-index.json');
const ALGORITHM_VERSION = 'phash-dct-32x32-v1';
const SAMPLE_SIZE = 32;
const HASH_SIZE = 8;

function parseArgs(argv) {
  const options = {
    imageDir: DEFAULT_IMAGE_DIR,
    manifestPath: DEFAULT_MANIFEST_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    concurrency: Math.max(1, Math.min(4, os.cpus().length)),
    limit: null,
    full: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--image-dir') options.imageDir = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--manifest') options.manifestPath = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--output') options.outputPath = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--concurrency') options.concurrency = positiveInteger(requireValue(argv, ++index, arg), arg);
    else if (arg === '--limit') options.limit = positiveInteger(requireValue(argv, ++index, arg), arg);
    else if (arg === '--full') options.full = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  if (!argv[index] || argv[index].startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
  return argv[index];
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag}에는 양의 정수가 필요합니다.`);
  return number;
}

function printHelp() {
  console.log(`사용법: node scripts/build_card_illustration_phash.js [옵션]

  --image-dir <경로>    기준 이미지 디렉터리
  --manifest <경로>     이미지 동기화 매니페스트
  --output <경로>       pHash 인덱스 출력 경로
  --concurrency <개수>  동시 이미지 처리 수
  --limit <개수>        처리 수 제한(검증용)
  --full                해시가 같아도 전체 재계산
  --quiet               항목별 로그 생략
  --help                도움말 출력`);
}

const COSINE = Array.from({ length: HASH_SIZE }, (_, frequency) =>
  Array.from({ length: SAMPLE_SIZE }, (_, position) =>
    Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * SAMPLE_SIZE))));

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
  const medianValues = low.slice(1).sort((a, b) => a - b);
  const median = medianValues[Math.floor(medianValues.length / 2)];
  let bits = 0n;
  for (const value of low) bits = (bits << 1n) | (value >= median ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

async function phashFile(filename) {
  const pixels = await sharp(filename)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .raw()
    .toBuffer();
  return phashFromPixels(pixels);
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

function manifestTargets(manifest) {
  const targets = new Map();
  for (const item of Object.values(manifest.files || {})) {
    if (!['ready', 'sourceMissing'].includes(item.status) || !item.target || !item.cid || !item.ciid) continue;
    const key = item.target.replace(/\.webp$/, '');
    if (targets.has(key)) throw new Error(`중복 pHash 대상: ${key}`);
    targets.set(key, {
      key, cid: String(item.cid), ciid: Number(item.ciid), filename: item.target,
      contentSha256: item.localSha256 || null,
    });
  }
  return targets;
}

async function readExisting(filename) {
  try {
    const value = JSON.parse(await fsp.readFile(filename, 'utf8'));
    if (value.algorithmVersion !== ALGORITHM_VERSION || !value.files) return { files: {} };
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { files: {} };
    throw error;
  }
}

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

async function mapLimited(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await operation(items[cursor++]);
  });
  await Promise.all(workers);
}

async function run(options) {
  const log = options.quiet ? () => {} : console.log;
  const manifest = JSON.parse(await fsp.readFile(options.manifestPath, 'utf8'));
  const desired = manifestTargets(manifest);
  const existing = options.full ? { files: {} } : await readExisting(options.outputPath);
  const files = {};
  const candidates = [];

  for (const [key, target] of desired) {
    const old = existing.files?.[key];
    const filename = path.join(options.imageDir, target.filename);
    if (old && old.contentSha256 === target.contentSha256) files[key] = old;
    else if (fs.existsSync(filename)) candidates.push({ ...target, path: filename });
    else if (old) files[key] = old;
  }

  const selected = options.limit ? candidates.slice(0, options.limit) : candidates;
  let processed = 0;
  await mapLimited(selected, options.concurrency, async candidate => {
    const phash = await phashFile(candidate.path);
    files[candidate.key] = {
      cid: candidate.cid,
      ciid: candidate.ciid,
      phash,
      contentSha256: candidate.contentSha256,
    };
    processed++;
    if (processed % 250 === 0) log(`[pHash] ${processed}/${selected.length}`);
  });

  if (options.limit && selected.length < candidates.length) {
    for (const candidate of candidates.slice(selected.length)) {
      if (existing.files?.[candidate.key]) files[candidate.key] = existing.files[candidate.key];
    }
  }

  const index = {
    schemaVersion: 1,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAt: Date.now(),
    files,
  };
  await writeJsonAtomic(options.outputPath, index);
  const summary = { desired: desired.size, reused: Object.keys(files).length - processed, processed, indexed: Object.keys(files).length };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    await run(options);
  } catch (error) {
    console.error(`[오류] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ALGORITHM_VERSION, parseArgs, phashFromPixels, phashFile, hammingDistance, manifestTargets, run,
};
