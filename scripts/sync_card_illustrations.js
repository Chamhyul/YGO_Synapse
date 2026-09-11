#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'resources', 'illustrations');
const DEFAULT_STATE_DIR = path.join(ROOT_DIR, 'data', 'illustration-sync');
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_STATE_DIR, 'manifest.json');
const MOMOBAKO_METADATA_URL = 'https://cdn.233.momobako.com/ygoimg/ygopro/metadata';
const MOMOBAKO_PICS_BASE_URL = 'https://cdn.233.momobako.com/ygopro/pics';
const YGOCDB_CARDSET_URL = 'https://ygocdb.com/api/v0/cardset';
const DEFAULT_PROJECT_ID = 'ygo-synapse';
const DEFAULT_CONCURRENCY = 4;
const CARDSET_BATCH_SIZE = 100;
const FIRESTORE_BATCH_SIZE = 200;
const MANIFEST_CHECKPOINT_SIZE = 100;
const MAX_CIID = 100;
const TOKEN_SOURCE_IDS = new Set(require('./card_illustration_token_ids.json').sourceImageIds.map(String));
const TOKEN_PLACEHOLDER_IDS = new Set(['19144623', '77571455']);

function parseArgs(argv) {
  const options = {
    dryRun: false,
    full: false,
    retryPending: false,
    quiet: false,
    cid: null,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    outputDir: DEFAULT_OUTPUT_DIR,
    manifestPath: DEFAULT_MANIFEST_PATH,
    ignoreEtag: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--retry-pending') options.retryPending = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--ignore-etag') options.ignoreEtag = true;
    else if (arg === '--cid') options.cid = requireValue(argv, ++index, arg);
    else if (arg === '--limit') options.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
    else if (arg === '--concurrency') options.concurrency = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
    else if (arg === '--output-dir') options.outputDir = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--manifest') options.manifestPath = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }

  return options;
}

function requireValue(argv, index, flag) {
  if (!argv[index] || argv[index].startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
  return argv[index];
}

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag}에는 양의 정수가 필요합니다.`);
  return number;
}

function printHelp() {
  console.log(`사용법: node scripts/sync_card_illustrations.js [옵션]

