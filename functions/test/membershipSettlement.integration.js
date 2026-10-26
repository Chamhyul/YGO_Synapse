'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,createHash}=require('node:crypto');
const {FieldValue}=require('firebase-admin/firestore');
const {open}=require('../../integration/user-migration/connection.cjs');
const {createUserInventoryWriterBinding}=require('../services/userInventoryWriterRepository');
const {encodeKey}=require('../services/user-storage/codec');
const id=()=>randomBytes(16).toString('hex');
const state=()=>{const startedAt=Date.now();return{nonceHash:createHash('sha256').update(id()).digest('hex'),startedAt,expiresAt:startedAt+300000,consumed:false,localOnly:false,redirectUri:'https://ygo-synapse.web.app/'};};
const member=()=>({status:'none',type:'discord',levelName:'일반',discordId:'123456789012345678',verificationVersion:2,verificationProvider:'discord',lastChecked:Date.now()});
async function setup({onCheckpoint,historyMaintenance='inline'}={}){
 const c=open(id()),counts={journalGet:0,journalOn:0,journalOff:0,userGet:0,userOn:0,userOff:0},database={ref(path){const ref=c.targetDatabase.ref(path),group=path.startsWith('profileWriterTransitions/')?'journal':path.startsWith('users/')?'user':null;
  return new Proxy(ref,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args)=>{if(group&&['get','on','off'].includes(key))counts[group+key[0].toUpperCase()+key.slice(1)]++;return value.apply(target,args);};}});}};
 const b=createUserInventoryWriterBinding({db:c.db,database,bucket:c.bucket,FieldValue,runId:id(),config:c.config,onCheckpoint,historyMaintenance,migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
 await b.initialize();let w=await b.transition.route();await b.transition.copy(w);await b.transition.drain(w);await b.transition.activate(w);
 const uid=id(),s=state();await b.repository.updateSettings(uid,{theme:'dark'});await b.membership.start(uid,'discord',s);
 return{c,b,uid,s,counts,reset(){for(const k of Object.keys(counts))counts[k]=0;}};
}
test('인증 한 건의 journal ACK와 consume 문맥을 재사용하고 다음 요청에는 넘기지 않는다',async()=>{
 const runs=[];
 for(const scoped of [false,true]){const f=await setup();try{
  if(!scoped){f.b.transition.withSession=undefined;f.b.membershipAdapters.rtdb.withVerificationSession=undefined;}
  f.reset();await f.b.membership.withVerification(f.uid,'discord',async()=>{await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());});
  runs.push({...f.counts});assert.equal(f.counts.userGet,scoped?1:2);assert.equal(f.counts.userOn,scoped?1:2);assert.equal(f.counts.userOn,f.counts.userOff);assert.equal(f.counts.journalOn,f.counts.journalOff);
  assert.equal((await f.b.transition.inspect()).unresolved,0);assert.equal((await f.b.repository.read(f.uid)).value.settings.theme,'dark');
  f.reset();await (f.b.membershipAdapters.rtdb.withVerificationSession||f.b.membershipAdapters.rtdb.withSession)(()=>f.b.membershipAdapters.rtdb.context(f.uid,'discord'));assert.equal(f.counts.userGet,1);
 }finally{await f.c.close();}}
 assert(runs[1].journalGet<runs[0].journalGet);assert(runs[1].journalOn<runs[0].journalOn);
});
test('consume ACK 뒤 프로필 revision 변경은 서버 CAS 충돌 후 fresh 문맥으로 재계산한다',async()=>{
 const f=await setup();try{f.reset();await f.b.membership.withVerification(f.uid,'discord',async()=>{
  await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);
  await f.c.targetDatabase.ref(`users/${encodeKey(f.uid)}/profile/revision`).transaction(n=>(n||0)+1);
  await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());
 });assert.equal((await f.b.repository.read(f.uid)).value.settings.theme,'dark');assert(f.counts.userGet>=2);assert.equal((await f.b.transition.inspect()).unresolved,0);
 }finally{await f.c.close();}
});
test('consume ACK 뒤 세대 초기화·nonce 교체는 이전 문맥으로 완료되지 않는다',async()=>{
 for(const mutation of ['generation','nonce']){const f=await setup();try{
  await assert.rejects(f.b.membership.withVerification(f.uid,'discord',async()=>{
   await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);
   const ref=f.c.targetDatabase.ref(`users/${encodeKey(f.uid)}`);
   if(mutation==='nonce')await ref.child('verification/discord/nonceHash').set(createHash('sha256').update(id()).digest('hex'));
   else await ref.child('profile/generation').transaction(n=>(n||0)+1);
   await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());
  }));
  assert.notEqual((await f.b.membership.read(f.uid)).membership?.verificationProvider,'discord');
 }finally{await f.c.close();}}
});
test('소비 뒤 예외는 세션과 구독을 해제하며 별도 요청에서 fresh 완료한다',async()=>{
 const f=await setup();try{f.reset();await assert.rejects(f.b.membership.withVerification(f.uid,'discord',async()=>{await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);throw Error('synthetic interruption');}),/synthetic interruption/);
 assert.equal(f.counts.userOn,f.counts.userOff);assert.equal(f.counts.journalOn,f.counts.journalOff);f.reset();await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());assert.equal(f.counts.userGet,1);assert.equal((await f.b.transition.inspect()).unresolved,0);
 }finally{await f.c.close();}
});
test('업무 저장 후 확정 ACK 유실은 재제출하지 않고 기존 영수증 복구를 유지한다',async()=>{
 let stop=false,operation;const f=await setup({onCheckpoint:async(stage,op)=>{if(stop&&stage==='businessCommitted'){stop=false;operation=op;throw Error('synthetic completion loss');}}});
 try{await assert.rejects(f.b.membership.withVerification(f.uid,'discord',async()=>{await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);stop=true;await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());}),/synthetic completion loss/);
 assert.equal((await f.b.transition.inspect()).unresolved,1);await f.b.transition.recover(operation);assert.equal((await f.b.transition.inspect()).unresolved,0);
 assert.equal((await f.b.membership.read(f.uid)).membership.verificationProvider,'discord');assert.equal(f.counts.userOn,f.counts.userOff);
 }finally{await f.c.close();}
});
test('동시 다른 writer와 drain 뒤에도 캐시 CAS 충돌을 회수하고 부모 인증을 끝낸다',async()=>{
 const f=await setup();try{
 const other=createUserInventoryWriterBinding({db:f.c.db,database:f.c.targetDatabase,bucket:f.c.bucket,FieldValue,runId:f.b.transition.runId,config:f.c.config,migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
 await f.b.membership.withVerification(f.uid,'discord',async()=>{
  await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);
  await other.repository.updateSettings(id(),{theme:'light'});
  await other.transition.drain(await other.transition.route());
  await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());
 });const status=await f.b.transition.inspect();assert.equal(status.unresolved,0);assert.equal(status.phase,'draining');assert.equal((await f.b.membership.read(f.uid)).membership.verificationProvider,'discord');
 }finally{await f.c.close();}
});
test('재사용 문맥도 현재 만료 판정을 생략하지 않고 UID·제공자 조회에는 사용하지 않는다',async()=>{
 const f=await setup();try{f.reset();await f.b.membership.withVerification(f.uid,'discord',async()=>{
  await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);
  const before=f.counts.userGet;
  await f.b.membershipAdapters.rtdb.context(id(),'discord');assert.equal(f.counts.userGet,before+1);
  await assert.rejects(f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member(),()=>f.s.expiresAt+1),{code:'MEMBERSHIP_VERIFICATION_EXPIRED'});
 });assert.equal((await f.b.transition.inspect()).unresolved,0);
 }finally{await f.c.close();}
});
test('운영형 deferred 기록에서도 관리자 touch 잠금이 풀리면 같은 계정 인증을 정확히 한 번 완료한다',async()=>{
 const f=await setup({historyMaintenance:'deferred'});let release,entered,busy;
 const held=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),blocked=new Promise(resolve=>{busy=resolve;});
 const other=createUserInventoryWriterBinding({db:f.c.db,database:f.c.targetDatabase,bucket:f.c.bucket,FieldValue,runId:f.b.transition.runId,config:f.c.config,historyMaintenance:'deferred',
  onCheckpoint:async stage=>{if(stage==='businessCommitted'&&hold){hold=false;entered();await gate;}},migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
 let hold=false,activity,verification,actions=0;const hash='a'.repeat(64),at=Date.now(),begin=f.b.transition.beginExternal;
 try{
  await other.adminSessions.set(hash,{uid:f.uid,lastActivity:at,expiresAt:at+600000});hold=true;
  activity=other.adminSessions.withRequest({},()=>other.adminSessions.touch(hash,f.uid,at+1));await held;
  f.b.transition.beginExternal=async(...args)=>{try{return await begin(...args);}catch(error){if(error.code==='WRITER_RESOURCE_BUSY')busy();throw error;}};
  verification=f.b.membership.withVerification(f.uid,'discord',async()=>{actions++;await f.b.membership.consume(f.uid,'discord',f.s.nonceHash);await f.b.membership.complete(f.uid,'discord',f.s.nonceHash,member());});
  await blocked;assert.equal(actions,0);
  await f.b.membership.withVerification(id(),'discord',async()=>{});
  release();assert.equal(await activity,true);await verification;
  assert.equal(actions,1);assert.equal((await other.adminSessions.get(hash)).lastActivity,at+1);
  assert.equal((await f.b.membership.read(f.uid)).membership.verificationProvider,'discord');
  assert.equal((await f.b.repository.read(f.uid)).value.settings.theme,'dark');assert.equal((await f.b.transition.inspect()).unresolved,0);
 }finally{release?.();await Promise.allSettled([activity,verification]);await f.c.close();}
});
test('관리자 잠금을 기다리다 drain되면 consume하지 않고 기존 복구 경계를 보존한다',async()=>{
 const f=await setup({historyMaintenance:'deferred'});const writer=await f.b.transition.route(),parent=id(),begin=f.b.transition.beginExternal;let busy;
 const blocked=new Promise(resolve=>{busy=resolve;});let pending;
 try{
  await f.b.transition.beginExternal(writer,parent,[require('../services/user-storage/accountResource').accountResource(f.uid)]);
  f.b.transition.beginExternal=async(...args)=>{try{return await begin(...args);}catch(error){if(error.code==='WRITER_RESOURCE_BUSY')busy();throw error;}};
  pending=f.b.membership.withVerification(f.uid,'discord',()=>assert.fail('drain 후 업무 실행 금지'));const rejected=assert.rejects(pending,{code:'WRITER_DRAINING'});
  await blocked;await f.b.transition.drain(writer);await rejected;
  const nonce=await f.b.membershipAdapters.rtdb.read(`verification/discord/${f.uid}`);assert.equal(nonce.value.consumed,false);
  assert.equal((await f.b.transition.inspect()).externalUnresolved,1);
  await f.b.transition.endExternal(parent);assert.equal((await f.b.transition.inspect()).unresolved,0);
 }finally{await Promise.allSettled([pending]);await f.c.close();}
});
