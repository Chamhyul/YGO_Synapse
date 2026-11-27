'use strict';
const crypto=require('node:crypto');
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function prepareResume({id,locale,journal,loadResults}){
 if(!/^[a-z0-9-]{1,70}$/.test(id||'')||locale!=='ja')throw Error('INVALID_FULL_RESUME');
 const state=await journal.read('state');if(!state)throw Error('RESUME_STATE_MISSING');
 // 같은 실행의 다음 태스크가 차단·오류 중단을 다시 해제하지 못하게 한다.
 if(state.resumeId===id)return state;
 let plan=await journal.read('resumes/'+id);
 if(!plan){
  if(state.status!=='paused'||state.reason!=='FULL_CRAWL_FAILED'||state.localeIndex!==1)throw Error('RESUME_SOURCE_MISMATCH');
  const catalog=await journal.read('catalogs/'+locale),results=await loadResults(locale);
  const reviewed=new Set(results.filter(p=>p.locale===locale&&['review','incomplete'].includes(p.status)).map(p=>p.pid));
  const pids=catalog.slice(0,state.packIndex).filter(p=>reviewed.has(p.pid)).map(p=>p.pid);
  if(!pids.length||pids.length!==state.counts[locale].packIssues)throw Error('RESUME_REVIEW_COUNT_MISMATCH');
  plan={id,locale,before:state,beforeHash:fingerprint(state),pids,createdAt:new Date().toISOString()};
  await journal.write('resumes/'+id,plan,{once:true});
 }
 if(fingerprint(state)!==plan.beforeHash)throw Error('RESUME_SOURCE_CHANGED');
 const next=structuredClone(state);next.resumeId=id;next.status='running';next.phase='recheck';delete next.reason;
 next.recovery={id,locale,pids:plan.pids,total:plan.pids.length,index:0,resolved:0,remainingIssues:0};
 next.packFailureStreak=0;next.transportErrors=0;next.updatedAt=new Date().toISOString();
 await journal.write('state',next);return next;
}
module.exports={prepareResume};
