'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,call}=require('./commonWriterFixture.cjs');
async function setup(){const f=await fixture();await f.binding.transition.initialize();await f.binding.repository.completeRegistration(f.uid,{terms:'test',privacy:'test'});const writer=await f.binding.transition.route();await f.binding.transition.copy(writer);await f.binding.transition.drain(writer);await f.binding.transition.activate(writer);f.claims=f.load('functions/services/membershipClaims.js');f.user=f.load('functions/routes/user.js');assert.equal((await call(f.user.getUserData,{method:'GET'})).body.membershipClaims.status,'synced');return f;}
test('실제 RTDB 로그인 응답·복구 장벽을 유지하며 같은 요청의 route 4회를 제거한다',async()=>{
 const f=await setup(),window=f.binding.membership.withReadWindow,route=f.binding.transition.route;let count=0;
 f.binding.transition.route=async()=>{count++;return route();};
 try{
  delete f.binding.membership.withReadWindow;const old=await call(f.user.getUserData,{method:'GET'}),before=count;count=0;
  f.binding.membership.withReadWindow=window;const current=await call(f.user.getUserData,{method:'GET'}),after=count;
  assert.equal(old.statusCode,200);assert.equal(current.statusCode,200);assert.equal(before-after,4);
  for(const key of ['allCards','settings','sourceMembership','membershipClaims','amount','nickname','createdAt'])assert.deepEqual(current.body[key],old.body[key],key);
  assert.equal(current.body.membershipClaims.status,'synced');
  assert.equal((await f.binding.transition.inspect()).unresolved,0);assert.equal((await f.binding.transition.inspect()).externalUnresolved,0);
  console.log(JSON.stringify({event:'synthetic_login_route_reuse',before,after,removed:before-after,actualOAuth:false}));
 }finally{f.binding.membership.withReadWindow=window;f.binding.transition.route=route;await f.close();}
});
for(const kind of ['epoch','phase'])test(`실제 SDK 조회 중 ${kind} 관측 변경은 pending이고 Auth 쓰기 없음`,async()=>{
 const f=await setup(),route=f.binding.transition.route,auth=f.connection.auth,write=auth.setCustomUserClaims;let reads=0,writes=0;
 f.binding.transition.route=async()=>{const r=await route();if(++reads===2)return{...r,[kind]:kind==='epoch'?r.epoch+1:'draining'};return r;};auth.setCustomUserClaims=async(...args)=>{writes++;return write.apply(auth,args);};
 try{assert.deepEqual(await f.claims.syncMembershipClaims(f.uid),{status:'pending'});assert.equal(writes,0);assert.equal((await f.binding.claimsStorage.customClaims.inspect(f.uid)).state,'idle');}
 finally{f.binding.transition.route=route;auth.setCustomUserClaims=write;await f.close();}
});
