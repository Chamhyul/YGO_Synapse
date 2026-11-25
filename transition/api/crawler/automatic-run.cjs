'use strict';
const {runAutomatic,recordPartialPack}=require('./automatic.cjs');
const {collect,createLimiter,requestHtml}=require('./fetch.cjs');
const {writeSnapshot}=require('./writer.cjs');
const {finishPack}=require('./packs.cjs');
function createAutomaticCollector({limiter,guard=async()=>{},fetchPage=fetch}){
 return async(cid,locale,{partialPack=null}={})=>{
  await guard();
  return collect(cid,{languages:[locale],limiter,fetchPage,partialPack});
 };
}
async function main(){
 const mode=process.argv[2];if(!['full','quick'].includes(mode)||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks'||!process.env.DATABASE_URL)throw Error('AUTOMATIC_CONFIGURATION_REQUIRED');
 const planOnly=process.env.AUTO_PLAN_ONLY==='true';
 const {Pool}=require('pg'),{Storage}=require('@google-cloud/storage');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:30000});pool.on('error',()=>{});
 const lock=await pool.connect();let fullLock=false,repairLock=false,lost=false,readOnly=false;lock.on('error',()=>{lost=true;});
 try{
  const r=(await lock.query('select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];if(r.name!=='synapse_transition_crawler'||r.rolsuper||r.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
  fullLock=(await lock.query('select pg_try_advisory_lock(941052,1) locked')).rows[0].locked;
  if(!fullLock){console.log(JSON.stringify({stage:'automatic-skipped',reason:'CRAWLER_ALREADY_RUNNING'}));return;}
  repairLock=(await lock.query('select pg_try_advisory_lock(941053,1) locked')).rows[0].locked;
  if(!repairLock){console.log(JSON.stringify({stage:'automatic-skipped',reason:'PACK_REPAIR_ALREADY_RUNNING'}));return;}
  if(planOnly){await lock.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');readOnly=true;}
  const bucket=new Storage().bucket(process.env.CRAWL_STATE_BUCKET),prefix='system/catalog-crawl/automatic-v1/';
  const journal=require('./checkpoints.cjs').createJournal({bucket,prefix});
  const limiter=createLimiter({maxRequests:900,initialDelay:true});
  const guard=async()=>{if(lost)throw Error('CRAWLER_LOCK_LOST');};
  const html=async url=>{await guard();return requestHtml(url,{limiter});};
  const id=process.env.CLOUD_RUN_EXECUTION||'local-'+Date.now();
  const result=await runAutomatic({mode,id,languages:process.argv.length>3?process.argv.slice(3):undefined,journal:planOnly?{read:k=>journal.read(k),write:()=>{throw Error('PLAN_WRITE_FORBIDDEN');}}:journal,planOnly,guard,
   fetchHtml:html,loadKnown:async()=>(await lock.query(`select p.pid,p.locale,p.name,p.reported_card_count,count(pc.cid)::integer observed_card_count,count(pc.position)::integer positioned_count
    from catalog.packs p left join catalog.pack_cards pc using(pid,locale) group by p.pid,p.locale,p.name,p.reported_card_count`)).rows,
   collectCard:createAutomaticCollector({limiter,guard}),
   store:s=>writeSnapshot(pool,s,{verify:true}),finish:p=>finishPack(pool,p),partial:p=>recordPartialPack(pool,p)});
  console.log(JSON.stringify({stage:'automatic-result',...result,requests:limiter.requests,imageRequests:0}));
  if(['paused','deferred'].includes(result.status))process.exitCode=1;
 }finally{if(readOnly&&!lost)await lock.query('ROLLBACK').catch(()=>{});if(repairLock&&!lost)await lock.query('select pg_advisory_unlock(941053,1)').catch(()=>{});if(fullLock&&!lost)await lock.query('select pg_advisory_unlock(941052,1)').catch(()=>{});lock.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({stage:'automatic-fatal',code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'AUTOMATIC_CRAWL_FAILED',sourceCode:e.code}));process.exitCode=1;});
module.exports={main,createAutomaticCollector};
