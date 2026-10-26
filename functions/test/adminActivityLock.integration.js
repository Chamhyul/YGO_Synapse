
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash,randomBytes}=require('node:crypto');
const {fixture,call}=require('./commonWriterFixture.cjs');
const {createAdminPageHandler,IDLE_MS,ABSOLUTE_MS}=require('../services/adminPageSession');
const {accountResource}=require('../services/user-storage/accountResource');
const {performance}=require('node:perf_hooks');
const {createWriterJournalStore}=require('../services/user-storage/writerJournalStore');
const journalState=async f=>(await createWriterJournalStore({database:f.connection.targetDatabase}).read(f.config.runId)).value;
const id=()=>randomBytes(16).toString('hex'),gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function setup(backend='rtdb'){
 const f=await fixture();await f.binding.transition.initialize();
 if(backend==='rtdb'){const w=await f.binding.transition.route();await f.binding.transition.copy(w);await f.binding.transition.drain(w);await f.binding.transition.activate(w);}
 const cookie='synthetic-activity-cookie',key=createHash('sha256').update(cookie).digest('hex'),time=Date.now(),value={uid:f.owner,lastActivity:time-1000,expiresAt:time+ABSOLUTE_MS};
 await f.binding.adminSessions.set(key,value);const user=await f.binding.auth.getUser(f.owner);
 const state={disabled:false,revoked:false,fail:false,now:time};
 const auth={verifySessionCookie:async()=>({uid:f.owner,auth_time:Math.floor((time-60000)/1000)}),getUser:async()=>{if(state.fail)throw Error('synthetic-failed-auth');return{...user,disabled:state.disabled,tokensValidAfterTime:state.revoked?new Date(time).toISOString():user.tokensValidAfterTime};}};
 const handler=createAdminPageHandler({auth,store:f.binding.adminSessions,now:()=>state.now,template:async()=>'<html><body><div id="admin-content"></div></body></html>'});
 const activity=(body={uid:f.owner})=>call(handler,{url:'/admin/session/activity',body,headers:{cookie:'__session='+cookie,host:'ygo-synapse.web.app',origin:'https://ygo-synapse.web.app','content-type':'application/json'}});
 return{...f,state,key,value,activity,handler};
}
for(const backend of ['legacy','rtdb'])test(`${backend} 활동 저장을 멈춰도 같은 계정 멤버십은 기다리지 않고 완료한다`,{timeout:30000},async()=>{
 const f=await setup(backend),entered=gate(),release=gate();let pending;
 try{const adapter=f.binding.stores[backend],commit=adapter.commit;adapter.commit=async(op,...args)=>{if(op.details?.action==='touch'){entered.resolve(op);await release.promise;}return commit(op,...args);};
  pending=f.activity();const op=await entered.promise;assert.deepEqual(op.resources,['session/'+f.key]);
  const parent=(await journalState(f)).external[op.parentExternal];assert(parent.resources.includes('session/'+f.key));assert(!parent.resources.includes(accountResource(f.owner)));
  const timeout=gate();let timer=setTimeout(()=>timeout.resolve('timeout'),2500);const begin=performance.now();
  try{assert.equal(await Promise.race([f.binding.membership.withVerification(f.owner,'youtube',async()=> 'completed'),timeout.promise]),'completed');}finally{clearTimeout(timer);}
  console.log(JSON.stringify({event:'synthetic_admin_activity_membership_overlap',backend,membershipMs:Math.round(performance.now()-begin),activityBlocked:true,production:false}));
  release.resolve();assert.equal((await pending).statusCode,204);assert.equal((await f.binding.adminSessions.get(f.key)).lastActivity,f.state.now);
 }finally{release.resolve();if(pending)await Promise.allSettled([pending]);await f.close();}
});
test('같은 계정의 다른 세션 활동도 독립적으로 완료한다', {timeout:30000}, async()=>{
 const f=await setup(),entered=gate(),release=gate();let pending;
 try{
  const cookie='synthetic-second-cookie',key=createHash('sha256').update(cookie).digest('hex');
  await f.binding.adminSessions.set(key,f.value);
  const adapter=f.binding.stores.rtdb,commit=adapter.commit;
  adapter.commit=async(op,...rest)=>{if(op.details?.action==='touch'&&op.changes.some(c=>c.key==='session/'+f.key)){entered.resolve();await release.promise;}return commit(op,...rest);};
  pending=f.activity();await entered.promise;
  const second=call(f.handler,{url:'/admin/session/activity',body:{uid:f.owner},headers:{cookie:'__session='+cookie,host:'ygo-synapse.web.app',origin:'https://ygo-synapse.web.app','content-type':'application/json'}});
  let timer;try{const result=await Promise.race([second,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('independent-session-blocked')),2500);})]);assert.equal(result.statusCode,204);}finally{clearTimeout(timer);}
  release.resolve();assert.equal((await pending).statusCode,204);
  assert.equal((await f.binding.adminSessions.get(key)).lastActivity,f.state.now);
 }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});
