'use strict';
const crypto=require('node:crypto');
const {collect,createLimiter}=require('./fetch.cjs'),{writeSnapshot}=require('./writer.cjs'),{shouldPause}=require('./full.cjs');
const errorCode=e=>/^[A-Z0-9_]+$/.test(e.message)?e.message:e.code==='53100'?'DATABASE_STORAGE_LIMIT':e.code==='25006'?'DATABASE_READ_ONLY':['57P01','57P02','57P03','53300','53400','ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT'].includes(e.code)?'DATABASE_UNAVAILABLE':'RETRY_CARD_FAILED';
function approvedTargets(records,{count,sha256}){
 const targets=records.map(r=>({cid:Number(r.cid),code:r.code,locale:r.locale})).sort((a,b)=>a.locale.localeCompare(b.locale)||a.cid-b.cid);
 if(!Number.isInteger(count)||count<1||count>200||targets.length!==count||new Set(targets.map(t=>t.cid+':'+t.locale)).size!==count
  ||targets.some(t=>!Number.isSafeInteger(t.cid)||t.cid<1||t.cid>999999999||!['es','pt'].includes(t.locale)||t.code!=='OFFICIAL_VARIANT_INCOMPLETE'))throw Error('RETRY_TARGETS_INVALID');
 const hash=crypto.createHash('sha256').update(JSON.stringify(targets)).digest('hex');
 if(hash!==sha256)throw Error('RETRY_TARGET_HASH_MISMATCH');
 return {targets,sha256:hash};
}
function retryCounts(cards){const values=Object.values(cards),stored=values.filter(c=>c.status==='stored');
 return {stored:stored.length,failed:values.filter(c=>c.status==='failed').length,pendingCards:stored.filter(c=>c.result.pendingReleases?.length).length,pendingRows:stored.reduce((n,c)=>n+(c.result.pendingReleases?.length||0),0)};
}
async function runRetryErrors({id,sourceId,approved,journal,collectCard=collect,store,guard=async()=>{},log=console.log,limiter=createLimiter({maxRequests:approved.targets.length,initialDelay:true})}){
 if(!/^retry-[a-z0-9-]{1,60}$/.test(id)||!/^full-[a-z0-9-]{1,60}$/.test(sourceId))throw Error('RETRY_RUN_ID_INVALID');
 let state=await journal.read('state');
 if(state&&(state.id!==id||state.sourceId!==sourceId||state.targetSha256!==approved.sha256))throw Error('RETRY_RUN_MISMATCH');
 if(state&&['complete','complete_with_pending','incomplete','paused'].includes(state.status))return state;
 state||={version:1,id,sourceId,targetSha256:approved.sha256,total:approved.targets.length,status:'running',cards:{},createdAt:new Date().toISOString()};
 const save=async()=>{state.counts=retryCounts(state.cards);state.updatedAt=new Date().toISOString();await journal.write('state',state);};
 await journal.write('targets',{sourceId,...approved},{once:true});await save();let failures=0;
 for(const {cid,locale} of approved.targets){
  const key=cid+'_'+locale;if(state.cards[key]?.status==='stored')continue;
  const receiptKey='cards/'+locale+'/'+cid+'.ok',receipt=await journal.read(receiptKey);
  if(receipt){if(receipt.cid!==cid||receipt.locale!==locale)throw Error('RETRY_RECEIPT_MISMATCH');state.cards[key]=receipt;await save();continue;}
  try{
   await guard();const snapshot=await collectCard(cid,{languages:[locale],limiter});
   if(snapshot.cid!==cid||snapshot.pages.length!==1||snapshot.pages[0].locale!==locale)throw Error('RETRY_CARD_IDENTITY_MISMATCH');
   await guard();const result=await store(snapshot);if(result.verified!==true)throw Error('RETRY_STORED_VERIFICATION_REQUIRED');
   const entry={status:'stored',cid,locale,result};
   await journal.write(receiptKey,entry,{once:true,metadata:{rows:String(result.storedVariants??result.sourceRows),pendingRows:String(result.pendingReleases?.length||0)}});
   state.cards[key]=entry;failures=0;
   log(JSON.stringify({stage:'retry-card-stored',cid,locale,rows:result.storedVariants,pendingRows:result.pendingReleases?.length||0}));
  }catch(e){const code=errorCode(e);
   if(shouldPause(code)||code==='CRAWL_REQUEST_LIMIT'){
    state.status='paused';state.reason=code;await save();log(JSON.stringify({stage:'retry-paused',code,counts:state.counts}));return state;
   }
   state.cards[key]={status:'failed',cid,locale,code};failures++;
   await journal.write('cards/'+locale+'/'+cid+'.error',state.cards[key],{once:true});log(JSON.stringify({stage:'retry-card-failed',cid,locale,code}));
   if(failures>=3){state.status='paused';state.reason='REPEATED_RETRY_ERRORS';await save();return state;}
  }
  await save();
 }
 state.counts=retryCounts(state.cards);state.status=state.counts.failed?'incomplete':state.counts.pendingCards?'complete_with_pending':'complete';state.finishedAt=new Date().toISOString();await save();return state;
}
async function main(){
 const [id,sourceId]=process.argv.slice(2),count=Number(process.env.RETRY_EXPECTED_ERRORS),sha256=process.env.RETRY_TARGET_SHA256;
 if(!/^retry-[a-z0-9-]{1,60}$/.test(id||'')||!/^full-[a-z0-9-]{1,60}$/.test(sourceId||'')||!/^\w{64}$/.test(sha256||'')
  ||!process.env.DATABASE_URL||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks')throw Error('RETRY_CONFIGURATION_REQUIRED');
 const {Storage}=require('@google-cloud/storage'),{Pool}=require('pg'),bucket=new Storage().bucket(process.env.CRAWL_STATE_BUCKET);
 const sourcePrefix='system/catalog-crawl/'+sourceId+'/',prefix='system/catalog-crawl/'+id+'/';
 const source=JSON.parse((await bucket.file(sourcePrefix+'state.json').download())[0]);
 if(!['complete','complete_with_issues','complete_with_pending'].includes(source.status))throw Error('RETRY_SOURCE_NOT_FINISHED');
 const files=[];for(const locale of ['es','pt']){
  const part=sourcePrefix+'cards/'+locale+'/';const [found]=await bucket.getFiles({prefix:part,matchGlob:part+'*.error.json'});files.push(...found);
 }
 const records=[];
 for(let n=0;n<files.length;n+=8)records.push(...await Promise.all(files.slice(n,n+8).map(async file=>{
  const r=JSON.parse((await file.download())[0]);
  if(file.name!==sourcePrefix+'cards/'+r.locale+'/'+r.cid+'.error.json')throw Error('RETRY_SOURCE_RECEIPT_MISMATCH');
  if((await bucket.file(sourcePrefix+'cards/'+r.locale+'/'+r.cid+'.ok.json').exists())[0])throw Error('RETRY_SOURCE_CARD_ALREADY_STORED');
  return r;
 })));
 const approved=approvedTargets(records,{count,sha256});
 console.log(JSON.stringify({stage:'retry-preflight',id,sourceId,total:approved.targets.length,sha256:approved.sha256,locales:approved.targets.reduce((m,t)=>(m[t.locale]=(m[t.locale]||0)+1,m),{})}));
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000});
 pool.on('error',()=>{});const lock=await pool.connect();let locked=false,lockLost=false;lock.on('error',()=>{lockLost=true;});
 try{
  const role=(await lock.query('select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  locked=(await lock.query('select pg_try_advisory_lock(941052,1) locked')).rows[0].locked;if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');
  const journal=require('./checkpoints.cjs').createJournal({bucket,prefix});
  const state=await runRetryErrors({id,sourceId,approved,journal,guard:async()=>{if(lockLost)throw Error('CRAWLER_LOCK_LOST');},store:s=>writeSnapshot(pool,s,{verify:true})});
  console.log(JSON.stringify({stage:'retry-finished',id,sourceId,status:state.status,counts:state.counts,total:state.total,reason:state.reason}));
  if(!['complete','complete_with_pending'].includes(state.status))process.exitCode=1;
 }finally{if(locked&&!lockLost)await lock.query('select pg_advisory_unlock(941052,1)').catch(()=>{});lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'retry-fatal',code:errorCode(e)}));process.exitCode=1;});
module.exports={approvedTargets,runRetryErrors,retryCounts};
