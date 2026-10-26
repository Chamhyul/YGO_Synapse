'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMembershipWriterRepository}=require('../services/userMembershipWriterRepository');
const {syncMembershipClaims,membershipClaim}=require('../services/membershipClaims');
const {membershipVersion}=require('../services/user-storage/membershipStore');
const {resolveRtdbConfig}=require('../config/userStorage');
const env={NODE_ENV:'test',USER_STORAGE_BACKEND:'rtdb',GCLOUD_PROJECT:'demo-user-storage',FIREBASE_DATABASE_EMULATOR_HOST:'emulators:9000',USER_DATABASE_URL:'http://emulators:9000?ns=demo-user-storage-default-rtdb'};
function fixture(){
 const calls={route:0,profile:0,account:0,acquire:0,write:0,settled:0};
 const state={writer:{backend:'rtdb',epoch:4,phase:'accepting'},profile:{exists:true,value:{settings:{membership:{status:'none'}}}},lock:{revision:2,generation:0,value:{state:'idle',operationId:'a'.repeat(32)}},settled:true};
 const transition={async route(){calls.route++;await state.routeHook?.(calls.route);return {...state.writer};}};
 const profiles={rtdb:{async read(key){calls.profile++;await state.profileHook?.(calls.profile,key);return state.profile;}},legacy:{read:()=>assert.fail('계획하지 않은 저장소 접근')}};
 const membership=createMembershipWriterRepository({transition,profiles,adapters:{},initialize:()=>transition.route(),initializeMissing:false,timeoutMs:1000});
 const record=()=>({membership:state.profile.value.settings.membership,version:membershipVersion(state.profile.value.settings.membership)});
 const auth={async getUser(){calls.account++;return {disabled:state.disabled,customClaims:{role:'owner',ygoMembership:membershipClaim(record())}};},async setCustomUserClaims(){calls.write++;assert.fail('정상 읽기는 Auth를 수정하지 않는다');}};
 const storage={membership,config:resolveRtdbConfig(env),writerTransition:transition,customClaims:{async observe(){await state.lockHook?.();return structuredClone(state.lock);},async isSettled(){calls.settled++;return state.settled;},async acquire(){calls.acquire++;throw Error('쓰기 경로 대상 아님');}}};
 const options={env,storage,auth,allowEmulator:true,timeoutMs:1000};return{state,calls,membership,options};
}
test('정상 claims는 원본·잠금을 두 번 확인하며 중첩 route만 6회에서 2회로 줄인다',async()=>{
 for(const legacy of [true,false]){const f=fixture();if(legacy)delete f.membership.withReadWindow;
  assert.equal((await syncMembershipClaims('synthetic',f.options)).status,'synced');
  assert.equal(f.calls.route,legacy?6:2);assert.equal(f.calls.profile,2);assert.equal(f.calls.account,1);assert.equal(f.calls.settled,1);assert.equal(f.calls.acquire,0);assert.equal(f.calls.write,0);
 }
});
for(const kind of ['epoch','backend','phase','profile','lock','settled','disabled']){
 test(`${kind} 변경·미확정은 성공이나 자동 쓰기로 바꾸지 않는다`,async()=>{
  const f=fixture();
  if(['epoch','backend','phase'].includes(kind))f.state.routeHook=n=>{if(n===2)f.state.writer[kind]=kind==='epoch'?5:kind==='backend'?'legacy':'draining';};
  if(kind==='profile')f.state.profileHook=n=>{if(n===2)f.state.profile={exists:true,value:{settings:{membership:{status:'none',lastChecked:1}}}};};
  if(kind==='lock'){let n=0;f.state.lockHook=()=>{if(++n===2)f.state.lock.revision++;};}
  if(kind==='settled')f.state.settled=false;if(kind==='disabled')f.state.disabled=true;
  assert.deepEqual(await syncMembershipClaims('synthetic',f.options),{status:'pending'});assert.equal(f.calls.acquire,0);assert.equal(f.calls.write,0);
 });
}
test('조회창 종료·예외 뒤 read를 재사용하지 못하며 새 요청은 다시 읽는다',async()=>{
 const f=fixture();let read;
 await f.membership.withReadWindow('synthetic',async window=>{read=window.read;await read();});
 await assert.rejects(read(),{code:'WRITER_FENCED'});
 await assert.rejects(f.membership.withReadWindow('synthetic',async window=>{read=window.read;throw Error('synthetic');}));
 await assert.rejects(read(),{code:'WRITER_FENCED'});
 assert.equal((await syncMembershipClaims('synthetic',f.options)).status,'synced');assert.equal(f.calls.profile,3);
});
test('동시 사용자·요청은 프로필이나 전환 관측을 공유하지 않는다',async()=>{
 const f=fixture(),keys=[];f.state.profileHook=(_n,key)=>keys.push(key);
 const result=await Promise.all(['one','two'].map(uid=>syncMembershipClaims(uid,f.options)));
 assert(result.every(r=>r.status==='synced'));assert.equal(f.calls.route,4);assert.equal(f.calls.profile,4);
 assert.equal(keys.filter(k=>k==='fs/users/one').length,2);assert.equal(keys.filter(k=>k==='fs/users/two').length,2);
});
