'use strict';
const {correctPrintingNumber,uncorrectedNumberCondition}=require('./number-corrections.cjs');
async function repairNumbers(pool){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('select pg_advisory_xact_lock(941052,1)');
  const {rows}=await client.query(`select p.id,p.cid,p.pid,p.locale,p.number from catalog.card_printings p
   where ${uncorrectedNumberCondition('p')} order by p.id for update`);
  for(const row of rows)await client.query('update catalog.card_printings set number=$2 where id=$1',
   [row.id,correctPrintingNumber(row)]);
  if(rows.length)await client.query('update catalog.cards set revision=revision+1,updated_at=now() where cid=any($1::integer[])',
   [[...new Set(rows.map(row=>row.cid))]]);
  const {rows:[check]}=await client.query(`select count(*)::int as remaining from catalog.card_printings p where ${uncorrectedNumberCondition('p')}`);
  if(check.remaining!==0)throw Error('NUMBER_REPAIR_INCOMPLETE');
  await client.query('COMMIT');return {status:'completed',updated:rows.length,remaining:0};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}
async function repairIllustrations(pool,{collect,writeSnapshot,now=Date.now,budgetMs=2700000}={}){
 collect ||= require('./fetch.cjs').collect;writeSnapshot ||= require('./writer.cjs').writeSnapshot;
 const lock=await pool.connect();let locked=false;
 try{
  locked=(await lock.query('select pg_try_advisory_lock(941052,1) as locked')).rows[0].locked;
  if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');
  const {rows}=await lock.query(`select l.cid,array_agg(l.locale order by l.locale) as languages
   from catalog.card_localizations l where not exists(select 1 from catalog.artwork_sources a where a.cid=l.cid and a.locale=l.locale)
   group by l.cid order by l.cid`);
  const deadline=now()+budgetMs;let repaired=0;
  for(const row of rows){
   if(now()>=deadline)throw Error('ILLUSTRATION_REPAIR_REMAINING');
   const snapshot=await collect(row.cid,{languages:row.languages});await writeSnapshot(pool,snapshot,{verify:true});repaired++;
  }
  return {status:'completed',repaired,remaining:0,imageRequests:0};
 }finally{if(locked)await lock.query('select pg_advisory_unlock(941052,1)').catch(()=>{});lock.release();}
}
async function main(){
 const kind=process.argv[2];if(!['numbers','illustrations'].includes(kind)||!process.env.DATABASE_URL)throw Error('MAINTENANCE_CONFIGURATION_REQUIRED');
 const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000});
 pool.on('error',()=>{});
 try{
  const {rows:[role]}=await pool.query(`select current_user='synapse_transition_crawler' and not rolsuper and not rolbypassrls as allowed
   from pg_roles where rolname=current_user`);
  if(role?.allowed!==true)throw Error('CRAWLER_ROLE_DENIED');
  const result=kind==='numbers'?await repairNumbers(pool):await repairIllustrations(pool);
  console.log(JSON.stringify({stage:'maintenance-result',kind,...result}));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({stage:'maintenance-failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'MAINTENANCE_FAILED'}));process.exitCode=1;});
module.exports={repairNumbers,repairIllustrations,main};
