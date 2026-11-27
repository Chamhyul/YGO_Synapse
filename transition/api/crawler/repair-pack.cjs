'use strict';
const {parsePackPage}=require('./pack-parser.cjs'),{packTargets,finishPack}=require('./packs.cjs');
const {createLimiter,requestHtml}=require('./fetch.cjs'),{parseCard,locales}=require('./parser.cjs'),{writeSnapshot}=require('./writer.cjs');
const safe=e=>/^[A-Z0-9_]+$/.test(e.message)?e.message:'PACK_REPAIR_FAILED';
const {pendingCids}=require('./release.cjs');
function repairTarget(full,review,catalog,target){
 const index=catalog.findIndex(p=>p.pid===target.pid&&p.locale===target.locale),localeIndex=locales.indexOf(target.locale);
 if(index<0||localeIndex<0||!['running','complete','complete_with_issues','complete_with_pending'].includes(full?.status))throw Error('REPAIR_SOURCE_RUN_NOT_READY');
 if(!['review','incomplete','pending_release'].includes(review?.status)||review.pid!==target.pid||review.locale!==target.locale)throw Error('REPAIR_REQUIRES_REVIEWED_PACK');
 if(full.localeIndex<localeIndex||full.localeIndex===localeIndex&&full.packIndex<=index)throw Error('REPAIR_PACK_NOT_PASSED');
 return catalog[index];
}
async function runRepair({id,pack,journal,guard,fetchHtml,collectCard,store,link,finish,log=console.log}){
 let state=await journal.read('state');
 if(state&&(state.id!==id||state.pid!==pack.pid||state.locale!==pack.locale))throw Error('REPAIR_TARGET_MISMATCH');
 if(['complete','complete_with_pending'].includes(state?.status))return state;
 state||={version:1,id,pid:pack.pid,locale:pack.locale,name:pack.name,cards:{},createdAt:new Date().toISOString()};
 const save=async()=>{state.updatedAt=new Date().toISOString();await journal.write('state',state);};
 state.status='running';delete state.error;await save();
 try{
  await guard();
  const snapshot=parsePackPage(await fetchHtml('https://www.db.yugioh-card.com/yugiohdb/card_search.action?'+new URLSearchParams({ope:'1',pid:pack.pid,rp:'99999',sort:'1',request_locale:pack.locale})),pack);
  if(snapshot.cids.length>100)throw Error('PACK_REPAIR_CARD_LIMIT');
  await journal.write('pack',snapshot);state.expected=snapshot.cids.length;state.warnings=snapshot.warnings||[];
  for(const warning of state.warnings)log(JSON.stringify({stage:'repair-pack-warning',pid:pack.pid,locale:pack.locale,...warning}));
  for(const cid of snapshot.cids){
   if(state.cards[cid]?.status==='stored')continue;
   await guard();const value=await collectCard(cid,pack.locale),page=value.pages?.[0];await guard();
   if(value.cid!==cid||value.pages.length!==1||page.locale!==pack.locale||![...page.rows,...(page.pendingRows||[])].some(r=>r.pid===pack.pid))throw Error('REPAIR_CARD_PACK_MISMATCH');
   // 목록의 정식 명칭을 유지하고 잘못된 상세 제목을 저장하지 않는다.
   for(const row of [...page.rows,...(page.pendingRows||[])])if(row.pid===pack.pid)row.packName=pack.name;
   const stored=await store(value),images=await link(cid,pack.locale);
   state.cards[cid]={status:'stored',name:page.localized.name,variants:stored.storedVariants,verified:stored.verified,missingImages:images.missing,linked:images.linked,pendingReleases:stored.pendingReleases||[]};await save();
   log(JSON.stringify({stage:'repair-card-stored',cid,locale:pack.locale,...state.cards[cid]}));
  }
  await guard();const pending=pendingCids(state.cards,pack.pid,pack.locale);state.result={...await finish({...snapshot,pendingCids:pending}),pending};
  state.status=state.result.missing.length||state.result.extra.length?'incomplete':pending.length?'complete_with_pending':'complete';
 }catch(e){state.error=safe(e);state.status='paused';log(JSON.stringify({stage:'repair-paused',code:state.error}));}
 await save();return state;
}
async function main(){
 const [id,sourceId,targetText]=process.argv.slice(2),targets=packTargets(targetText);
 if(!/^repair-[a-z0-9-]{1,60}$/.test(id||'')||!/^full-[a-z0-9-]{1,60}$/.test(sourceId||'')||targets.length!==1
  ||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks'||!process.env.DATABASE_URL)throw Error('PACK_REPAIR_CONFIGURATION_REQUIRED');
 const {Pool}=require('pg'),{Storage}=require('@google-cloud/storage'),crypto=require('node:crypto');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000}),lock=await pool.connect();let locked=false,lockLost=false;
 pool.on('error',()=>{});lock.on('error',()=>{lockLost=true;});
 try{
  const role=(await lock.query('select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  // 복구 전용 단일 실행 잠금. 전체 수집의 잠금·상태는 건드리지 않고 writer의 CID별 잠금으로 저장을 직렬화한다.
  locked=(await lock.query('select pg_try_advisory_lock(941053,1) locked')).rows[0].locked;if(!locked)throw Error('PACK_REPAIR_ALREADY_RUNNING');
  const bucket=new Storage().bucket(process.env.CRAWL_STATE_BUCKET),sourcePrefix='system/catalog-crawl/'+sourceId+'/',prefix='system/catalog-crawl/'+id+'/';
  const read=async key=>{try{return JSON.parse((await bucket.file(key+'.json').download())[0]);}catch(e){if(e.code===404)return null;throw e;}};
  const target=targets[0],full=await read(sourcePrefix+'state'),review=await read(sourcePrefix+'pack-results/'+target.locale+'/'+target.pid),catalog=await read(sourcePrefix+'catalogs/'+target.locale);
  const pack=repairTarget(full,review,catalog||[],target);
  const journal={read:key=>read(prefix+key),write:async(key,value)=>{if(!['state','pack'].includes(key))throw Error('INVALID_REPAIR_CHECKPOINT');await bucket.file(prefix+key+'.json').save(JSON.stringify(value),{resumable:false,contentType:'application/json'});}};
  const [files]=await bucket.getFiles({prefix:'private/illustrations/'}),names=new Set(files.map(f=>f.name)),available=new Map();
  for(const f of files){const m=/^private\/illustrations\/(\d+)_(\d+)\.webp$/.exec(f.name);if(m){const list=available.get(Number(m[1]))||[];list.push(Number(m[2]));available.set(Number(m[1]),list);}}
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(files.map(f=>[f.name,f.metadata.generation,f.metadata.size]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
  const baseline=await read(sourcePrefix+'image-baseline');if(!baseline||baseline.hash!==fingerprint)throw Error('IMAGE_INVENTORY_CHANGED');
  const guard=async()=>{if(lockLost)throw Error('CRAWLER_LOCK_LOST');const s=await read(sourcePrefix+'state');if(!s||s.status==='paused')throw Error('REPAIR_SOURCE_RUN_PAUSED');};
  const limiter=createLimiter({maxRequests:110,initialDelay:true}),html=url=>requestHtml(url,{limiter});
  const state=await runRepair({id,pack,journal,guard,fetchHtml:html,
   collectCard:async(cid,locale)=>({cid,pages:[parseCard(await html('https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid='+cid+'&request_locale='+locale),cid,locale)]}),
   store:s=>writeSnapshot(pool,s,{verify:true}),
   async link(cid,locale){const r=await pool.query('select * from catalog.link_existing_images($1,$2::integer[])',[cid,available.get(cid)||[]]);
    const sources=(await pool.query('select official_ciid,image_ciid,image_variant from catalog.artwork_sources where cid=$1 and locale=$2',[cid,locale])).rows;
    return {linked:r.rowCount,missing:sources.filter(s=>!s.image_ciid||!names.has('private/illustrations/'+cid+'_'+s.image_ciid+(s.image_variant==='jp'?'_jp':'')+'.webp')).map(s=>s.official_ciid)};},
   finish:p=>finishPack(pool,p)});
  console.log(JSON.stringify({stage:'repair-result',id,sourceId,status:state.status,error:state.error,pid:pack.pid,locale:pack.locale,name:pack.name,cards:Object.keys(state.cards).length,result:state.result,warnings:state.warnings,requests:limiter.requests,imageFiles:files.length,imageHash:fingerprint}));
  if(!['complete','complete_with_pending'].includes(state.status))process.exitCode=1;
 }finally{if(locked&&!lockLost)await lock.query('select pg_advisory_unlock(941053,1)').catch(()=>{});lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'repair-fatal',code:safe(e)}));process.exitCode=1;});
module.exports={repairTarget,runRepair};
