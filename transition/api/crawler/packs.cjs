'use strict';
const {collect,createLimiter,requestHtml}=require('./fetch.cjs'),{parseCatalog,parsePackPage}=require('./pack-parser.cjs'),{writeSnapshot}=require('./writer.cjs');
const safe=e=>/^[A-Z0-9_]+$/.test(e.message)?e.message:'PACK_CRAWL_FAILED';
const {pendingCids}=require('./release.cjs');
function packTargets(text){const targets=String(text||'').split(':').map(value=>{const m=/^(\d{1,20})_(ko|ja|ae|cn|en|de|fr|it|es|pt)$/.exec(value);if(!m)throw Error('INVALID_PACK_TARGETS');return {pid:m[1],locale:m[2]};});
 if(targets.length>10||new Set(targets.map(p=>p.pid+'_'+p.locale)).size!==targets.length)throw Error('INVALID_PACK_TARGETS');return targets;}
async function runPacks({id,targets,journal,collectCard=collect,store,finish,fetchHtml,log=console.log,retryFailed=false,limiter=createLimiter({maxRequests:500,initialDelay:true})}){
 if(!/^[a-z0-9-]{1,80}$/.test(id))throw Error('INVALID_BATCH_ID');
 let state=await journal.read();if(state&&(state.id!==id||state.version!==1||JSON.stringify(state.targets)!==JSON.stringify(targets)))throw Error('PACK_BATCH_TARGET_MISMATCH');
 state ||= {version:1,id,targets,status:'running',createdAt:new Date().toISOString(),catalogs:{},packs:{},cards:{}};
 const save=async()=>{state.updatedAt=new Date().toISOString();await journal.save(state);};
 const get=fetchHtml||((url)=>requestHtml(url,{limiter}));
 state.status='running';delete state.error;await save();
 try{
  for(const locale of [...new Set(targets.map(p=>p.locale))])if(!state.catalogs[locale]){
   const entries=parseCatalog(await get('https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale='+locale),locale);
   const chosen=targets.filter(p=>p.locale===locale).map(t=>{const p=entries.find(p=>p.pid===t.pid);if(!p)throw Error('PACK_NOT_IN_OFFICIAL_CATALOG');return p;});
   state.catalogs[locale]={scanned:entries.length,chosen};await save();
  }
  for(const target of targets){const key=target.pid+'_'+target.locale;
   if(state.packs[key]?.snapshot)continue;
   const pack=state.catalogs[target.locale].chosen.find(p=>p.pid===target.pid);
   const url='https://www.db.yugioh-card.com/yugiohdb/card_search.action?'+new URLSearchParams({ope:'1',pid:pack.pid,rp:'99999',sort:'1',request_locale:pack.locale});
   const snapshot=parsePackPage(await get(url),pack);await journal.snapshot('pack-'+key,snapshot);state.packs[key]={status:'discovered',snapshot};await save();
   for(const warning of snapshot.warnings||[])log(JSON.stringify({stage:'pack-warning',pid:pack.pid,locale:pack.locale,...warning}));
   log(JSON.stringify({stage:'pack-discovered',pid:pack.pid,locale:pack.locale,name:pack.name,cards:snapshot.cids.length}));
  }
  const work=new Map();for(const p of Object.values(state.packs))for(const cid of p.snapshot.cids){const key=cid+'_'+p.snapshot.locale;work.set(key,{cid,locale:p.snapshot.locale});}
  if(work.size>100)throw Error('PACK_BATCH_CARD_LIMIT');
  let failures=0;
  for(const [key,{cid,locale}] of work){const old=state.cards[key];if(old?.status==='stored'||old?.status==='failed'&&!retryFailed)continue;
   state.cards[key]={status:'collecting',attempts:(old?.attempts||0)+1};await save();
   try{const snapshot=await collectCard(cid,{languages:[locale],limiter});
    if(snapshot.pages.length!==1||snapshot.pages[0].locale!==locale)throw Error('PACK_CARD_LOCALE_NOT_LISTED');
    // 해당 언어의 전체 수록을 저장한다. 대상 팩의 행만 넘기면 다른 팩의 조합이 비활성화된다.
    await journal.snapshot('card-'+key,snapshot);const result=await store(snapshot);state.cards[key]={...state.cards[key],status:'stored',result};failures=0;
    log(JSON.stringify({stage:'pack-card-stored',cid,locale,...result}));
   }catch(e){const code=safe(e);state.cards[key]={...state.cards[key],status:'failed',code};failures++;log(JSON.stringify({stage:'pack-card-failed',cid,locale,code}));
    if(['OFFICIAL_RATE_OR_ACCESS_DENIED','CRAWL_REQUEST_LIMIT'].includes(code)||failures>=3){state.status='paused';await save();return state;}}
   await save();
  }
  for(const p of Object.values(state.packs)){
   if(['complete','pending_release'].includes(p.status))continue;
   const failed=p.snapshot.cids.filter(cid=>state.cards[cid+'_'+p.snapshot.locale]?.status!=='stored');
   if(failed.length){p.status='incomplete';p.failed=failed;continue;}
   const pending=pendingCids(state.cards,p.snapshot.pid,p.snapshot.locale);
   delete p.failed;const result=await finish({...p.snapshot,pendingCids:pending});p.result={...result,pending};p.status=result.missing.length||result.extra.length?'incomplete':pending.length?'pending_release':'complete';
   log(JSON.stringify({stage:'pack-finished',pid:p.snapshot.pid,locale:p.snapshot.locale,status:p.status,...result}));await save();
  }
  state.status=Object.values(state.packs).some(p=>!['complete','pending_release'].includes(p.status))?'incomplete':Object.values(state.packs).some(p=>p.status==='pending_release')?'complete_with_pending':'complete';
 }catch(e){state.status=['OFFICIAL_RATE_OR_ACCESS_DENIED','CRAWL_REQUEST_LIMIT'].includes(safe(e))?'paused':'incomplete';state.error=safe(e);log(JSON.stringify({stage:'pack-batch-failed',code:state.error}));}
 await save();return state;
}
async function finishPack(pool,pack){const c=await pool.connect();try{
 await c.query('begin');
 const found=(await c.query(`select c.cid from catalog.cards c join catalog.card_localizations l on l.cid=c.cid and l.locale=$2 where c.cid=any($1::integer[]) and exists(select from catalog.card_printings p where p.cid=c.cid and p.pid=$3 and p.locale=$2 and (c.cid=any($4::integer[]) or exists(select from catalog.printing_variants v where v.printing_id=p.id and v.is_active)))`,[pack.cids,pack.locale,pack.pid,pack.pendingCids||[]])).rows.map(r=>r.cid);
 const missing=pack.cids.filter(cid=>!found.includes(cid));
 await c.query('insert into catalog.packs(pid,locale,name,reported_card_count) values($1,$2,$3,$4) on conflict(pid,locale) do update set name=excluded.name,reported_card_count=excluded.reported_card_count,updated_at=now()',[pack.pid,pack.locale,pack.name,pack.cids.length]);
 await c.query(`insert into catalog.pack_cards(pid,locale,cid,position)
 select $1,$2,cid,ordinality::integer from unnest($3::integer[]) with ordinality as list(cid,ordinality)
 where cid=any($4::integer[]) on conflict(pid,locale,cid) do update set position=excluded.position`,[pack.pid,pack.locale,pack.cids,found]);
 const extra=(await c.query('select cid from catalog.pack_cards where pid=$1 and locale=$2 and not(cid=any($3::integer[])) order by cid',[pack.pid,pack.locale,pack.cids])).rows.map(r=>r.cid);
 await c.query('commit');return {expected:pack.cids.length,stored:found.length,missing,extra,pending:(pack.pendingCids||[]).filter(cid=>found.includes(cid))};
 }catch(e){await c.query('rollback');throw e;}finally{c.release();}}
