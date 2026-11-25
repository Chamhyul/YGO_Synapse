'use strict';
const {loadAuditScope} = require('./checkpoints.cjs');
const {buildAuditQuery,runAudit} = require('./catalog.cjs');

// 설정은 stdin으로만 받는다. 토큰·DSN·원본 예외를 출력하지 않는다.
async function main(config, {sqlOnly = false} = {}) {
  if (!/^[a-z0-9-]{1,80}$/.test(config.runId || '')) throw Error('INVALID_RUN_ID');
  const prefix = 'system/catalog-crawl/'+config.runId+'/';
  const read = async key => {
    const url = 'https://storage.googleapis.com/storage/v1/b/ygo-synapse-transition-artworks/o/'
      +encodeURIComponent(prefix+key+'.json')+'?alt=media';
    const r = await fetch(url,{headers:{Authorization:'Bearer '+config.accessToken},signal:AbortSignal.timeout(20000)});
    if (r.status === 404) return null;
    if (!r.ok) throw Error('CHECKPOINT_READ_'+r.status);
    return r.json();
  };
  const scope = await loadAuditScope(read,{packLimit:config.packLimit ?? 20});
  if (sqlOnly) return {query:buildAuditQuery({...scope,sampleLimit:config.sampleLimit ?? 30}),coverage:scope.coverage};
  const url = new URL(config.databaseUrl);
  if (!url.hostname.endsWith('.supabase.com') || url.username !== 'synapse_transition_api.xeipznzgzvmybnsxavin') throw Error('TEST_DATABASE_REQUIRED');
  const {Pool} = require('pg');
  const pool = new Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:10000,
    application_name:'ygo-catalog-readonly-audit'});
  try { return {...await runAudit(pool,scope),coverage:scope.coverage}; }
  finally { await pool.end(); }
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',c=>input+=c);
  process.stdin.on('end',async()=>{
    try { console.log(JSON.stringify(await main(JSON.parse(input),{sqlOnly:process.argv.includes('--sql')}))); }
    catch(e) { console.error(JSON.stringify({status:'audit_failed',code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'CATALOG_AUDIT_FAILED',
      ...(e.code && /^[A-Z0-9_]+$/.test(e.code)?{sourceCode:e.code}:{})}));process.exitCode=1; }
  });
}
module.exports = {main};
