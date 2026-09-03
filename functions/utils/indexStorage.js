/** 자동완성 목록만 Storage에 보관합니다. 카드 검색은 DB를 사용합니다. */
const { getBucket } = require('../config/firebase');
const MANIFEST_PATH = 'public/cardNames.json';
let cached = null;
async function readManifestGeneration() {
  try {
    const [metadata] = await getBucket().file(MANIFEST_PATH).getMetadata();
    return metadata.generation;
  } catch (error) {
    if (Number(error.code) === 404) return 0;
    throw error;
  }
}
async function writeCardManifest(names, numbers, generation) {
  const data = { names, numbers, updatedAt: Date.now() };
  await getBucket().file(MANIFEST_PATH).save(JSON.stringify(data), {
    resumable: false, contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
    preconditionOpts: { ifGenerationMatch: generation },
  });
  cached = { data, expires: Date.now() + 60000 };
  return { nameCount: names.length, numberCount: numbers.length };
}
async function getCardManifest() {
  if (cached && cached.expires > Date.now()) return cached.data;
  const [buffer] = await getBucket().file(MANIFEST_PATH).download();
  const data = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(data.names) || !Array.isArray(data.numbers)) throw new Error('카드 목록 형식 오류');
  cached = { data, expires: Date.now() + 60000 };
  return data;
}
module.exports = { readManifestGeneration, writeCardManifest, getCardManifest };
