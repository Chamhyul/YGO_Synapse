'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,call}=require('./commonWriterFixture.cjs');
test('실제 RTDB 계정 요약은 인벤토리·claims 없이 진입하고 후속 전체 응답·전환·복구 계약을 유지한다',async()=>{
 const f=await fixture();try{
 await f.binding.transition.initialize();await f.binding.repository.completeRegistration(f.uid,{terms:'fixture',privacy:'fixture'});
 const writer=await f.binding.transition.route();await f.binding.transition.copy(writer);await f.binding.transition.drain(writer);await f.binding.transition.activate(writer);
 const claims=f.load('functions/services/membershipClaims.js'),sync=claims.syncMembershipClaims;let claimsCalls=0;
 claims.syncMembershipClaims=async(...args)=>{claimsCalls++;return sync(...args);};
 const routes=f.load('functions/routes/registration.js'),user=f.load('functions/routes/user.js');
 const summary=await call(routes.getRegistrationStatus,{method:'GET',query:{includeAccountData:'true'}});
 assert.equal(summary.statusCode,200);assert.equal(summary.body.registered,true);assert.equal(summary.body.initialAccount.success,true);assert.equal(claimsCalls,0);
 assert(!Object.hasOwn(summary.body.initialAccount,'allCards'));assert(!Object.hasOwn(summary.body,'initialData'));
 const full=await call(user.getUserData,{method:'GET'});assert.equal(full.statusCode,200);assert.equal(full.body.success,true);assert(Array.isArray(full.body.allCards));assert.equal(full.body.membershipClaims.status,'synced');
 assert.equal(claimsCalls,1);const legacy=await call(routes.getRegistrationStatus,{method:'GET',query:{includeUserData:'true'}});
 assert(legacy.body.initialData);assert(!legacy.body.initialAccount);
 const reverse=await f.binding.transition.route();await f.binding.transition.copy(reverse);await f.binding.transition.drain(reverse);await f.binding.transition.activate(reverse);
 const after=await call(routes.getRegistrationStatus,{method:'GET',query:{includeAccountData:'true'}});assert.equal(after.body.initialAccount.success,true);
 const state=await f.binding.transition.inspect();assert.equal(state.unresolved,0);assert.equal(state.externalUnresolved,0);
 }finally{await f.close();}
});
