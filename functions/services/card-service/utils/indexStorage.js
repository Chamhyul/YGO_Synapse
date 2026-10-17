/** 자동완성 목록만 Storage에 보관합니다. 카드 검색은 DB를 사용합니다. */
const { getBucket } = require('../config/firebase');
const MANIFEST_PATH = 'public/cardNames.json';
// 파일 전용 계약. DB 대기 기록이나 잠금은 호출자가 관리한다.
function createCardManifestFileStore({ getBucket, now = Date.now }) {
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
    const data = { names, numbers, updatedAt: now() };
    await getBucket().file(MANIFEST_PATH).save(JSON.stringify(data), {
      resumable: false, contentType: 'application/json',
      metadata: { cacheControl: 'no-cache' },
      preconditionOpts: { ifGenerationMatch: generation },
    });
    cached = { data, expires: now() + 60000 };
    return { nameCount: names.length, numberCount: numbers.length };
  }
  async function getCardManifest() {
    if (cached && cached.expires > now()) return cached.data;
    const [buffer] = await getBucket().file(MANIFEST_PATH).download();
    const data = JSON.parse(buffer.toString('utf8'));
    if (!Array.isArray(data.names) || !Array.isArray(data.numbers)) throw new Error('카드 목록 형식 오류');
    cached = { data, expires: now() + 60000 };
    return data;
  }
  return { readManifestGeneration, writeCardManifest, getCardManifest };
}
module.exports = { createCardManifestFileStore, ...createCardManifestFileStore({ getBucket }) };
