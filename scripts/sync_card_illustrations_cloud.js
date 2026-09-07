#!/usr/bin/env node

const fsp = require('node:fs/promises');
const path = require('node:path');
const sync = require('./sync_card_illustrations');
const upload = require('./upload_card_illustrations');
const phash = require('./build_card_illustration_phash');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCAL_MANIFEST = path.join(ROOT_DIR, 'data', 'illustration-sync', 'manifest.json');
const REMOTE_STATE_PATH = 'system/illustration-sync/manifest.json';
const LOCAL_PHASH_INDEX = path.join(ROOT_DIR, 'data', 'illustration-sync', 'phash-index.json');
const REMOTE_PHASH_INDEX = 'system/illustration-search/phash.json';
const BUCKET_NAME = 'ygo-synapse.firebasestorage.app';

async function restoreRemoteArtifacts() {
  const { admin, bucket } = upload.initializeStorage(BUCKET_NAME);
  try {
    const [state, searchIndex] = await Promise.all([
      upload.readJsonObject(bucket, REMOTE_STATE_PATH, null),
      upload.readJsonObject(bucket, REMOTE_PHASH_INDEX, null),
    ]);
    await fsp.mkdir(path.dirname(LOCAL_MANIFEST), { recursive: true });
    if (state.value) await fsp.writeFile(LOCAL_MANIFEST, `${JSON.stringify(state.value, null, 2)}\n`, 'utf8');
    if (searchIndex.value) await fsp.writeFile(LOCAL_PHASH_INDEX, `${JSON.stringify(searchIndex.value)}\n`, 'utf8');
    return { state: Boolean(state.value), searchIndex: Boolean(searchIndex.value) };
  } finally {
    await admin.app().delete();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) throw new Error('클라우드 동기화는 실제 쓰기 작업입니다. --apply가 필요합니다.');

  const restored = await restoreRemoteArtifacts();
  console.log(`[상태] 매니페스트=${restored.state ? '복원' : '최초'}, pHash=${restored.searchIndex ? '복원' : '최초'}`);

  const syncOptions = sync.parseArgs(['--quiet', '--manifest', LOCAL_MANIFEST]);
  const syncResult = await sync.run(syncOptions);
  if (syncResult.notModified) return;

  await phash.run(phash.parseArgs([
    '--quiet', '--manifest', LOCAL_MANIFEST, '--output', LOCAL_PHASH_INDEX,
  ]));

  const uploadOptions = upload.parseArgs([
    '--apply', '--quiet', '--manifest', LOCAL_MANIFEST, '--search-index', LOCAL_PHASH_INDEX,
  ]);
  await upload.run(uploadOptions);
}

main().catch(error => {
  console.error(`[오류] ${error.stack || error.message}`);
  process.exitCode = 1;
});
