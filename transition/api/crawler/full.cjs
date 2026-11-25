'use strict';
const {collect,createLimiter,requestHtml}=require('./fetch.cjs'),{parseCatalog,parsePackPage}=require('./pack-parser.cjs');
const {locales}=require('./parser.cjs'),{writeSnapshot}=require('./writer.cjs'),{finishPack}=require('./packs.cjs');
const TERMINAL=['paused','complete','complete_with_issues','complete_with_pending'];
const BLOCKED=new Set(['OFFICIAL_RATE_OR_ACCESS_DENIED']);
const TRANSIENT=new Set(['OFFICIAL_HTTP_500','OFFICIAL_HTTP_502','OFFICIAL_HTTP_503','OFFICIAL_HTTP_504','OFFICIAL_NETWORK_ERROR','OFFICIAL_REQUEST_TIMEOUT']);
const code=e=>/^[A-Z0-9_]+$/.test(e.message)?e.message:(e.name==='TimeoutError'||e.name==='AbortError'?'OFFICIAL_REQUEST_TIMEOUT':e.message==='fetch failed'?'OFFICIAL_NETWORK_ERROR':e.code==='53100'?'DATABASE_STORAGE_LIMIT':e.code==='25006'?'DATABASE_READ_ONLY':['57P01','57P02','57P03','53300','53400','ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT'].includes(e.code)?'DATABASE_UNAVAILABLE':'FULL_CRAWL_FAILED');
function shouldPause(error){return BLOCKED.has(error)||error.startsWith('CHECKPOINT_')||['REPEATED_CRAWLER_OR_NETWORK_ERRORS','REPEATED_PACK_PARSING_ERRORS','USER_STOP_REQUESTED','DATABASE_STORAGE_LIMIT','DATABASE_READ_ONLY','DATABASE_UNAVAILABLE','CRAWLER_LOCK_LOST','CRAWLER_ROLE_DENIED','IMAGE_INVENTORY_CHANGED'].includes(error);}
function initialState(id){return {version:1,id,status:'running',phase:'catalogs',localeIndex:0,packIndex:0,catalogCounts:{},counts:{},createdAt:new Date().toISOString()};}
function receiptCounts(files){const ok=new Map(),failed=new Set();for(const f of files){const m=/\/(\d+)\.(ok|error)\.json$/.exec(f.name);if(!m)continue;if(m[2]==='ok')ok.set(Number(m[1]),f.metadata?.metadata||{});else failed.add(Number(m[1]));}for(const cid of ok.keys())failed.delete(cid);
 return {ok,failed,summary:{cards:ok.size,cardErrors:failed.size,missingImages:[...ok.values()].reduce((n,m)=>n+Number(m.missing||0),0),variants:[...ok.values()].reduce((n,m)=>n+Number(m.rows||0),0),pendingCards:[...ok.values()].filter(m=>Number(m.pendingRows)>0).length,pendingRows:[...ok.values()].reduce((n,m)=>n+Number(m.pendingRows||0),0)}};}
