'use strict';
const { Pool, Client, escapeLiteral } = require('pg');
const {performance}=require('node:perf_hooks');
function createDatabase(connectionString, max = 4, expectedRole = 'synapse_transition_api', { prepareCatalog = false, prepareMembership = false } = {}) {
  const connections=new WeakMap();
  class ObservedClient extends Client {
    connect(callback){
      const entry={connectStart:performance.now()};connections.set(this,entry);
      if(typeof callback==='function')return super.connect(error=>{entry.connectEnd=performance.now();callback(error);});
      return super.connect().finally(()=>{entry.connectEnd=performance.now();});
    }
  }
  const pool = new Pool({Client:ObservedClient, connectionString, max, min: prepareCatalog ? Math.min(2,max) : prepareMembership ? 1 : 0, onConnect: prepareCatalog || prepareMembership ? async client => {
    const preparation=connections.get(client);if(preparation)preparation.prepareStart=performance.now();
    try {
    // 실제 사용자 행을 읽지 않고 새 PostgreSQL 세션의 로그인·RLS 계획 정보를 준비한다.
    if(prepareCatalog){
      // 공개 카드 한 종으로 같은 조회 계획·변환 경로만 준비한다. 전체 묶음의 선조회는 새 연결마다 반복하지 않는다.
      const {rows}=await client.query('select cid::text from catalog.cards order by cid limit 1');
      if(rows.length){
        await require('./repository.cjs').createRepository({}).prepareLoginRead(client,rows[0].cid);
      }
    }
    if(prepareMembership)await client.query('select provider,status,level_name,provider_account_id from app.user_memberships limit 0');
    } finally {if(preparation)preparation.prepareEnd=performance.now();}
  } : undefined, connectionTimeoutMillis: 8000, idleTimeoutMillis: 120000, keepAlive: true,
    statement_timeout: 10000, application_name: 'ygo-synapse-transition' });
  pool.on('error', () => {});
  async function acquire({onTiming,timingPrefix='db'}={}) {
    const prefix=timingPrefix==='membership_db'?'membership_db':'db';
    const record=(suffix,ms)=>{try{if(Number.isFinite(ms)&&ms>=0)onTiming?.(prefix+'_'+suffix,ms);}catch(_){}};
    const measure=async(suffix,work)=>{const start=performance.now();try{return await work();}finally{record(suffix,performance.now()-start);}};
    const start=performance.now();let client;
    try {client=await pool.connect();}
    catch(error){record('acquire',performance.now()-start);throw error;}
    const acquired=performance.now(),entry=connections.get(client);record('acquire',acquired-start);
    const overlap=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.min(acquired,b)-Math.max(start,a)):0;
    const connected=overlap(entry?.connectStart,entry?.connectEnd),prepared=overlap(entry?.prepareStart,entry?.prepareEnd);
    record('connect',connected);record('prepare',prepared);record('pool_wait',Math.max(0,acquired-start-connected-prepared));
    return {client,measure};
  }
  async function withUser(uid, action, { readOnly = false, onTiming, timingPrefix='db' } = {}) {
    const {client,measure}=await acquire({onTiming,timingPrefix});
    try {
      if (prepareMembership && !readOnly) {
        if (typeof uid !== 'string' || !uid.length || uid.includes('\0')) throw Error('INVALID_USER_SCOPE');
        const scope=await measure('begin',()=>client.query(
          `BEGIN; select set_config('synapse.uid',${escapeLiteral(uid)},true) as uid;`));
        if (!Array.isArray(scope) || scope.length!==2 || scope[0].command!=='BEGIN' ||
            scope[1].command!=='SELECT' || scope[1].rows[0]?.uid!==uid) throw Error('INVALID_USER_SCOPE');
      } else {
        await measure('begin',()=>client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'));
        await measure('uid',()=>client.query("select set_config('synapse.uid', $1, true)", [uid]));
      }
      const value = await action(client);
      await measure('commit',()=>client.query('COMMIT'));
      return value;
    } catch (error) { await measure('rollback',()=>client.query('ROLLBACK')).catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function runUserRead(uid, queries, action, {onTiming,timingPrefix='db'}={}) {
    // 여러 명령을 한 Query로 보낼 때는 바인드 변수를 사용할 수 없다. 고정 SQL의 UID만
    // 같은 pg 드라이버의 SQL 리터럴 인용으로 치환하며 클라이언트 SQL은 받지 않는다.
    if(typeof uid!=='string'||!uid.length||uid.includes('\0'))throw Error('INVALID_USER_SCOPE');
    const literal=escapeLiteral(uid),query=queries.map(sql=>sql.replace(/\$1\b/g,()=>literal)).join(';\n');
    const complete=typeof action!=='function';
    const {client,measure}=await acquire({onTiming,timingPrefix});let broken;
    try {
      const results=await measure('read_batch',()=>client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
        select set_config('synapse.uid',${literal},true) as uid,
          current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly;
        ${query}; ${complete?'COMMIT;':''}`));
      const commands=['BEGIN','SELECT',...queries.map(()=>'SELECT'),...(complete?['COMMIT']:[])];
      if(!Array.isArray(results)||results.length!==commands.length||results.map(r=>r.command).join(',')!==commands.join(',')
        ||results[1].rows[0]?.uid!==uid||results[1].rows[0]?.isolation!=='repeatable read'||results[1].rows[0]?.readonly!=='on')throw Error('INVALID_READ_SCOPE');
      const values=results.slice(2,complete?-1:undefined);
      if(complete)return values[0];
      const value=await action(client,values);
      const committed=await measure('commit',()=>client.query('COMMIT'));
      if(committed.command!=='COMMIT')throw Error('READ_COMMIT_FAILED');
      return value;
    } catch(error) {
      try{await measure('rollback',()=>client.query('ROLLBACK'));}catch(rollbackError){broken=rollbackError;}
      throw error;
    } finally {client.release(broken);}
  }
  const readUser=(uid,sql,options)=>runUserRead(uid,[sql],null,options);
  const withUserRead=(uid,queries,action,options)=>runUserRead(uid,queries,action,options);
  async function writeMembershipNonce(uid, sql, values) {
    // 호출자는 내부 nonce SQL만 전달한다. OAuth 증명 원문은 파라미터로 받지 않는다.
    if (typeof uid!=='string' || !uid.length || uid.includes('\0') || values[0]!==uid) throw Error('INVALID_USER_SCOPE');
    const literals=values.map(value=>{
      if (value===null) return 'NULL';
      if (Number.isSafeInteger(value)) return String(value);
      if (typeof value==='string' && !value.includes('\0')) return escapeLiteral(value);
      throw Error('INVALID_NONCE_PARAMETER');
    });
    const statement=sql.replace(/\$(\d+)\b/g,(_,index)=>{
      const literal=literals[Number(index)-1];
      if (literal===undefined) throw Error('INVALID_NONCE_PARAMETER');
      return literal;
    });
    const {client}=await acquire({timingPrefix:'membership_db'});
    let broken;
    try {
      const results=await client.query(`BEGIN; select set_config('synapse.uid',${literals[0]},true) as uid;
        ${statement}; COMMIT;`);
      if (!Array.isArray(results) || results.length!==4 || results[0].command!=='BEGIN' ||
          results[1].rows[0]?.uid!==uid || !['INSERT','UPDATE'].includes(results[2].command) ||
          results[3].command!=='COMMIT') throw Error('INVALID_NONCE_WRITE');
      return results[2];
    } catch(error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { broken=rollbackError; }
      throw error;
    } finally { client.release(broken); }
  }
  let initialPool;
  async function preparePool() {
    if(!prepareCatalog)return;
    // 두 연결은 서로 독립적이다. 한쪽 준비가 실패해도 나머지 획득을 기다린 뒤 모두 반납한다.
    const results=await Promise.allSettled(Array.from({length:Math.min(2,max)},()=>pool.connect()));
    for(const result of results)if(result.status==='fulfilled')result.value.release();
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }
  async function ready() {
    // Google 인증 뒤 병렬 조회에 쓸 두 세션을 수신 시작 전에 준비한다.
    initialPool ||= preparePool().catch(error=>{initialPool=undefined;throw error;});
    await initialPool;
    const { rows: [role] } = await pool.query(`
      select current_user as name, not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) as restricted
      from pg_roles where rolname = current_user`);
    if (role?.name !== expectedRole || !role.restricted) throw Error('DB 계정 권한이 올바르지 않습니다.');
    await pool.query('select cid from catalog.cards limit 1');
    // 새 API에 필요한 스키마를 확인한다. 업무 행을 읽거나 적용 여부를 변경하지 않는다.
    await pool.query(`
      select s.user_id,h.state,r.status,r.bound_generation,i.import_key,i.import_details,c.verified
      from app.user_subjects s
      left join app.inventory_heads h using (user_id)
      left join app.inventory_import_receipts r using (user_id)
      left join app.inventory_items i using (user_id)
      cross join app.import_receipt_coverage c
      limit 0`);
    await pool.query('select user_id,provider,status,level_name from app.user_memberships limit 0');
  }
  async function writesReady() {
    const { rows: [state] } = await pool.query('select ready from app.transition_release_readiness');
    return state?.ready === true;
  }
  return { pool, withUser, readUser, withUserRead, ready, writesReady, close: () => pool.end(),
    ...(prepareMembership ? {writeMembershipNonce} : {}) };
}
module.exports = { createDatabase };
