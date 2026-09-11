// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Explicit --apply copies only. Never removes or modifies the public originals.
const crypto = require('node:crypto');
const { initializeStorage } = require('./upload_card_illustrations');
const { PREFIX, INDEX } = require('../functions/services/illustrationDelivery');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function run(apply = false) {
  const { bucket } = initializeStorage('ygo-synapse.firebasestorage.app');
  const [data] = await bucket.file('public/indexes/illustration_sources.json').download();
  const index = JSON.parse(data.toString('utf8'));
  const entries = Object.entries(index.files || {});
  if (!entries.length) throw new Error('소스 인덱스가 비어 있습니다.');
  for (const [key,item] of entries) {
    if (!/^[1-9]\d{0,9}_[1-9]\d{0,3}$/.test(key) || item.storagePath !== `public/resources/illustrations/${key}.webp` || !/^[a-f0-9]{64}$/.test(item.contentSha256 || '')) throw new Error('소스 경로 또는 해시 검증 실패');
  }
  console.log(JSON.stringify({ mode:apply?'copy-and-verify':'dry-run', count:entries.length, destination:PREFIX, deletes:false }));
  if (!apply) return;
  let cursor = 0, verified = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
  while (cursor < entries.length) {
    const [key,item] = entries[cursor++];
    const [bytes] = await bucket.file(item.storagePath).download();
    if (hash(bytes) !== item.contentSha256) throw new Error(`원본 해시 불일치: ${key}`);
    const target = bucket.file(`${PREFIX}/${key}.webp`);
    const [exists] = await target.exists();
    if (!exists) await target.save(bytes, { resumable:false, preconditionOpts:{ifGenerationMatch:0}, metadata:{contentType:'image/webp',cacheControl:'private, no-store'} });
    const [[copy],[meta]] = await Promise.all([target.download(),target.getMetadata()]);
    if (hash(copy)!==item.contentSha256 || meta.metadata?.firebaseStorageDownloadTokens || meta.cacheControl!=='private, no-store') throw new Error(`사본 검증 실패: ${key}`);
    item.storagePath = `${PREFIX}/${key}.webp`;
    if (++verified % 250 === 0) console.log(JSON.stringify({verified,total:entries.length}));
  }
  }));
  const target = bucket.file(INDEX);
  const bytes = Buffer.from(JSON.stringify(index));
  const [exists] = await target.exists();
  if (!exists) await target.save(bytes,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:'application/json',cacheControl:'private, no-store'}});
  const [saved] = await target.download();
  if (hash(saved)!==hash(bytes)) throw new Error('대상 인덱스가 다릅니다. 자동 덮어쓰지 않습니다.');
  console.log('모든 사본 검증 완료. 공개본과 운영 규칙은 변경하지 않았습니다.');
}
if (require.main===module) {
  const args=process.argv.slice(2);
  if (args.some(x=>x!=='--apply')) throw new Error('지원 옵션: --apply');
  run(args.includes('--apply')).catch(()=>{ console.error('준비 실패: 인증/경로/해시/대상 상태를 확인하십시오. 민감 오류 내용은 생략합니다.');process.exitCode=1; });
}
module.exports={run};
