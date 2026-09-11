// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Keeps every object. Only revokes bearer tokens/public ACL and changes caching.
const { initializeStorage } = require('./upload_card_illustrations');
async function run(apply) {
  const { bucket } = initializeStorage('ygo-synapse.firebasestorage.app');
  const [data] = await bucket.file('private/illustrations-index.json').download();
  const index = JSON.parse(data.toString());
  const keys = Object.keys(index.files || {});
  if (!keys.length || keys.some(k=>!/^\d+_[1-9]\d*$/.test(k))) throw new Error('인덱스 검증 실패');
  const paths = keys.flatMap(k=>[`public/resources/illustrations/${k}.webp`,`private/illustrations/${k}.webp`]);
  paths.push('public/indexes/illustration_sources.json','private/illustrations-index.json');
  console.log(JSON.stringify({apply,objects:paths.length,deletes:false}));
  if (!apply) return;
  let cursor=0,verified=0;
  await Promise.all(Array.from({length:64},async()=>{
    while(cursor<paths.length) {
      const objectPath=paths[cursor++], file=bucket.file(objectPath);
      const [[before],[acl]]=await Promise.all([file.getMetadata(),file.acl.get()]);
      const tokens=String(before.metadata?.firebaseStorageDownloadTokens||'').split(',').filter(Boolean);
      if(tokens.length || before.cacheControl!=='private, no-store') await file.setMetadata({cacheControl:'private, no-store',metadata:{firebaseStorageDownloadTokens:null}},
        {preconditionOpts:{ifMetagenerationMatch:before.metageneration}});
      const publicACL=acl.filter(entry=>['allUsers','allAuthenticatedUsers'].includes(entry.entity));
      for(const entry of publicACL) await file.acl.delete({entity:entry.entity});
      const [[after],[newAcl]]=await Promise.all([
        tokens.length || before.cacheControl!=='private, no-store' ? file.getMetadata() : Promise.resolve([before]),
        publicACL.length ? file.acl.get() : Promise.resolve([acl])]);
      if(after.metadata?.firebaseStorageDownloadTokens || newAcl.some(e=>['allUsers','allAuthenticatedUsers'].includes(e.entity))) throw new Error('권한 검증 실패');
      // Verify old tokens on a bounded sample without printing token values.
      if(objectPath.endsWith('/10000_1.webp')) for(const token of tokens) {
        const url=`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;
        const response=await fetch(url,{headers:{Range:'bytes=0-0'},signal:AbortSignal.timeout(15000)});
        await response.body?.cancel();
        if(response.ok) throw new Error('기존 토큰이 아직 유효합니다');
        if(![401,403].includes(response.status)) throw new Error('토큰 차단 결과 불명확');
      }
      if(++verified%500===0)console.log(JSON.stringify({verified,total:paths.length}));
    }
  }));
  console.log('지정된 모든 객체의 토큰·공개 ACL 제거 검증 완료. 파일 삭제 없음.');
}
if(require.main===module){
  if(process.argv.slice(2).some(a=>a!=='--apply'))throw new Error('지원 옵션: --apply');
  run(process.argv.includes('--apply')).catch(()=>{console.error('차단 검증 실패. 민감 오류 내용 생략.');process.exitCode=1});
}
module.exports={run};
