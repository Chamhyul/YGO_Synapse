#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_IMAGE_DIR = path.join(ROOT_DIR, 'resources', 'illustrations');
const DEFAULT_MANIFEST_PATH = path.join(ROOT_DIR, 'data', 'illustration-sync', 'manifest.json');
const DEFAULT_BUCKET = 'ygo-synapse.firebasestorage.app';
const DEFAULT_PUBLIC_PREFIX = 'private/illustrations';
const DEFAULT_INDEX_PATH = 'private/illustrations-index.json';
const DEFAULT_STATE_PATH = 'system/illustration-sync/manifest.json';
const DEFAULT_SEARCH_INDEX_PATH = path.join(path.dirname(DEFAULT_MANIFEST_PATH), 'phash-index.json');
const DEFAULT_REMOTE_SEARCH_INDEX_PATH = 'system/illustration-search/phash.json';
const DEFAULT_CONCURRENCY = 8;

function parseArgs(argv) {
  const options = {
    apply: false,
    quiet: false,
    imageDir: DEFAULT_IMAGE_DIR,
    manifestPath: DEFAULT_MANIFEST_PATH,
    bucketName: DEFAULT_BUCKET,
    publicPrefix: DEFAULT_PUBLIC_PREFIX,
    indexPath: DEFAULT_INDEX_PATH,
    statePath: DEFAULT_STATE_PATH,
    searchIndexPath: DEFAULT_SEARCH_INDEX_PATH,
    remoteSearchIndexPath: DEFAULT_REMOTE_SEARCH_INDEX_PATH,
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--image-dir') options.imageDir = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--manifest') options.manifestPath = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--bucket') options.bucketName = requireValue(argv, ++index, arg);
    else if (arg === '--public-prefix') options.publicPrefix = trimSlashes(requireValue(argv, ++index, arg));
    else if (arg === '--index-path') options.indexPath = trimSlashes(requireValue(argv, ++index, arg));
    else if (arg === '--state-path') options.statePath = trimSlashes(requireValue(argv, ++index, arg));
    else if (arg === '--search-index') options.searchIndexPath = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--remote-search-index') options.remoteSearchIndexPath = trimSlashes(requireValue(argv, ++index, arg));
    else if (arg === '--concurrency') options.concurrency = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
    else if (arg === '--limit') options.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
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

function trimSlashes(value) {
  return String(value).replace(/^\/+|\/+$/g, '');
}

function printHelp() {
  console.log(`사용법: node scripts/upload_card_illustrations.js [옵션]

기본 실행은 쓰기 없는 dry-run입니다. 실제 Storage 쓰기는 --apply가 필요합니다.

옵션:
  --apply               이미지·인덱스·원격 상태를 실제 업로드
  --quiet               항목별 로그 생략
  --image-dir <경로>    로컬 이미지 디렉터리
  --manifest <경로>     로컬 동기화 매니페스트
  --bucket <이름>       Firebase Storage 버킷
  --public-prefix <경로> 이미지 객체 접두 경로 (호환 옵션명, 기본 private/illustrations)
  --index-path <경로>   표시용 소스 인덱스 객체 경로
  --state-path <경로>   비공개 동기화 상태 객체 경로
  --search-index <경로> 로컬 pHash 검색 인덱스
  --remote-search-index <경로> 비공개 pHash 인덱스 객체 경로
  --concurrency <개수>  동시 업로드 수 (기본: ${DEFAULT_CONCURRENCY})
  --limit <개수>        업로드 대상 수 제한(표본 검증용)
  --help                도움말 출력`);
}

function loadFirebaseAdmin() {
  try {
    return require('../functions/node_modules/firebase-admin');
  } catch {
    return require('firebase-admin');
  }
}

function findServiceAccountPath() {
  return [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(ROOT_DIR, 'functions', 'serviceAccountKey.json'),
    path.join(ROOT_DIR, 'serviceAccountKey.json'),
  ].filter(Boolean).find(candidate => fs.existsSync(candidate)) || null;
}

function initializeStorage(bucketName) {
  const admin = loadFirebaseAdmin();
  if (!admin.apps.length) {
    const serviceAccountPath = findServiceAccountPath();
    const config = { projectId: 'ygo-synapse', storageBucket: bucketName };
    if (serviceAccountPath) {
      config.credential = admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')));
    }
    admin.initializeApp(config);
  }
  return { admin, bucket: admin.storage().bucket(bucketName) };
}

function isTargetName(value) {
  return /^\d+_[1-9]\d*\.webp$/.test(String(value || ''));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildSourceIndex(manifest, publicPrefix) {
  const files = {};
  const owners = new Map();
  for (const [sourceImageId, item] of Object.entries(manifest.files || {})) {
    const retainMissingSource = item.status === 'sourceMissing' && item.target && item.cid && item.ciid;
    if (item.status !== 'ready' && !retainMissingSource) continue;
    if (!isTargetName(item.target)) throw new Error(`잘못된 대상 파일명: ${item.target}`);
    const key = item.target.replace(/\.webp$/, '');
    if (owners.has(key) && owners.get(key) !== sourceImageId) {
      throw new Error(`중복 CID/ciid 대상: ${key} (${owners.get(key)}, ${sourceImageId})`);
    }
    owners.set(key, sourceImageId);
    files[key] = {
      sourceImageId,
      cid: String(item.cid),
      ciid: Number(item.ciid),
      transform: item.transform === 'artp' ? 'artp' : 'art',
      cdnAvailable: item.status === 'ready',
      sourceMissing: item.status === 'sourceMissing' || undefined,
      storagePath: `${trimSlashes(publicPrefix)}/${item.target}`,
      contentSha256: item.localSha256 || null,
    };
    if (files[key].sourceMissing === undefined) delete files[key].sourceMissing;
  }
  return { schemaVersion: 1, generatedAt: Date.now(), files };
}

function selectUploadCandidates(sourceIndex, remoteIndex, imageDir) {
  const remoteFiles = remoteIndex?.files || {};
  return Object.entries(sourceIndex.files).flatMap(([key, item]) => {
    const localPath = path.join(imageDir, `${key}.webp`);
    if (!fs.existsSync(localPath)) return [];
    if (item.contentSha256 && remoteFiles[key]?.contentSha256 === item.contentSha256) return [];
    return [{ key, localPath, targetPath: item.storagePath, item, remote: remoteFiles[key] || null }];
  });
}

function validateSearchIndex(sourceIndex, searchIndex) {
  if (searchIndex?.schemaVersion !== 1 || !searchIndex.algorithmVersion || !searchIndex.files) {
    throw new Error('유효한 pHash 검색 인덱스가 아닙니다.');
  }
  const sourceKeys = Object.keys(sourceIndex.files).sort();
  const searchKeys = Object.keys(searchIndex.files).sort();
  const missing = sourceKeys.filter(key => !searchIndex.files[key]);
  const stale = searchKeys.filter(key => !sourceIndex.files[key]);
  if (missing.length || stale.length) {
    throw new Error(`pHash 인덱스 불완전: 누락 ${missing.length}개, 불필요 ${stale.length}개`);
  }
  for (const key of sourceKeys) {
    const source = sourceIndex.files[key];
    const search = searchIndex.files[key];
    if (String(search.cid) !== source.cid || Number(search.ciid) !== source.ciid) {
      throw new Error(`pHash CID/ciid 불일치: ${key}`);
    }
    if (!/^[a-f0-9]{16}$/.test(search.phash || '')) throw new Error(`잘못된 pHash: ${key}`);
    if (source.contentSha256 && search.contentSha256 !== source.contentSha256) {
      throw new Error(`pHash 원본 해시 불일치: ${key}`);
    }
  }
}

async function readJsonObject(bucket, objectPath, fallback) {
  const file = bucket.file(objectPath);
  try {
    const [[metadata], [buffer]] = await Promise.all([file.getMetadata(), file.download()]);
    return { value: JSON.parse(buffer.toString('utf8')), generation: Number(metadata.generation) };
  } catch (error) {
    if (error.code === 404) return { value: fallback, generation: 0 };
    throw error;
  }
}

async function mapLimited(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await operation(items[cursor++]);
  });
  await Promise.all(workers);
}

