'use strict';
const {Pool}=require('pg'),fs=require('node:fs/promises');
const {collect}=require('./fetch.cjs'),{writeSnapshot}=require('./writer.cjs');
(async()=>{
 const cid=process.argv[2]||'4007';if(!/^[1-9]\d{0,8}$/.test(cid))throw Error('INVALID_CID');
 if(!process.env.DATABASE_URL&&process.env.CRAWL_DRY_RUN!=='true')throw Error('CRAWLER_CONFIGURATION_REQUIRED');
 const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,statement_timeout:60000}):null;
 let lock,locked=false;try{
  if(pool){lock=await pool.connect();const role=(await lock.query('select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];if(role.name!=='synapse_transition_crawler'||role.rolsuper||role.rolbypassrls)throw Error('CRAWLER_ROLE_DENIED');
   locked=(await lock.query('select pg_try_advisory_lock(941052,1) as locked')).rows[0].locked;if(!locked)throw Error('CRAWLER_ALREADY_RUNNING');}
  const snapshot=await collect(cid,{onProgress:value=>console.log(JSON.stringify({stage:'collected',cid,...value}))});
  if(process.env.CRAWL_OUTPUT){await fs.mkdir(process.env.CRAWL_OUTPUT,{recursive:true});await fs.writeFile(process.env.CRAWL_OUTPUT+'/snapshot-'+cid+'.json',JSON.stringify(snapshot));}
  if(process.env.CRAWL_DRY_RUN==='true'){console.log(JSON.stringify({stage:'dry-run',cid,locales:snapshot.pages.length,rows:snapshot.pages.reduce((n,p)=>n+p.rows.length,0)}));return;}
  console.log(JSON.stringify({stage:'stored',...await writeSnapshot(pool,snapshot)}));
 }finally{if(locked)await lock.query('select pg_advisory_unlock(941052,1)');lock?.release();if(pool)await pool.end();}
})().catch(error=>{console.error(JSON.stringify({stage:'failed',code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'CRAWL_FAILED'}));process.exitCode=1;});