옵션:
  --dry-run             다운로드와 로컬 상태 변경 없이 분류만 수행
  --full                원격 metadata 전체를 다시 평가
  --retry-pending       이전 대기 항목만 다시 평가
  --quiet               항목별 로그를 생략하고 요약만 출력
  --ignore-etag         저장된 ETag와 관계없이 metadata 본문 요청
  --cid <CID>           매핑 결과가 해당 CID인 이미지만 처리
  --limit <개수>        이번 실행에서 평가할 원본 이미지 수 제한
  --concurrency <개수>  동시 이미지 다운로드 수 (기본: ${DEFAULT_CONCURRENCY})
  --output-dir <경로>   최종 이미지 디렉터리
  --manifest <경로>     동기화 매니페스트 경로
  --help                도움말 출력`);
}

function parseMetadata(text) {
  const entries = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\.[^:]+:(\d+),(\d+),([a-fA-F0-9]{32})$/);
    if (!match) continue;
    entries.set(match[1], {
      sourceImageId: match[1],
      remoteSize: Number(match[2]),
      remoteMtime: Number(match[3]),
      remoteMd5: match[4].toLowerCase(),
    });
  }
  if (!entries.size) throw new Error('Momobako metadata에서 이미지 항목을 찾지 못했습니다.');
  return entries;
}

function isOfficialPasscode(value) {
  const text = String(value);
  return /^\d{1,8}$/.test(text) && Number(text) > 0;
}

function isTemporaryPasscode(value) {
  return /^\d{9}$/.test(String(value));
}

function assertAppendOnlyCiidSources(mappings, manifest = { files: {} }) {
  const files = manifest.files || {};
  const existingByCid = new Map();
  for (const [sourceImageId, item] of Object.entries(files)) {
    const source = String(sourceImageId || '');
    const cid = String(item?.cid || '');
    if (!isOfficialPasscode(source) || !/^\d+$/.test(cid)) continue;
    if (!existingByCid.has(cid)) existingByCid.set(cid, []);
    existingByCid.get(cid).push(source);
  }

  for (const [sourceImageId, record] of mappings) {
    const source = String(sourceImageId || '');
    const cid = String(record?.cid || '');
    if (!isOfficialPasscode(source) || !/^\d+$/.test(cid)) continue;

    const previousCid = files[source]?.cid;
    if (previousCid !== undefined && previousCid !== null && String(previousCid) !== cid) {
      throw new Error(`NON_APPEND_CIID_SOURCE: 원본 ${source}의 CID가 ${previousCid}에서 ${cid}(으)로 변경되었습니다.`);
    }
    if (String(previousCid || '') === cid) continue;

    const existing = existingByCid.get(cid) || [];
    if (!existing.length) continue;
    const maxExisting = existing.reduce((max, value) => BigInt(value) > max ? BigInt(value) : max, 0n);
    if (BigInt(source) <= maxExisting) {
      throw new Error(`NON_APPEND_CIID_SOURCE: CID ${cid}의 신규 원본 ${source}가 기존 최대 원본 ${maxExisting}보다 크지 않아 CIID 재배정이 필요합니다.`);
    }
  }
}

function resolveCiids(mappings, manifest = { files: {} }) {
  const groups = new Map();
  const add = (sourceImageId, cid) => {
    const source = String(sourceImageId || '');
    const card = String(cid || '');
    if (!isOfficialPasscode(source) || !/^\d+$/.test(card)) return;
    if (!groups.has(card)) groups.set(card, new Set());
    groups.get(card).add(source);
  };

  for (const [sourceImageId, item] of Object.entries(manifest.files || {})) add(sourceImageId, item.cid);
  for (const [sourceImageId, record] of mappings) add(sourceImageId, record?.cid);

  const result = new Map();
  for (const sources of groups.values()) {
    const ordered = [...sources].sort((left, right) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (ordered.length > MAX_CIID) throw new Error('INVALID_CIID_MAPPING');
    ordered.forEach((sourceImageId, index) => result.set(sourceImageId, index + 1));
  }
  return result;
}

function isPendulumDocument(data) {
  return Array.isArray(data?.info?.properties) && data.info.properties.includes('Pendulum');
}

function buildArtworkUrl(sourceImageId, isPendulum) {
  return `${MOMOBAKO_PICS_BASE_URL}/${sourceImageId}.jpg${isPendulum ? '!artp' : '!art'}`;
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function selectCandidates(metadata, manifest, options) {
  let entries = [...metadata.values()];
  const files = manifest.files || {};
  if (options.retryPending) {
    entries = entries.filter(entry => files[entry.sourceImageId]?.status === 'pending');
  } else if (!options.full) {
    entries = entries.filter(entry => {
      const old = files[entry.sourceImageId];
      return !old || old.remoteMd5 !== entry.remoteMd5 || old.status === 'pending' || old.status === 'failed';
    });
  }
  entries.sort((a, b) => {
    const left = BigInt(a.sourceImageId);
    const right = BigInt(b.sourceImageId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (options.limit) entries = entries.slice(0, options.limit);
  return entries;
}

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HTTP_${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 300 * (2 ** (attempt - 1))));
  }
  throw lastError;
}

async function fetchMetadata(etag = '') {
  const headers = etag ? { 'If-None-Match': etag } : {};
  const response = await fetchWithRetry(MOMOBAKO_METADATA_URL, { headers });
  if (response.status === 304) {
    return { notModified: true, entries: new Map(), etag, lastModified: '' };
  }
  if (!response.ok) throw new Error(`Momobako metadata 요청 실패: HTTP ${response.status}`);
  return {
    notModified: false,
    entries: parseMetadata(await response.text()),
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function mapImageIds(entries) {
  const mapped = new Map();
  const eligible = entries.filter(entry => isOfficialPasscode(entry.sourceImageId));
  for (const batch of chunk(eligible, CARDSET_BATCH_SIZE)) {
    const ids = batch.map(entry => Number(entry.sourceImageId));
    const response = await fetchWithRetry(YGOCDB_CARDSET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error(`YGOCDB cardset 요청 실패: HTTP ${response.status}`);
    const body = await response.json();
    for (const [sourceImageId, record] of Object.entries(body || {})) {
      mapped.set(String(sourceImageId), record);
    }
  }
  return mapped;
}

function loadFirebaseAdmin() {
  try {
    return require('../functions/node_modules/firebase-admin');
  } catch {
    try {
      return require('firebase-admin');
    } catch {
      throw new Error('firebase-admin을 찾을 수 없습니다. functions 디렉터리에서 npm install을 실행해야 합니다.');
    }
  }
}

function findServiceAccountPath() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(ROOT_DIR, 'functions', 'serviceAccountKey.json'),
    path.join(ROOT_DIR, 'serviceAccountKey.json'),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function initializeFirestore() {
  const admin = loadFirebaseAdmin();
  if (!admin.apps.length) {
    const serviceAccountPath = findServiceAccountPath();
    if (serviceAccountPath) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      if (serviceAccount.project_id !== DEFAULT_PROJECT_ID) {
        throw new Error(`서비스 계정 프로젝트가 예상과 다릅니다: ${serviceAccount.project_id}`);
      }
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: DEFAULT_PROJECT_ID,
      });
    } else {
      admin.initializeApp({ projectId: DEFAULT_PROJECT_ID });
    }
  }
  return { admin, db: admin.firestore() };
}

async function readProjectCards(db, cids) {
  const result = new Map();
  for (const cidBatch of chunk([...new Set(cids.map(String))], FIRESTORE_BATCH_SIZE)) {
    const refs = cidBatch.map(cid => db.collection('cards').doc(cid));
    const snapshots = await db.getAll(...refs, { fieldMask: ['info.properties'] });
    for (const snapshot of snapshots) {
      result.set(snapshot.id, {
        exists: snapshot.exists,
        isPendulum: snapshot.exists && isPendulumDocument(snapshot.data()),
      });
    }
  }
  return result;
}

async function readManifest(filename) {
  try {
    const value = JSON.parse(await fsp.readFile(filename, 'utf8'));
    return value && value.schemaVersion === 1 && value.files ? value : createManifest();
  } catch (error) {
    if (error.code === 'ENOENT') return createManifest();
    throw new Error(`매니페스트 읽기 실패: ${error.message}`);
  }
}

function createManifest() {
  return {
    schemaVersion: 1,
    source: 'momobako-ygopro',
    lastStartedAt: 0,
    lastCompletedAt: 0,
    remoteMetadataEtag: '',
    remoteMetadataLastModified: '',
    files: {},
  };
}

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 2 > buffer.length) return null;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { format: 'jpeg', height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
    return null;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && buffer.length >= 30) {
    const width = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const height = buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
    return { format: 'webp', width: width + 1, height: height + 1 };
  }
  return null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function downloadArtwork(job, outputDir, manifest, dryRun, reassignedOwners = new Map()) {
  const targetName = `${job.cid}_${job.ciid}.webp`;
  const targetPath = path.join(outputDir, targetName);
  const transform = job.isPendulum ? 'artp' : 'art';
  if (dryRun) return { status: 'ready', targetName, transform, localSha256: null, dryRun: true };

  const response = await fetchWithRetry(buildArtworkUrl(job.sourceImageId, job.isPendulum));
  if (response.status === 404) return { status: 'pending', reason: 'REMOTE_IMAGE_NOT_FOUND', targetName, transform };
  if (!response.ok) throw new Error(`이미지 요청 실패: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dimensions = imageDimensions(buffer);
  const expected = job.isPendulum ? { width: 290, height: 216 } : { width: 256, height: 256 };
  if (!dimensions || dimensions.format !== 'webp' || dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new Error(`INVALID_IMAGE_DIMENSIONS:${dimensions ? `${dimensions.format}:${dimensions.width}x${dimensions.height}` : 'unknown-format'}`);
  }

  const digest = sha256(buffer);
  await fsp.mkdir(outputDir, { recursive: true });
  try {
    const existing = await fsp.readFile(targetPath);
    const existingDigest = sha256(existing);
    const priorOwner = Object.entries(manifest.files || {}).find(([, item]) => item.target === targetName)?.[0];
    if (existingDigest === digest) return { status: 'ready', targetName, transform, localSha256: digest, duplicate: true };
    if (priorOwner && priorOwner !== job.sourceImageId && reassignedOwners.get(targetName) !== job.sourceImageId) {
      return { status: 'conflict', reason: 'TARGET_CONTENT_MISMATCH', targetName, transform, localSha256: digest };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ygo-illustration-'));
  const temporaryPath = path.join(temporaryDir, targetName);
  try {
    await fsp.writeFile(temporaryPath, buffer);
    await fsp.rename(temporaryPath, targetPath);
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true });
  }
  return { status: 'ready', targetName, transform, localSha256: digest };
}

