'use strict';
const {collect,createLimiter}=require('./fetch.cjs');
const {writeSnapshot}=require('./writer.cjs');
const safeCode=e=>/^[A-Z0-9_]+$/.test(e.message)?e.message:'CRAWL_FAILED';
function targets(value){
 const ids=String(value||'').split(':');
 if(!ids.length||ids.length>100||ids.some(v=>!(/^[1-9]\d{0,8}$/).test(v))||new Set(ids).size!==ids.length)throw Error('INVALID_BATCH_TARGETS');
 return ids.map(Number);
}
async function runBatch({id,cids,journal,collectCard=collect,store,limiter=createLimiter({maxRequests:cids.length*10}),log=console.log,retryFailed=false}){
 if(!/^[a-z0-9-]{1,80}$/.test(id))throw Error('INVALID_BATCH_ID');
 let state=await journal.read();
 if(state&&(state.id!==id||JSON.stringify(state.cids)!==JSON.stringify(cids)||state.version!==1))throw Error('BATCH_TARGET_MISMATCH');
 state ||= {version:1,id,cids,createdAt:new Date().toISOString(),status:'running',cards:{}};
 const save=async()=>{state.updatedAt=new Date().toISOString();await journal.save(state);};
 state.status='running';await save();let failures=0;
 for(const cid of cids){
  const entry=state.cards[cid];if(entry?.status==='stored'||entry?.status==='failed'&&!retryFailed)continue;
  state.cards[cid]={status:'collecting',attempts:(entry?.attempts||0)+1};await save();
  try{
   const snapshot=await collectCard(cid,{limiter,onProgress:value=>log(JSON.stringify({stage:'collected',cid,...value}))});
   // 검증·재개에 필요한 공개 카드 메타데이터만 저장한다. HTML/이미지는 보관하지 않는다.
   await journal.snapshot(cid,snapshot);
   const result=await store(snapshot);
   state.cards[cid]={...state.cards[cid],status:'stored',notListed:snapshot.notListed||[],result};failures=0;
   log(JSON.stringify({stage:'stored',...result}));
  }catch(error){const code=safeCode(error);state.cards[cid]={...state.cards[cid],status:'failed',code};failures++;
   log(JSON.stringify({stage:'failed',cid,code}));
   if(['OFFICIAL_RATE_OR_ACCESS_DENIED','CRAWL_REQUEST_LIMIT'].includes(code)||failures>=3){state.status='paused';await save();return state;}
  }
  await save();
 }
 state.status=!cids.every(cid=>state.cards[cid]?.status==='stored')?'incomplete':Object.values(state.cards).some(c=>c.result?.pendingReleases?.length)?'complete_with_pending':'complete';await save();return state;
}
async function main(){
 const id=process.argv[2],cids=targets(process.argv[3]);
 if(!process.env.DATABASE_URL||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks')throw Error('BATCH_CONFIGURATION_REQUIRED');
 const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000});
 const lock=await pool.connect();let locked=false;
 try{
  const role=(await lock.query('select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  locked=(await lock.query('select pg_try_advisory_lock(941052,1) as locked')).rows[0].locked;if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');
  const bucket=new(require('@google-cloud/storage').Storage)().bucket(process.env.CRAWL_STATE_BUCKET),prefix='system/catalog-crawl/'+id+'/';
  const file=bucket.file(prefix+'state.json');let generation=0;
  const journal={async read(){try{const [b]=await file.download(),[m]=await file.getMetadata();generation=m.generation;return JSON.parse(b);}catch(e){if(e.code===404)return null;throw e;}},
   async save(value){await file.save(JSON.stringify(value),{resumable:false,contentType:'application/json',preconditionOpts:{ifGenerationMatch:generation}});const [m]=await file.getMetadata();generation=m.generation;},
   async snapshot(cid,value){await bucket.file(prefix+cid+'.json').save(JSON.stringify(value),{resumable:false,contentType:'application/json'});}};
  const state=await runBatch({id,cids,journal,store:s=>writeSnapshot(pool,s),retryFailed:process.env.CRAWL_RETRY_FAILED==='true'});
  console.log(JSON.stringify({stage:'batch',id,status:state.status,stored:cids.filter(cid=>state.cards[cid]?.status==='stored').length,total:cids.length}));
  if(!['complete','complete_with_pending'].includes(state.status))process.exitCode=1;
 }finally{if(locked)await lock.query('select pg_advisory_unlock(941052,1)');lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'batch-failed',code:safeCode(e)}));process.exitCode=1;});
module.exports={runBatch,targets};
