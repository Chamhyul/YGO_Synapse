'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const base = path.resolve(__dirname, '../functions/services/card-service');
const hashes = require('../functions/services/card-service/content-sha256.json');
function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (item.isSymbolicLink()) throw Error('카드 패키지 심볼릭 링크 금지');
    return item.isDirectory() ? files(path.join(directory, item.name), prefix + item.name + '/') : [prefix + item.name];
  });
}
const expected = new Set([...Object.keys(hashes), 'content-sha256.json']);
if (files(base).some(file => !expected.has(file))) throw Error('카드 패키지 미등록 파일');
for (const [file, digest] of Object.entries(hashes)) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) throw Error('카드 패키지 경로 오류');
  if (createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== digest) {
    throw new Error(`생성된 카드 패키지 불일치: ${file}`);
  }
}
const release = require('../functions/services/card-service/release.json');
if (release.readApiVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(release.version)
  || !/^[a-f0-9]{64}$/.test(release.sourceSha256)) throw Error('카드 패키지 버전 정보 오류');
const manifest = require('../functions/services/card-service/manifest.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceDigest = sha(JSON.stringify(manifest.modules.map(file => [file, hashes[file]])
  .concat([['manifest.json', sha(JSON.stringify(manifest))]])));
if (sourceDigest !== release.sourceSha256) throw Error('카드 패키지 원본 해시 불일치');
const lockPath = path.resolve(__dirname, '../card-service.lock.json');
if (fs.existsSync(lockPath) && JSON.stringify(JSON.parse(fs.readFileSync(lockPath))) !== JSON.stringify(release)) {
  throw Error('기존 서비스가 고정한 카드 패키지 버전/원본 해시 불일치');
}
console.log('카드 호환 패키지 무결성 확인 완료');
