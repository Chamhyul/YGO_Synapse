const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const policy = require('../services/membershipPolicy');
const response = () => ({ code:200, set(){}, status(code){this.code=code;return this;}, json(body){this.body=body;return this;}, send(){} });
function load(file, mocks, env={}) {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), {
    module,exports:module.exports,process:{env},console:{log(){},warn(){},error(){}},
    require(name){assert.ok(Object.hasOwn(mocks,name),name);return mocks[name];}
  });
  return module.exports;
}
const external = {type:'discord',status:'active',levelName:'실제 회원',verificationVersion:2,verificationProvider:'discord'};
test('현재 owner·admin·admin=true는 외부 인증 없이 회원이며 일반 계정은 원본으로 복귀한다',()=>{
  for(const claims of [{role:'owner'},{role:'admin'},{admin:true}]) {
    const role=policy.resolveAccountRole(claims);
    assert.equal(policy.resolveEffectiveMembership(role,null).status,'active');
    assert.equal(policy.resolveEffectiveMembership(role,external).type,'account');
  }
  assert.equal(policy.resolveEffectiveMembership('none',external).levelName,'실제 회원');
  assert.equal(policy.resolveEffectiveMembership('none',null).status,'none');
  assert.equal(policy.resolveAccountRole({admin:'true'}),'none');
  assert.throws(()=>policy.resolveEffectiveMembership(undefined,external));
});
test('과거 관리자 덮어쓰기·버전1·다른 제공자 표시를 외부 회원으로 인정하지 않는다',()=>{
  for(const source of [{type:'admin',status:'active'}, {...external,verificationVersion:1}, {...external,verificationProvider:'youtube'}]) {
    assert.equal(policy.resolveEffectiveMembership('none',source).status,'none');
    assert.equal(policy.resolveEffectiveMembership('owner',source).status,'active');
  }
  assert.equal(external.status,'active');
});
function userFixture({role='none',source=null,fail=false}={}) {
  let reads=0, inventoryReads=0, writes=0;
  const routes=load('routes/user.js',{
    '../services/membershipPolicy':policy,
    'firebase-functions/v2/https':{onRequest:(_,fn)=>fn},
    '../services/publicReadTransport':{withPublicReadRequest:fn=>fn},
    '../config/firebase':{db:{collection:()=>({doc:()=>({get:async()=>{reads++;return{exists:true,data:()=>({settings:{theme:'dark',membership:source}})};}})})}},
    '../utils/auth':{setCors(){},verifyRegisteredUser:async(_req,_res,options)=>{assert.equal(options.includeAccountRole,true);return'user-a';},getVerifiedAccountRole:async()=>{if(fail)throw Object.assign(Error('현재 계정 권한을 확인하지 못했습니다.'),{code:'ACCOUNT_ROLE_UNAVAILABLE'});return role;}},
    '../utils/inventoryStorage':{updateInventoryWithRetry:async()=>{writes++;}},
    '../services/inventoryMigrationService':{inventoryMigrationStatus:()=>({status:'ready'}),ensureInventoryV2:async()=>{inventoryReads++;return{cards:{},locations:{},rarities:{}};}}
  });
  return{run:async()=>{const res=response();await routes.getUserData({method:'POST',headers:{},query:{},body:{}},res);return res;},counts:()=>[reads,inventoryReads,writes]};
}
test('로그인 데이터 조회만으로 관리자 혜택을 적용하고 외부 기록·인벤토리를 변경하지 않는다',async()=>{
  for(const role of ['owner','admin','none']) {
    const f=userFixture({role,source:external}),res=await f.run();
    assert.equal(res.code,200);assert.equal(res.body.settings.membership.type,role==='none'?'discord':'account');
    assert.equal(res.body.sourceMembership.levelName,'실제 회원');assert.deepEqual(f.counts(),[1,1,0]);
  }
  const res=await userFixture({role:'owner'}).run();assert.equal(res.body.settings.membership.levelName,'소유자');assert.equal(res.body.sourceMembership.status,'none');
});
test('현재 권한 조회 실패는503이며 로컬 사용자·인벤토리 읽기와 쓰기 전에 종료한다',async()=>{
  const f=userFixture({fail:true}),res=await f.run();assert.equal(res.code,503);assert.equal(res.body.code,'ACCOUNT_ROLE_UNAVAILABLE');assert.deepEqual(f.counts(),[0,0,0]);
});
function authFixture({local=false,result={uid:'user-a',accountRole:'none',accountRoleVersion:1},claims={},disabled=false}={}) {
  let calls=0;
  const helpers=load('utils/auth.js',{
    '../config/firebase':{admin:{auth:()=>({verifyIdToken:async()=>({uid:'user-a',role:'owner'}),getUser:async()=>({customClaims:claims,disabled})})}},
    './safeError':{safeErrorSummary:()=>({})},
    '../services/membershipPolicy':policy,
    '../services/publicReadTransport':{isLocal:()=>local,requestProduction:async(name,body)=>{calls++;assert.equal(name,'verifyUserIdentity');assert.equal(body.includeAccountRole,true);return result;}}
  },local?{FIRESTORE_EMULATOR_HOST:'localhost:5003',FIREBASE_STORAGE_EMULATOR_HOST:'localhost:5004'}:{});
  return{helpers,calls:()=>calls};
}
test('운영 역할은 과거 토큰의 owner 대신 현재 계정 Claims를 사용하며 비활성 계정을 거부한다',async()=>{
  const f=authFixture(),req={headers:{authorization:'Bearer token'}};
  const uid=await f.helpers.verifyUser(req,response());assert.equal(await f.helpers.getVerifiedAccountRole(req,uid),'none');
  await assert.rejects(authFixture({disabled:true}).helpers.getVerifiedAccountRole(req,uid),{code:'ACCOUNT_ROLE_UNAVAILABLE'});
});
test('로컬 역할은 검증한 운영 응답을 요청 안에서 공유하고 다음 요청에 다시 확인한다',async()=>{
  const f=authFixture({local:true,result:{uid:'user-a',accountRole:'admin',accountRoleVersion:1}});
  const req={headers:{authorization:'Bearer token'},body:{accountRole:'owner'}};
  const uid=await f.helpers.verifyUser(req,response(),{includeAccountRole:true});
  assert.equal(await f.helpers.getVerifiedAccountRole(req,uid),'admin');assert.equal(f.calls(),1);
  assert.equal(await f.helpers.getVerifiedAccountRole({...req},uid),'admin');assert.equal(f.calls(),2);
});
test('로컬은 구형·잘못된 역할·다른 UID 결과를 임의 권한으로 대체하지 않는다',async()=>{
  const req={headers:{authorization:'Bearer token'}};
  for(const result of [{uid:'user-a'}, {uid:'user-a',accountRole:'owner',accountRoleVersion:0}, {uid:'user-a',accountRole:'root',accountRoleVersion:1}]) {
    const f=authFixture({local:true,result}),res=response();assert.equal(await f.helpers.verifyUser(req,res,{includeAccountRole:true}),null);assert.equal(res.code,503);
  }
  await assert.rejects(authFixture({local:true,result:{uid:'other',accountRole:'owner',accountRoleVersion:1}}).helpers.getVerifiedAccountRole(req,'user-a'),{code:'ACCOUNT_ROLE_UNAVAILABLE'});
});