async function saveJsonObject(bucket, objectPath, value, generation, cacheControl) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    contentType: 'application/json; charset=utf-8',
    metadata: { cacheControl },
    preconditionOpts: { ifGenerationMatch: generation },
  });
}

async function uploadOne(bucket, candidate) {
  const buffer = await fsp.readFile(candidate.localPath);
  const digest = sha256(buffer);
  if (candidate.item.contentSha256 && candidate.item.contentSha256 !== digest) {
    throw new Error(`로컬 해시 불일치: ${candidate.key}`);
  }
  candidate.item.contentSha256 = digest;
  const target = bucket.file(candidate.targetPath);
  let generation = 0;
  try {
    const [metadata] = await target.getMetadata();
    generation = Number(metadata.generation);
    if (metadata.metadata?.contentSha256 === digest) return { skipped: true, bytes: 0 };
  } catch (error) {
    if (error.code !== 404) throw error;
  }
  await target.save(buffer, {
    resumable: false,
    contentType: 'image/webp',
    metadata: {
      cacheControl: 'private, no-store',
      metadata: {
        sourceImageId: candidate.item.sourceImageId,
        contentSha256: digest,
        transform: candidate.item.transform,
      },
    },
    preconditionOpts: { ifGenerationMatch: generation },
  });
  return { skipped: false, bytes: buffer.length };
}