test('같은 세션의 활동 요청은 직렬화하고 늦은 시각으로 되돌리지 않는다',async()=>{
 const f=await setup(),entered=gate(),release=gate();let a,b;
 try{const adapter=f.binding.stores.rtdb,commit=adapter.commit;let once=true;adapter.commit=async(op,...rest)=>{if(once&&op.details?.action==='touch'){once=false;entered.resolve();await release.promise;}return commit(op,...rest);};
  a=f.activity();await entered.promise;f.state.now+=10;b=f.activity();await new Promise(r=>setTimeout(r,100));
  release.resolve();assert.equal((await a).statusCode,204);assert.equal((await b).statusCode,204);assert.equal((await f.binding.adminSessions.get(f.key)).lastActivity,f.state.now);
 }finally{release.resolve();await Promise.allSettled([a,b].filter(Boolean));await f.close();}
});
for(const failure of ['uid','disabled','revoked','auth-down','idle','absolute'])test(`활동 ${failure}는 기존 인증·만료 검사를 유지한다`,async()=>{
 const f=await setup();try{if(failure==='disabled')f.state.disabled=true;if(failure==='revoked')f.state.revoked=true;if(failure==='auth-down')f.state.fail=true;
 if(failure==='idle')f.state.now+=IDLE_MS;if(failure==='absolute')f.state.now=f.value.expiresAt;
 const res=await f.activity(failure==='uid'?{uid:'different-synthetic'}:undefined);assert.equal(res.statusCode,failure==='auth-down'?503:401);
 if(['uid','disabled','revoked','auth-down'].includes(failure)){const current=await f.binding.adminSessions.get(f.key);if(current)assert.equal(current.lastActivity,f.value.lastActivity);}
 }finally{await f.close();}
});
test('활동 조회 중 삭제·재발급은 기다리며 새 세션은 오래된 결과로 덮이지 않는다',async()=>{
 const f=await setup(),entered=gate(),release=gate();let pending,removing;
 try{const adapter=f.binding.stores.rtdb,commit=adapter.commit;let once=true;adapter.commit=async(op,...rest)=>{if(once&&op.details?.action==='touch'){once=false;entered.resolve();await release.promise;}return commit(op,...rest);};
 pending=f.activity();await entered.promise;removing=f.binding.adminSessions.withRequest({},async()=>{await f.binding.adminSessions.remove(f.key);await f.binding.adminSessions.set(f.key,{...f.value,lastActivity:f.state.now+20});});
 release.resolve();assert.equal((await pending).statusCode,204);await removing;assert.equal((await f.binding.adminSessions.get(f.key)).lastActivity,f.state.now+20);
 }finally{release.resolve();await Promise.allSettled([pending,removing].filter(Boolean));await f.close();}
});
test('활동 종료 ACK 실패는 성공을 반환하지 않고 기존 세션 복구 도구로 대조한다',async()=>{
 const f=await setup();{f.binding.transition.prepareAndExecuteActivityWithReceipt=undefined;f.binding.transition.prepareAndExecuteActivityAdmissionWithReceipt=undefined;}try{const end=f.binding.transition.endExternal;let once=true;f.binding.transition.endExternal=async()=>{if(once){once=false;throw Object.assign(Error('synthetic-ack-loss'),{code:'WRITER_OUTCOME_UNRESOLVED'});}};
 const res=await f.activity();assert.equal(res.statusCode,503);assert.equal(res.body.code,'ADMIN_SESSION_RECOVERY_REQUIRED');
 const state=await journalState(f),op=Object.values(state.operations).find(o=>o.details?.action==='touch'),ids={operation:op.id,parentRequest:op.parentExternal,recoveryRequest:id()};assert(op);f.binding.transition.endExternal=end;
 const writer=await f.binding.transition.route();await f.binding.transition.drain(writer);const p=await f.binding.transition.previewSessionRecovery(writer,ids);
 const done=await f.binding.transition.recoverSession(writer,{...ids,expectedPreview:p.previewDigest,writersDrained:true});assert.equal(done.recoveryState,'completed');assert.equal((await f.binding.transition.inspect()).unresolved,0);
 }finally{await f.close();}
});
