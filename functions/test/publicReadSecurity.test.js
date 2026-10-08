const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { requestProduction, withPublicReadRequest } = require('../services/publicReadTransport');
const { createPublicReadHandlers } = require('../services/publicReadApi');
const { createProductionIllustrationHandler } = require('../services/illustrationDelivery');
const response = () => ({ code: 200, headers: {}, set(k,v){this.headers[k]=v;return this;},setHeader(k,v){this.set(k,v);},
 status(n){this.code=n;return this;},json(body){this.body=body;return this;},send(body){this.body=body;return this;},end(){return this;} });
const reply = (data, status = 200, version='1') => ({ ok: status===200, status,
 headers:{get:key=>key.toLowerCase()==='content-type'?'application/json':version},json:async()=>data });
test('공개 조회는 App Check만 전달하고 UID·키·쿠키·임의 URL을 전달하지 않는다',async()=>{
 let received;
 await requestProduction('getPublicCardData',{cids:['42']},{headers:{'x-firebase-appcheck':'app',authorization:'Bearer user',cookie:'private','x-api-key':'private'},fetchImpl:async(url,options)=>{received={url,options};return reply({success:true,cards:[]});}});
 assert.equal(received.url,'https://asia-northeast3-ygo-synapse.cloudfunctions.net/getPublicCardData');
 assert.deepEqual(Object.keys(received.options.headers).sort(),['Content-Type','X-Firebase-AppCheck']);
 assert.equal(received.options.redirect,'error');
 await assert.rejects(requestProduction('https://evil.invalid',{}, {headers:{'x-firebase-appcheck':'app'}}));
});
test('앱 인증 누락·운영 거부·장애·구형 응답을 우회하거나 재시도하지 않는다',async()=>{
 let calls=0;
 await assert.rejects(requestProduction('getPublicCardData',{}, {headers:{},fetchImpl:()=>{calls++;}}),{status:401});
 assert.equal(calls,0);
 for(const [status,expected] of [[401,401],[403,403],[429,429],[500,503]]) {
  await assert.rejects(requestProduction('getPublicCardData',{}, {headers:{'x-firebase-appcheck':'app'},fetchImpl:async()=>{calls++;return reply({},status);}}),{status:expected});
 }
 assert.equal(calls,4);
 await assert.rejects(requestProduction('getPublicCardData',{}, {headers:{'x-firebase-appcheck':'app'},fetchImpl:async()=>reply({success:true},200,null)}),{status:503});
});
test('동시 로컬 요청의 앱 인증은 각 요청에 묶이고 서로 섞이지 않는다',async()=>{
 const seen=[];
 const handler=withPublicReadRequest(async(req)=>{
  await new Promise(resolve=>setTimeout(resolve,req.delay));
  await requestProduction('getPublicCardData',{}, {fetchImpl:async(_url,options)=>{seen.push([req.id,options.headers['X-Firebase-AppCheck']]);return reply({success:true,cards:[]});}});
 });
 await Promise.all([handler({id:'a',delay:10,headers:{'x-firebase-appcheck':'a'}}),handler({id:'b',delay:1,headers:{'x-firebase-appcheck':'b'}})]);
 assert.deepEqual(seen.sort(),[['a','a'],['b','b']]);
});
function fixture({local=false,app=true,role='none',roleFailure=false}={}) {
 const reads=[], users=[];
 const doc={id:'42',exists:true,data:()=>({names:['카드'],numbers:['TEST-001'],info:{},privateAudit:'hidden'})};
 const db={collection:name=>({doc:id=>{reads.push([name,id]);return{id};},where:(field,op,value)=>({limit:n=>({get:async()=>{reads.push([field,op,value,n]);return{docs:[doc]};}})})}),getAll:async()=>[doc]};
 const handlers=createPublicReadHandlers({isLocal:()=>local,verifyAppCheck:async(_req,res)=>{if(!app)res.status(401).json({success:false});return app;},verifyUser:async(req,res)=>{users.push(req.headers.authorization);if(req.headers.authorization==='Bearer valid')return 'verified';res.status(401).json({success:false});return null;},db,getVerifiedAccountRole:async()=>{if(roleFailure)throw Error('private');return role;},setCors(){}});
 return{handlers,reads,users};
}
test('공개 조회는 로그인 없이 카드 필드만 제공하고 자료·쿼리 범위를 제한한다',async()=>{
 const f=fixture(), res=response();
 await f.handlers.getPublicCardData({method:'POST',headers:{},ip:'a',body:{cids:['42']}},res);
 assert.equal(res.code,200);assert.equal(res.body.cards[0].cid,'42');assert.equal(f.users.length,0);
 assert.doesNotMatch(JSON.stringify(res.body),/hidden|privateAudit/);
 for(const body of [{cids:['../users']},{cids:Array(101).fill('42')},{field:'users',value:'x'},{field:'names',value:''},{cids:[],field:'names',value:'x'}]){
  const r=response();await f.handlers.getPublicCardData({method:'POST',headers:{},ip:'a',body},r);assert.equal(r.code,400);
 }
 assert.equal(f.reads.length,1);
});
test('로컬 실행·잘못된 메서드·앱 인증 실패는 카드 DB 읽기 전에 거부된다',async()=>{
 for(const [options,method,expected] of [[{local:true},'POST',503],[{},'GET',405],[{app:false},'POST',401]]){
  const f=fixture(options),res=response();await f.handlers.getPublicCardData({method,headers:{},body:{cids:['42']}},res);
  assert.equal(res.code,expected);assert.equal(f.reads.length,0);
 }
});
test('사용자 확인은 요청의 UID 대신 실제 검증 결과만 반환하고 위조 요청은 거부한다',async()=>{
 for(const valid of [true,false]){
  const f=fixture(),res=response();await f.handlers.verifyUserIdentity({method:'POST',ip:'a',headers:{authorization:valid?'Bearer valid':'Bearer fake'},body:{uid:'owner',role:'owner'}},res);
  assert.equal(res.code,valid?200:401);if(valid)assert.deepEqual(res.body,{success:true,uid:'verified'});
  assert.equal(f.reads.length,0);
 }
});
test('일러스트 로컬 중계는 카드별 고정 운영 경로만 읽고 전체 인덱스·리다이렉트를 허용하지 않는다',async()=>{
 let sent;
 const handler=createProductionIllustrationHandler({allow:()=>true,fetchImpl:async(url,options)=>{sent={url,options};return {ok:true,headers:{get:()=> 'image/webp'},arrayBuffer:async()=>Buffer.from('image')};}});
 const res=response();await handler({method:'GET',path:'/api/illustrations/42_1.webp',ip:'a'},res);
 assert.equal(sent.url,'https://ygo-synapse.web.app/api/illustrations/42_1.webp');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.headers,undefined);
 sent=null;const bad=response();await handler({method:'GET',path:'/api/illustrations/index.json',ip:'a'},bad);assert.equal(bad.code,404);assert.equal(sent,null);
});
test('키 없는 로컬 카드 보완은 운영 카드 결과와 로컬 수집 결과를 합치며 저장하지 않는다',async()=>{
 const module={exports:{}};let apiCalls=0;const local={id:'43',exists:true,data:()=>({names:['로컬'],numbers:['LOCAL'],info:{}})};
 const mocks={'../config/firebase':{db:{collection:()=>({doc:id=>({id}),where:()=>({get:async()=>({docs:[local]})})}),getAll:async()=>[local]}},'../utils/common':{normalizeText:value=>value},'../utils/cardSchema':{toRuntimeInfo:info=>info},'./publicReadTransport':{isLocal:()=>true,requestProduction:async()=>{apiCalls++;return{success:true,cards:[{cid:'42',data:{names:['운영'],numbers:['TEST'],info:{}}}]};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/cardQueryService.js'),'utf8'),{module,console,require:name=>{assert.ok(Object.hasOwn(mocks,name));return mocks[name];}});
 const cards=await module.exports.getCardsByCids(['42','43']);assert.deepEqual(Array.from(cards,card=>card.cid),['42','43']);assert.equal(apiCalls,1);
 assert.equal(await module.exports.resolveInventoryCid('TEST','운영'),'42');
});

test('운영 인증 오류는 허용된 분류만 전달하고 원본 메시지는 노출하지 않는다',async()=>{
 for(const code of ['AUTH_INVALID','APPCHECK_INVALID','private-unknown']) {
  await assert.rejects(requestProduction('verifyUserIdentity',{}, {headers:{'x-firebase-appcheck':'app',authorization:'Bearer user'},
   fetchImpl:async()=>reply({success:false,code,message:'private-message'},401)}),error=>{
    assert.equal(error.code,code==='private-unknown'?'AUTH_VERIFICATION_UNAVAILABLE':code);
    assert.doesNotMatch(error.message,/private-message/);return true;
  });
 }
});

test('명시한 역할 조회는 현재 검증 결과만 반환하며 UID 전용 요청과 호환된다',async()=>{
 for(const role of ['owner','admin','none']) {
  const f=fixture({role}),res=response();await f.handlers.verifyUserIdentity({method:'POST',ip:'a',headers:{authorization:'Bearer valid'},body:{includeAccountRole:true,role:'owner'}},res);
  assert.equal(res.body.accountRole,role);assert.equal(res.body.accountRoleVersion,1);assert.equal(f.reads.length,0);
 }
 const f=fixture({roleFailure:true}),res=response();await f.handlers.verifyUserIdentity({method:'POST',ip:'a',headers:{authorization:'Bearer valid'},body:{includeAccountRole:true}},res);
 assert.equal(res.code,503);assert.equal(res.body.code,'ACCOUNT_ROLE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(res.body),/private/);
});