async function main(){
 const id=process.argv[2],targets=packTargets(process.argv[3]);if(!/^[a-z0-9-]{1,80}$/.test(id||'')||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks'||!process.env.DATABASE_URL)throw Error('PACK_BATCH_CONFIGURATION_REQUIRED');
 const pool=new(require('pg').Pool)({connectionString:process.env.DATABASE_URL,max:2,statement_timeout:60000,connectionTimeoutMillis:10000}),lock=await pool.connect();let locked=false;
 try{const role=(await lock.query('select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  locked=(await lock.query('select pg_try_advisory_lock(941052,1) locked')).rows[0].locked;if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');
  const bucket=new(require('@google-cloud/storage').Storage)().bucket(process.env.CRAWL_STATE_BUCKET),prefix='system/catalog-crawl/'+id+'/',file=bucket.file(prefix+'state.json');let generation=0;
  const journal={async read(){try{const [b]=await file.download(),[m]=await file.getMetadata();generation=m.generation;return JSON.parse(b);}catch(e){if(e.code===404)return null;throw e;}},async save(s){await file.save(JSON.stringify(s),{resumable:false,contentType:'application/json',preconditionOpts:{ifGenerationMatch:generation}});const [m]=await file.getMetadata();generation=m.generation;},async snapshot(key,s){await bucket.file(prefix+key+'.json').save(JSON.stringify(s),{resumable:false,contentType:'application/json'});}};
  const state=await runPacks({id,targets,journal,store:s=>writeSnapshot(pool,s),finish:p=>finishPack(pool,p),retryFailed:process.env.CRAWL_RETRY_FAILED==='true'});
  console.log(JSON.stringify({stage:'pack-batch',id,status:state.status,packs:Object.values(state.packs).map(p=>({pid:p.snapshot?.pid,locale:p.snapshot?.locale,name:p.snapshot?.name,status:p.status,...p.result})),cards:Object.keys(state.cards).length}));if(!['complete','complete_with_pending'].includes(state.status))process.exitCode=1;
 }finally{if(locked)await lock.query('select pg_advisory_unlock(941052,1)');lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'pack-batch-failed',code:safe(e)}));process.exitCode=1;});
module.exports={packTargets,runPacks,finishPack};