async function run(options) {
  const log = options.quiet ? () => {} : console.log;
  const manifest = JSON.parse(await fsp.readFile(options.manifestPath, 'utf8'));
  const sourceIndex = buildSourceIndex(manifest, options.publicPrefix);
  const searchIndex = JSON.parse(await fsp.readFile(options.searchIndexPath, 'utf8'));
  validateSearchIndex(sourceIndex, searchIndex);
  const { admin, bucket } = initializeStorage(options.bucketName);
  const summary = { indexed: Object.keys(sourceIndex.files).length, candidates: 0, uploaded: 0, skipped: 0, bytes: 0 };
  try {
    const remote = await readJsonObject(bucket, options.indexPath, { schemaVersion: 1, generatedAt: 0, files: {} });
    let candidates = selectUploadCandidates(sourceIndex, remote.value, options.imageDir);
    if (options.limit) candidates = candidates.slice(0, options.limit);
    summary.candidates = candidates.length;
    if (!options.apply) {
      console.log(JSON.stringify({ ...summary, dryRun: true }, null, 2));
      return { ...summary, dryRun: true };
    }

    await mapLimited(candidates, options.concurrency, async candidate => {
      const result = await uploadOne(bucket, candidate);
      if (result.skipped) summary.skipped++;
      else {
        summary.uploaded++;
        summary.bytes += result.bytes;
        log(`[업로드] ${candidate.key}.webp`);
      }
    });

    if (options.limit) {
      console.log(JSON.stringify({ ...summary, partial: true }, null, 2));
      return { ...summary, partial: true };
    }

    const remoteSearch = await readJsonObject(bucket, options.remoteSearchIndexPath, null);
    await saveJsonObject(bucket, options.remoteSearchIndexPath, searchIndex, remoteSearch.generation, 'private, no-store');
    await saveJsonObject(bucket, options.indexPath, sourceIndex, remote.generation, 'private, no-store');
    const state = await readJsonObject(bucket, options.statePath, null);
    await saveJsonObject(bucket, options.statePath, manifest, state.generation, 'no-store');
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await admin.app().delete();
  }
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
  parseArgs, isTargetName, buildSourceIndex, selectUploadCandidates, sha256,
  validateSearchIndex, initializeStorage, readJsonObject, run,
};