function errorDetails(e){return {code:code(e),name:e.name||'Error',...(e.code?{sourceCode:String(e.code)}:{}),...(e.details||{})};}
async function runFull({id,journal,fetchHtml,collectCard,store,link,finish,loadReceipts,now=Date.now,workMs=13500000,discoveryOnly=false,log=console.log}){
 let state=await journal.read('state');state ||=initialState(id);
 if(state.id!==id||state.version!==1)throw Error('FULL_RUN_MISMATCH');
 if(TERMINAL.includes(state.status))return state;
 const began=now();let lastSave=-Infinity;
 const save=async(force=false)=>{if(!force&&now()-lastSave<5000)return;state.updatedAt=new Date().toISOString();await journal.write('state',state);lastSave=now();};
 const room=()=>now()-began<workMs;
 const pause=async e=>{state.status='paused';state.reason=code(e);state.error=errorDetails(e);await save(true);log(JSON.stringify({stage:'full-paused',reason:state.reason,error:state.error}));return state;};
 const receiptsByLocale=new Map();
 const receiptsFor=async locale=>{if(!receiptsByLocale.has(locale)){
  const receipts=await loadReceipts(locale);receiptsByLocale.set(locale,receipts);
  state.counts[locale]={packs:state.counts[locale]?.packs||0,packIssues:state.counts[locale]?.packIssues||0,pendingPacks:state.counts[locale]?.pendingPacks||0,...receipts.summary};
 }return receiptsByLocale.get(locale);};
 const checkRepeated=result=>{state.packFailureStreak=['complete','pending_release'].includes(result.status)||result.code==='OFFICIAL_PACK_EMPTY_REVIEW_REQUIRED'?0:(state.packFailureStreak||0)+1;
  if(state.packFailureStreak>=5)throw Error('REPEATED_PACK_PARSING_ERRORS');};
 async function processPack(pack,receipts,recheckId){
  const locale=pack.locale,pkey=locale+'/'+pack.pid;
  const resultKey=recheckId?'pack-rechecks/'+recheckId+'/'+pkey:'pack-results/'+pkey;
  const snapshotKey=recheckId?'rechecked-packs/'+recheckId+'/'+pkey:'packs/'+pkey;
  const old=await journal.read(resultKey);if(old)return old;
  let result;
  try{
   let snapshot=await journal.read(snapshotKey);
   if(!snapshot){snapshot=parsePackPage(await fetchHtml('https://www.db.yugioh-card.com/yugiohdb/card_search.action?'+new URLSearchParams({ope:'1',pid:pack.pid,rp:'99999',sort:'1',request_locale:locale})),pack);await journal.write(snapshotKey,snapshot,{once:true});}
   for(const warning of snapshot.warnings||[])log(JSON.stringify({stage:'full-pack-warning',pid:pack.pid,locale,...warning}));
   for(const cid of snapshot.cids){
    if(!room())return null;
    if(receipts.ok.has(cid)||receipts.failed.has(cid))continue;
    let lastError=null;
    try{
     const value=await collectCard(cid,locale),saved=await store(value),images=await link(cid,locale);
     const pendingReleases=saved.pendingReleases||[];
     const receipt={cid,locale,name:value.pages[0].localized.name,rows:saved.storedVariants??saved.sourceRows,sources:saved.officialSources,verified:saved.verified,missing:images.missing,linked:images.linked,pendingReleases,at:new Date().toISOString()};
     const metadata={rows:String(receipt.rows),missing:String(receipt.missing.length),pendingRows:String(pendingReleases.length),pendingPids:JSON.stringify([...new Set(pendingReleases.map(r=>r.pid))])};
     await journal.write('cards/'+locale+'/'+cid+'.ok',receipt,{once:true,metadata});
     receipts.ok.set(cid,metadata);state.counts[locale].cards=receipts.ok.size;
     state.counts[locale].pendingCards+=pendingReleases.length?1:0;state.counts[locale].pendingRows+=pendingReleases.length;
     if(pendingReleases.length)log(JSON.stringify({stage:'full-card-pending-release',cid,locale,rows:pendingReleases.length,pids:JSON.parse(metadata.pendingPids)}));
     state.counts[locale].variants+=receipt.rows;state.counts[locale].missingImages+=receipt.missing.length;
     if(receipt.missing.length)log(JSON.stringify({stage:'full-missing-images',cid,locale,ciids:receipt.missing}));
     if(receipts.ok.size<=3||receipts.ok.size%25===0){await save();log(JSON.stringify({stage:'full-progress',locale,counts:state.counts[locale],currentPack:state.currentPack}));}
    }catch(e){lastError=code(e);if(lastError==='CRAWL_REQUEST_LIMIT'||shouldPause(lastError))throw e;
     await journal.write('cards/'+locale+'/'+cid+'.error',{cid,locale,code:lastError,error:errorDetails(e),at:new Date().toISOString()},{once:true});
     receipts.failed.add(cid);state.counts[locale].cardErrors=receipts.failed.size;
     log(JSON.stringify({stage:'full-card-error',cid,locale,code:lastError,error:errorDetails(e)}));
    }
    if(lastError&&(TRANSIENT.has(lastError)||lastError==='FULL_CRAWL_FAILED')){state.transportErrors=(state.transportErrors||0)+1;if(state.transportErrors>=3)throw Error('REPEATED_CRAWLER_OR_NETWORK_ERRORS');}else state.transportErrors=0;
   }
   const pending=snapshot.cids.filter(cid=>JSON.parse(receipts.ok.get(cid)?.pendingPids||'[]').includes(pack.pid));
   const missingCards=snapshot.cids.filter(cid=>!receipts.ok.has(cid)),checked=missingCards.length?null:await finish({...snapshot,pendingCids:pending});
   result={...pack,expected:snapshot.cids.length,status:checked&&!checked.missing.length&&!checked.extra.length?(pending.length?'pending_release':'complete'):'incomplete',failed:missingCards,...(checked||{}),pending,at:new Date().toISOString()};
  }catch(e){const reason=code(e);if(reason==='CRAWL_REQUEST_LIMIT'||shouldPause(reason))throw e;
   result={...pack,status:'review',code:reason,error:errorDetails(e),at:new Date().toISOString()};log(JSON.stringify({stage:'full-pack-error',...result}));
  }
  await journal.write(resultKey,result,{once:true});return result;
 }
 state.status='running';await save(true);
 try{
  for(const locale of locales){if(state.catalogCounts[locale]!=null)continue;if(!room())return state;
   const packs=parseCatalog(await fetchHtml('https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale='+locale),locale);
   await journal.write('catalogs/'+locale,packs,{once:true});state.catalogCounts[locale]=packs.length;await save();
   log(JSON.stringify({stage:'full-catalog',locale,packs:packs.length}));}
  if(discoveryOnly){state.phase='packs';await save(true);return state;}
  if(state.recovery&&state.recovery.index<state.recovery.total){
   state.phase='recheck';const recovery=state.recovery,locale=recovery.locale,catalog=await journal.read('catalogs/'+locale),receipts=await receiptsFor(locale);
   while(recovery.index<recovery.total&&room()){
    const control=await journal.read('control');if(control?.stop)throw Error('USER_STOP_REQUESTED');
    const pack=catalog.find(p=>p.pid===recovery.pids[recovery.index]);if(!pack)throw Error('RECHECK_PACK_NOT_IN_CATALOG');
    state.currentPack={...pack,index:recovery.index+1,total:recovery.total,recheck:true};await save();
    const result=await processPack(pack,receipts,recovery.id);if(!result){await save(true);return state;}
    if(result.status==='complete'){recovery.resolved++;state.counts[locale].packIssues=Math.max(0,state.counts[locale].packIssues-1);}
    else if(result.status==='pending_release'){recovery.pendingPacks=(recovery.pendingPacks||0)+1;state.counts[locale].pendingPacks++;state.counts[locale].packIssues=Math.max(0,state.counts[locale].packIssues-1);}
    else recovery.remainingIssues++;
    recovery.index++;checkRepeated(result);await save();
    log(JSON.stringify({stage:'full-pack-rechecked',pid:pack.pid,locale,status:result.status,index:recovery.index,total:recovery.total,resolved:recovery.resolved,remainingIssues:recovery.remainingIssues}));
   }
   if(recovery.index<recovery.total){await save(true);return state;}
   recovery.finishedAt=new Date().toISOString();log(JSON.stringify({stage:'full-recheck-finished',locale,total:recovery.total,resolved:recovery.resolved,remainingIssues:recovery.remainingIssues}));
  }
  state.phase='packs';await save();
  while(state.localeIndex<locales.length&&room()){
   const locale=locales[state.localeIndex],packs=await journal.read('catalogs/'+locale),receipts=await receiptsFor(locale);
   while(state.packIndex<packs.length&&room()){
    const control=await journal.read('control');if(control?.stop)throw Error('USER_STOP_REQUESTED');
    const pack=packs[state.packIndex];state.currentPack={...pack,index:state.packIndex+1,total:packs.length};await save();
    const result=await processPack(pack,receipts);if(!result){await save(true);return state;}
    state.counts[locale].packs++;if(result.status==='pending_release')state.counts[locale].pendingPacks++;else if(result.status!=='complete')state.counts[locale].packIssues++;
    state.packIndex++;checkRepeated(result);await save();log(JSON.stringify({stage:'full-pack-finished',pid:pack.pid,locale,status:result.status,index:state.packIndex,total:packs.length}));
   }
   if(state.packIndex===packs.length){state.localeIndex++;state.packIndex=0;await save();}else break;
  }
  if(state.localeIndex===locales.length){state.phase='finished';delete state.currentPack;state.status=Object.values(state.counts).some(s=>s.cardErrors||s.packIssues||s.missingImages)?'complete_with_issues':Object.values(state.counts).some(s=>s.pendingCards)?'complete_with_pending':'complete';state.finishedAt=new Date().toISOString();}
 }catch(e){if(code(e)==='CRAWL_REQUEST_LIMIT'){await save(true);return state;}return pause(e);}
 await save(true);return state;
}
async function main(){
 const id=process.argv[2];if(!/^full-[a-z0-9-]{1,70}$/.test(id||'')||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks'||!process.env.DATABASE_URL)throw Error('FULL_CONFIGURATION_REQUIRED');
 const {Pool}=require('pg'),{Storage}=require('@google-cloud/storage'),crypto=require('node:crypto');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000});pool.on('error',()=>{});const lock=await pool.connect();let locked=false,lockLost=false;lock.on('error',()=>{lockLost=true;});
 try{const role=(await lock.query('select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  locked=(await lock.query('select pg_try_advisory_lock(941052,1) locked')).rows[0].locked;if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');
  const bucket=new Storage().bucket(process.env.CRAWL_STATE_BUCKET),prefix='system/catalog-crawl/'+id+'/';
  const journal=require('./checkpoints.cjs').createJournal({bucket,prefix});
  const previous=await journal.read('state'),freshResume=process.env.FULL_RESUME_ID&&previous?.resumeId!==process.env.FULL_RESUME_ID;
  if(previous&&TERMINAL.includes(previous.status)&&!freshResume){console.log(JSON.stringify({stage:'full-task',id,status:previous.status,phase:previous.phase,counts:previous.counts}));return;}
  if(process.env.FULL_DISCOVERY_ONLY!=='true'&&!(await lock.query("select to_regprocedure('catalog.link_existing_images(integer,integer[])') f")).rows[0].f)throw Error('IMAGE_LINK_FUNCTION_UNAVAILABLE');
  const [imageFiles]=await bucket.getFiles({prefix:'private/illustrations/'}),imageNames=new Set(imageFiles.map(f=>f.name)),available=new Map();
  for(const f of imageFiles){const m=/^private\/illustrations\/(\d+)_(\d+)\.webp$/.exec(f.name);if(m){const cid=Number(m[1]),list=available.get(cid)||[];list.push(Number(m[2]));available.set(cid,list);}}
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(imageFiles.map(f=>[f.name,f.metadata.generation,f.metadata.size]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
  const baseline=await journal.read('image-baseline');if(baseline&&baseline.hash!==fingerprint)throw Error('IMAGE_INVENTORY_CHANGED');
  if(!baseline)await journal.write('image-baseline',{hash:fingerprint,files:imageFiles.length,bytes:imageFiles.reduce((n,f)=>n+Number(f.metadata.size),0),at:new Date().toISOString()},{once:true});
  if(freshResume){await require('./resume.cjs').prepareResume({id:process.env.FULL_RESUME_ID,locale:process.env.FULL_RECHECK_LOCALE,journal,
   async loadResults(locale){const [files]=await bucket.getFiles({prefix:prefix+'pack-results/'+locale+'/'}),results=[];
    for(let i=0;i<files.length;i+=8){const group=await Promise.all(files.slice(i,i+8).map(f=>journal.read(f.name.slice(prefix.length,-5))));results.push(...group.filter(Boolean));}return results;}});}
  const limiter=createLimiter({maxRequests:10000,initialDelay:true});
  // 요청 수 제한에 도달하면 같은 작업을 다음 순차 태스크가 이어받는다.
  const html=async url=>{if(lockLost)throw Error('CRAWLER_LOCK_LOST');try{return await requestHtml(url,{limiter});}catch(e){const c=code(e);if(c==='CRAWL_REQUEST_LIMIT')throw e;if(TRANSIENT.has(c)){await new Promise(r=>setTimeout(r,30000));if(lockLost)throw Error('CRAWLER_LOCK_LOST');return requestHtml(url,{limiter});}throw e;}};
  const state=await runFull({id,journal,discoveryOnly:process.env.FULL_DISCOVERY_ONLY==='true',workMs:Number(process.env.FULL_WORK_MS||13500000),fetchHtml:html,
   collectCard:async(cid,locale)=>{const body=await html('https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid='+cid+'&request_locale='+locale);return {cid,pages:[require('./parser.cjs').parseCard(body,cid,locale)]};},
   store:s=>writeSnapshot(pool,s,{verify:true}),
   async link(cid,locale){const allowed=available.get(cid)||[];const r=await pool.query('select * from catalog.link_existing_images($1,$2::integer[])',[cid,allowed]);
    const sources=(await pool.query('select official_ciid,image_ciid,image_variant from catalog.artwork_sources where cid=$1 and locale=$2',[cid,locale])).rows;
    const missing=sources.filter(s=>!s.image_ciid||!imageNames.has('private/illustrations/'+cid+'_'+s.image_ciid+(s.image_variant==='jp'?'_jp':'')+'.webp')).map(s=>s.official_ciid);return {linked:r.rowCount,missing};},
   finish:p=>finishPack(pool,p),async loadReceipts(locale){const [files]=await bucket.getFiles({prefix:prefix+'cards/'+locale+'/'});return receiptCounts(files);}});
  const size=(await lock.query('select pg_database_size(current_database())::text bytes')).rows[0].bytes;
  console.log(JSON.stringify({stage:'full-task',id,status:state.status,phase:state.phase,catalogCounts:state.catalogCounts,counts:state.counts,dbBytes:size}));
 }finally{if(locked&&!lockLost)await lock.query('select pg_advisory_unlock(941052,1)').catch(()=>{});lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'full-fatal',code:code(e),error:errorDetails(e)}));process.exitCode=1;});
module.exports={runFull,receiptCounts,shouldPause,initialState};