async function mapLimited(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

function baseManifestEntry(entry) {
  return {
    remoteSize: entry.remoteSize,
    remoteMtime: entry.remoteMtime,
    remoteMd5: entry.remoteMd5,
    lastCheckedAt: Date.now(),
  };
}

async function run(options) {
  const log = options.quiet ? () => {} : console.log;
  const manifest = await readManifest(options.manifestPath);
  const startedAt = Date.now();
  const summary = {
    metadataEntries: 0, candidates: 0, deferred: 0, mappedImages: 0, planned: 0, downloaded: 0, updated: 0,
    unchanged: 0, pendingTemporary: 0, pendingMissingCid: 0, pendingUnresolved: 0,
    excludedTokens: 0, conflicts: 0, failedDownloads: 0,
  };

  log('[동기화] Momobako metadata 확인 중');
  const hasRetryableEntries = Object.values(manifest.files || {}).some(item =>
    item.status === 'pending' || item.status === 'failed');
  const conditionalEtag = !options.ignoreEtag && !options.full && !options.retryPending && !hasRetryableEntries
    ? manifest.remoteMetadataEtag
    : '';
  const remote = await fetchMetadata(conditionalEtag);
  if (remote.notModified) {
    summary.unchanged = Object.keys(manifest.files || {}).length;
    log('[동기화] ETag 동일 — 변경 없음');
    console.log(JSON.stringify({ ...summary, notModified: true }, null, 2));
    return { ...summary, notModified: true };
  }
  summary.metadataEntries = remote.entries.size;
  const allCandidates = selectCandidates(remote.entries, manifest, { ...options, limit: null });
  let candidates = options.limit ? allCandidates.slice(0, options.limit) : allCandidates;
  summary.unchanged = remote.entries.size - allCandidates.length;
  summary.deferred = allCandidates.length - candidates.length;
  summary.candidates = candidates.length;
  log(`[동기화] 전체 ${remote.entries.size}개, 이번 평가 ${candidates.length}개`);

  const excludedTokens = candidates.filter(entry => TOKEN_SOURCE_IDS.has(entry.sourceImageId));
  candidates = candidates.filter(entry => !TOKEN_SOURCE_IDS.has(entry.sourceImageId));
  for (const entry of excludedTokens) {
    manifest.files[entry.sourceImageId] = {
      ...baseManifestEntry(entry), status: 'excluded',
      reason: TOKEN_PLACEHOLDER_IDS.has(entry.sourceImageId) ? 'TOKEN_PLACEHOLDER' : 'TOKEN_IMAGE',
    };
    summary.excludedTokens++;
    log(`[제외] ${entry.sourceImageId} — ${manifest.files[entry.sourceImageId].reason}`);
  }

  const temporary = candidates.filter(entry => isTemporaryPasscode(entry.sourceImageId));
  const invalid = candidates.filter(entry => !isOfficialPasscode(entry.sourceImageId) && !isTemporaryPasscode(entry.sourceImageId));
  candidates = candidates.filter(entry => isOfficialPasscode(entry.sourceImageId));
  for (const entry of temporary) {
    manifest.files[entry.sourceImageId] = {
      ...baseManifestEntry(entry), status: 'pending', reason: 'TEMPORARY_PASSCODE',
    };
    summary.pendingTemporary++;
    log(`[대기] ${entry.sourceImageId} — TEMPORARY_PASSCODE`);
  }
  for (const entry of invalid) {
    manifest.files[entry.sourceImageId] = {
      ...baseManifestEntry(entry), status: 'pending', reason: 'INVALID_SOURCE_ID',
    };
    summary.pendingUnresolved++;
    log(`[대기] ${entry.sourceImageId} — INVALID_SOURCE_ID`);
  }

  log(`[매핑] YGOCDB에서 ${candidates.length}개 이미지 확인 중`);
  const mappings = await mapImageIds(candidates);
  assertAppendOnlyCiidSources(mappings, manifest);
  const ciids = resolveCiids(mappings, manifest);
  const jobs = [];
  for (const entry of candidates) {
    const record = mappings.get(entry.sourceImageId);
    if (!record) {
      manifest.files[entry.sourceImageId] = {
        ...baseManifestEntry(entry), status: 'pending', reason: 'YGOCDB_MAPPING_NOT_FOUND',
      };
      summary.pendingUnresolved++;
      continue;
    }
    if (!isOfficialPasscode(record.id)) {
      manifest.files[entry.sourceImageId] = {
        ...baseManifestEntry(entry), cid: record.cid ? String(record.cid) : null,
        status: 'pending', reason: 'TEMPORARY_PASSCODE',
      };
      summary.pendingTemporary++;
      continue;
    }
    try {
      const ciid = ciids.get(entry.sourceImageId);
      if (!ciid) throw new Error('INVALID_CIID_MAPPING');
      jobs.push({ ...entry, record, cid: String(record.cid), ciid });
    } catch {
      manifest.files[entry.sourceImageId] = {
        ...baseManifestEntry(entry), cid: record.cid ? String(record.cid) : null,
        status: 'pending', reason: 'INVALID_CIID_MAPPING',
      };
      summary.pendingUnresolved++;
    }
  }

  const filteredJobs = options.cid ? jobs.filter(job => job.cid === String(options.cid)) : jobs;
  summary.mappedImages = filteredJobs.length;
  const { admin, db } = initializeFirestore();
  try {
    log(`[DB] 고유 CID ${new Set(filteredJobs.map(job => job.cid)).size}개 확인 중`);
    const projectCards = await readProjectCards(db, filteredJobs.map(job => job.cid));
    const downloadable = [];
    for (const job of filteredJobs) {
      const projectCard = projectCards.get(job.cid);
      if (!projectCard?.exists) {
        manifest.files[job.sourceImageId] = {
          ...baseManifestEntry(job), cid: job.cid, ciid: job.ciid,
          status: 'pending', reason: 'CID_NOT_IN_PROJECT',
        };
        summary.pendingMissingCid++;
        log(`[대기] ${job.sourceImageId} → CID ${job.cid} — CID_NOT_IN_PROJECT`);
        continue;
      }
      downloadable.push({ ...job, isPendulum: projectCard.isPendulum });
    }
    const desiredTargets = new Map(downloadable.map(job => [job.sourceImageId, `${job.cid}_${job.ciid}.webp`]));
    const reassignedOwners = new Map();
    for (const job of downloadable) {
      const targetName = desiredTargets.get(job.sourceImageId);
      const priorOwner = Object.entries(manifest.files || {}).find(([, item]) => item.target === targetName)?.[0];
      if (priorOwner && priorOwner !== job.sourceImageId && desiredTargets.get(priorOwner) !== targetName) {
        reassignedOwners.set(targetName, job.sourceImageId);
      }
    }

    let processedSinceCheckpoint = 0;
    let checkpointQueue = Promise.resolve();
    const checkpoint = async () => {
      if (options.dryRun || ++processedSinceCheckpoint < MANIFEST_CHECKPOINT_SIZE) return;
      processedSinceCheckpoint = 0;
      manifest.lastStartedAt = startedAt;
      manifest.remoteMetadataEtag = remote.etag;
      manifest.remoteMetadataLastModified = remote.lastModified;
      checkpointQueue = checkpointQueue.then(() => writeJsonAtomic(options.manifestPath, manifest));
      await checkpointQueue;
    };

    await mapLimited(downloadable, options.concurrency, async job => {
      const old = manifest.files[job.sourceImageId];
      try {
        const result = await downloadArtwork(job, options.outputDir, manifest, options.dryRun, reassignedOwners);
        manifest.files[job.sourceImageId] = {
          ...baseManifestEntry(job), cid: job.cid, ciid: job.ciid,
          target: result.targetName, transform: result.transform,
          localSha256: result.localSha256 || old?.localSha256 || null,
          status: result.status, reason: result.reason || null,
        };
        if (result.status === 'conflict') summary.conflicts++;
        else if (result.status === 'pending') summary.pendingUnresolved++;
        else if (options.dryRun) summary.planned++;
        else if (old?.status === 'ready') summary.updated++;
        else summary.downloaded++;
        log(`[${options.dryRun ? '예정' : '저장'}] ${job.sourceImageId} → ${result.targetName} (!${result.transform})`);
      } catch (error) {
        manifest.files[job.sourceImageId] = {
          ...baseManifestEntry(job), cid: job.cid, ciid: job.ciid,
          target: `${job.cid}_${job.ciid}.webp`, transform: job.isPendulum ? 'artp' : 'art',
          localSha256: old?.localSha256 || null, status: 'failed', reason: error.message,
        };
        summary.failedDownloads++;
        console.error(`[실패] ${job.sourceImageId} → ${job.cid}_${job.ciid}.webp — ${error.message}`);
      }
      await checkpoint();
    });
    await checkpointQueue;
  } finally {
    await admin.app().delete();
  }

  if (!options.dryRun) {
    const remoteIds = new Set(remote.entries.keys());
    for (const [sourceImageId, item] of Object.entries(manifest.files)) {
      if (!remoteIds.has(sourceImageId) && item.status !== 'sourceMissing') {
        manifest.files[sourceImageId] = { ...item, status: 'sourceMissing', lastCheckedAt: Date.now() };
      }
    }
    manifest.lastStartedAt = startedAt;
    if (summary.failedDownloads === 0 && summary.conflicts === 0) manifest.lastCompletedAt = Date.now();
    manifest.remoteMetadataEtag = remote.etag;
    manifest.remoteMetadataLastModified = remote.lastModified;
    await writeJsonAtomic(options.manifestPath, manifest);
  }

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
  parseArgs, parseMetadata, isOfficialPasscode, isTemporaryPasscode, assertAppendOnlyCiidSources, resolveCiids, isPendulumDocument,
  buildArtworkUrl, selectCandidates, imageDimensions, createManifest, chunk, fetchMetadata, run,
  TOKEN_SOURCE_IDS,
};
