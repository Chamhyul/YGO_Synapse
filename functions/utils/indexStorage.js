/** Storage 검색 인덱스 읽기·버전 검사 저장. 쓰기는 cardIndexService에서 조정합니다. */
const { getBucket } = require('../config/firebase');
const INDEX_PATHS = {
  byName: 'public/indexes/idx_byName.json',
  byNumber: 'public/indexes/idx_byNumber.json',
  cid: 'public/indexes/idx_cid.json',
};
const CACHE_TTL_MS = 60 * 1000;
const cache = Object.create(null);

async function readIndexGeneration(type) {
  try {
    const [metadata] = await getBucket().file(INDEX_PATHS[type]).getMetadata();
    return metadata.generation;
  } catch (error) {
    if (Number(error.code) === 404) return 0;
    throw error;
  }
}

async function readIndexFile(type) {
  const path = INDEX_PATHS[type];
  if (!path) throw new Error(`알 수 없는 인덱스: ${type}`);
  const bucket = getBucket();
  for (let attempt = 0; attempt < 3; attempt++) {
    let metadata;
    try {
      [metadata] = await bucket.file(path).getMetadata();
    } catch (error) {
      if (Number(error.code) === 404) return { data: Object.create(null), generation: 0 };
      throw error;
    }
    try {
      // 메타정보에서 확인한 바로 그 버전을 읽습니다.
      const [content] = await bucket.file(path, { generation: metadata.generation }).download();
      const parsed = JSON.parse(content.toString('utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`잘못된 인덱스 형식: ${type}`);
      return { data: Object.assign(Object.create(null), parsed), generation: metadata.generation };
    } catch (error) {
      if (Number(error.code) === 404 && attempt < 2) continue;
      throw error;
    }
  }
}

async function writeIndexFile(type, data, generation) {
  await getBucket().file(INDEX_PATHS[type]).save(JSON.stringify(data), {
    resumable: false,
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
    preconditionOpts: { ifGenerationMatch: generation },
  });
  cache[type] = { data, loadedAt: Date.now() };
}

async function downloadIndex(type) {
  const { data } = await readIndexFile(type);
  cache[type] = { data, loadedAt: Date.now() };
  return data;
}

async function getIndex(type, forceRefresh) {
  const entry = cache[type];
  if (!forceRefresh && entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) return entry.data;
  return downloadIndex(type);
}
const getIdxByName = (force = false) => getIndex('byName', force);
const getIdxByNumber = (force = false) => getIndex('byNumber', force);
const getIdxCid = (force = false) => getIndex('cid', force);

function invalidateCache(type) {
  if (type) delete cache[type];
  else for (const key of Object.keys(cache)) delete cache[key];
}

async function readManifestGeneration() {
  try {
    const [metadata] = await getBucket().file('public/cardNames.json').getMetadata();
    return metadata.generation;
  } catch (error) {
    if (Number(error.code) === 404) return 0;
    throw error;
  }
}

async function writeCardManifest(byName, byNumber, generation) {
  const names = Object.keys(byName).filter(name => !name.startsWith('##'));
  const numbers = Object.keys(byNumber).filter(number => !number.startsWith('##'));
  const file = getBucket().file('public/cardNames.json');
  await file.save(JSON.stringify({ names, numbers, updatedAt: Date.now() }), {
    resumable: false,
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
    preconditionOpts: { ifGenerationMatch: generation },
  });
  return { nameCount: names.length, numberCount: numbers.length };
}

module.exports = { INDEX_PATHS, readIndexGeneration, readIndexFile, writeIndexFile, writeCardManifest, readManifestGeneration,
  downloadIndex, getIdxByName, getIdxByNumber, getIdxCid, invalidateCache };
