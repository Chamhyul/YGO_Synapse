'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{randomBytes,createHash}=require('crypto');
const {open}=require('../../integration/user-migration/connection.cjs');
const {createWriterJournalStore}=require('../services/user-storage/writerJournalStore');
const {createUserInventoryWriterBinding}=require('../services/userInventoryWriterRepository');
const {createAdminPageHandler}=require('../services/adminPageSession');
const {withAdminRequestTiming}=require('../services/adminRequestTiming');
const {createTrafficSummaryService}=require('../services/adminTrafficSummary');
async function fixture({failTraffic=false,failObserver=false,shuffleTraffic=false,emptyTraffic=false}={}){
 const connection=open(randomBytes(16).toString('hex')),runId=randomBytes(16).toString('hex');
 await createWriterJournalStore({database:connection.targetDatabase}).update(runId,()=>({value:{format:1,backend:'rtdb',epoch:1,phase:'accepting',sequence:0,floor:0,operations:{},events:[],transfer:null,frozen:{}}}));
 const binding=createUserInventoryWriterBinding({db:connection.db,database:connection.targetDatabase,bucket:connection.bucket,FieldValue:require('firebase-admin/firestore').FieldValue,runId,initializeMissing:false,historyMaintenance:'deferred',migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
 const cookie='SYNTHETIC_PRIVATE_COOKIE',uid='SYNTHETIC_PRIVATE_UID',key=createHash('sha256').update(cookie).digest('hex');
 await binding.adminSessions.set(key,{uid,lastActivity:Date.now(),expiresAt:Date.now()+3600000});
 const logs=[],report=(metrics,dimensions=[])=>emptyTraffic?{kind:'analyticsData#runReport',metadata:{timeZone:'Asia/Seoul'}}:({metricHeaders:(shuffleTraffic?metrics.slice().reverse():metrics).map(name=>({name})),dimensionHeaders:dimensions.map(name=>({name})),metadata:{timeZone:failTraffic?'America/Los_Angeles':'Asia/Seoul'},rowCount:shuffleTraffic&&!dimensions.length?1:0,rows:shuffleTraffic&&!dimensions.length?[{metricValues:metrics.slice().reverse().map(name=>({value:String({activeUsers:11,sessions:22,screenPageViews:33}[name])}))}]:[]});
 const handler=createAdminPageHandler({store:binding.adminSessions,auth:{verifySessionCookie:async()=>({uid,auth_time:1}),getUser:async()=>({uid,customClaims:{role:'owner'},tokensValidAfterTime:new Date(0).toISOString()})},template:async()=>'<html><body><div id="admin-content" data-admin-title="synthetic">synthetic-protected-content</div></body></html>',getTrafficSummary:createTrafficSummaryService({run:async()=>({reports:[report(['activeUsers','sessions','screenPageViews']),report(['activeUsers','sessions','screenPageViews']),report(['activeUsers'],['date'])]})})});
 const app=express();app.use(withAdminRequestTiming('adminPages',handler,{emit:line=>{if(failObserver)throw Error('synthetic observer');logs.push(JSON.parse(line));}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 return{...binding,logs,async call(path){const r=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:{cookie:'__session='+cookie},signal:AbortSignal.timeout(10000)});return{status:r.status,text:await r.text()};},async close(){await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await connection.close();}};
}
test('실제 HTTP·RTDB의 공통 Auth 조회1회와 세션/전환 GET5회를 기록하고 읽기 잠금을 만들지 않는다',async()=>{
 const f=await fixture();try{const r=await f.call('/admin/cards');assert.equal(r.status,200);assert.match(r.text,/synthetic-protected-content/);
 const x=f.logs[0];assert.equal(x.completed,true);assert.equal(x.status,200);assert.equal(x.route,'/admin/cards');
 assert.equal(x.spans.filter(s=>s.name==='admin.auth.account').length,1);assert.equal(x.spans.filter(s=>s.name==='record.get').length,2);assert.equal(x.spans.filter(s=>s.name==='journal.route').length,3);
 assert(x.spans.some(s=>s.name==='admin.session.confirm'));assert.equal(x.spans.filter(s=>s.name==='record.transaction').length,0);assert.equal((await f.transition.inspect()).externalUnresolved,0);
 assert.doesNotMatch(JSON.stringify(x),/SYNTHETIC_PRIVATE|synthetic-protected-content|adminSessions|profileWriterTransitions/);
 }finally{await f.close();}
});
test('실제 HTTP 통계503은 원문 없이 검증 실패를 기록하며 재시도는 cooldown으로 구분한다',async()=>{
 const f=await fixture({failTraffic:true});try{for(let i=0;i<2;i++){const r=await f.call('/admin/api/traffic');assert.equal(r.status,503);assert.deepEqual(JSON.parse(r.text),{success:false});}
 assert.equal(f.logs.length,2);assert.deepEqual(f.logs[0].trafficFailures,[{category:'TIMEZONE_MISMATCH',report:'current',timeZone:'America/Los_Angeles'}]);assert.equal(f.logs[1].trafficFailures[0].category,'COOLDOWN');
 assert(f.logs[0].spans.some(s=>s.name==='admin.traffic.ga'&&s.ok));assert(f.logs[0].spans.some(s=>s.name==='admin.traffic.validate'&&!s.ok));assert(!f.logs[1].spans.some(s=>s.name==='admin.traffic.ga'));assert.equal((await f.transition.inspect()).externalUnresolved,0);
 }finally{await f.close();}
});
test('실제 HTTP 로그 출력 실패도 읽기 응답과 저장/복구 상태를 바꾸지 않는다',async()=>{
 const f=await fixture({failObserver:true});try{const r=await f.call('/admin/cards');assert.equal(r.status,200);assert.match(r.text,/synthetic-protected-content/);assert.equal((await f.transition.inspect()).externalUnresolved,0);}finally{await f.close();}
});

test('실제 HTTP의 정상 통계 응답은 기존 집계·날짜·캐시 계약을 유지한다',async()=>{
 const f=await fixture();try{for(let i=0;i<2;i++){const r=await f.call('/admin/api/traffic');assert.equal(r.status,200);const body=JSON.parse(r.text);assert.equal(body.success,true);assert.deepEqual(body.current,{activeUsers:0,sessions:0,screenPageViews:0});assert.equal(body.daily.length,30);assert.equal(body.timeZone,'Asia/Seoul');}
 assert.equal(f.logs[0].trafficFailures.length,0);assert(f.logs[1].spans.some(s=>s.name==='admin.traffic.cache'));assert.equal((await f.transition.inspect()).externalUnresolved,0);
 }finally{await f.close();}
});

test('실제 HTTP의 비동일 헤더 순서에서도 집계값을 이름으로 연결한다',async()=>{
 const f=await fixture({shuffleTraffic:true});try{
 const r=await f.call('/admin/api/traffic');assert.equal(r.status,200);
 assert.deepEqual(JSON.parse(r.text).current,{activeUsers:11,sessions:22,screenPageViews:33});
 assert.deepEqual(f.logs[0].trafficSchemas[0].metricHeaders.map(h=>h.name),['screenPageViews','sessions','activeUsers']);
 assert.equal((await f.transition.inspect()).externalUnresolved,0);
 }finally{await f.close();}
});

test('실제 HTTP에서 정식 헤더 없는 0행 보고서만 성공 처리한다',async()=>{
 const f=await fixture({emptyTraffic:true});try{
 const r=await f.call('/admin/api/traffic');assert.equal(r.status,200);assert.equal(JSON.parse(r.text).daily.length,30);
 assert.equal(f.logs[0].trafficSchemas[0].kindValid,true);assert.equal(f.logs[0].trafficSchemas[0].rowsState,'absent');assert.equal(f.logs[0].trafficSchemas[0].rowCountState,'absent');assert.equal((await f.transition.inspect()).externalUnresolved,0);
 }finally{await f.close();}
});
