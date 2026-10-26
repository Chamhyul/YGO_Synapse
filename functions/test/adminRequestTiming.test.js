'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {withAdminRequestTiming,measure,recordTrafficFailure,MAX_SPANS}=require('../services/adminRequestTiming');
const inventoryTiming=require('../services/inventoryRequestTiming');
const {createTrafficSummaryService}=require('../services/adminTrafficSummary');
const {createAdminPageHandler,createMemoryStore}=require('../services/adminPageSession');
const {createHash}=require('node:crypto');
function response(){return {statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},type(v){this.headers.type=v;return this;},json(v){this.body=v;return this;},send(v){this.body=v;return this;}};}
const request=(url='/admin/cards',method='GET')=>({method,url,originalUrl:url,protocol:'https',headers:{host:'synthetic.example',cookie:'__session=PRIVATE_COOKIE',authorization:'PRIVATE_TOKEN'},body:{private:'PRIVATE_BODY'}});
async function timed(handler,req=request(),operation='adminPages'){
 const records=[],res=response();await withAdminRequestTiming(operation,handler,{emit:x=>records.push(JSON.parse(x))})(req,res);return{res,records};
}
test('실제 관리자 handler의 두 인증·최종 세션·HTML과 내부 record 조회를 같은 요청에서 계측한다',async()=>{
 const store=createMemoryStore(),cookie='PRIVATE_COOKIE',uid='PRIVATE_UID',now=Date.now();
 await store.set(createHash('sha256').update(cookie).digest('hex'),{uid,lastActivity:now,expiresAt:now+3600000});
 const get=store.get;store.get=key=>inventoryTiming.measure('record.get',()=>get(key));
 store.withReadRequest=async(req,authorize,read)=>{const a=await authorize({readOnly:true}),result=await read(a),last=await authorize({readOnly:true,confirmSession:true});return{access:last,result};};
 const handler=createAdminPageHandler({store,auth:{verifySessionCookie:async()=>({uid,auth_time:1}),getUser:async()=>({customClaims:{role:'owner'},tokensValidAfterTime:new Date(0).toISOString()})},template:async()=>'<html><body><div id="admin-content" data-admin-title="synthetic">protected-body</div></body></html>'});
 const{res,records}=await timed(handler);assert.equal(res.statusCode,200);assert.match(res.body,/protected-body/);assert.equal(records.length,1);
 const names=records[0].spans.map(s=>s.name);
 for(const name of ['admin.auth.initial','admin.auth.final','admin.session.confirm','admin.html','admin.html.template','admin.html.parse','admin.html.serialize','record.get'])assert(names.includes(name),name);
 assert.equal(names.filter(n=>n==='admin.auth.account').length,2);assert.equal(names.filter(n=>n==='record.get').length,3);
 assert(records[0].spans.every(s=>s.ok&&s.durationMs>=0&&s.id>s.parent));
 assert.doesNotMatch(JSON.stringify(records),/PRIVATE|protected-body|synthetic.example|tokensValidAfter/);
});
test('고정 route·method만 수집하고 backend 쿼리·비공개 입력·오류 원문을 내보내지 않는다',async()=>{
 const{records}=await timed(async()=>measure('admin.auth.account',async()=>7),request('/adminBackend?route=%2Fadmin%2Fapi%2Ftraffic&private=PRIVATE_QUERY'),'adminBackend');
 assert.equal(records[0].route,'/admin/api/traffic');assert.doesNotMatch(JSON.stringify(records),/PRIVATE|QUERY/);
 for(const req of [request('/unknown?secret=PRIVATE'),request('/admin','OPTIONS')]){const logs=[];let n=0;await withAdminRequestTiming('adminPages',()=>++n,{emit:x=>logs.push(x)})(req,response());assert.equal(n,1);assert.equal(logs.length,0);}
});
test('관측 출력 실패는 성공 응답과 오류 객체·쓰기 경계를 바꾸지 않는다',async()=>{
 const error=Error('PRIVATE_ERROR');
 await assert.rejects(withAdminRequestTiming('adminPages',()=>measure('admin.auth.account',()=>Promise.reject(error)),{emit(){throw Error('observer');}})(request(),response()),e=>e===error);
 assert.equal(await withAdminRequestTiming('adminPages',()=>17,{emit(){throw Error('observer');}})(request(),response()),17);
});
test('동시 요청은 문맥과 span을 공유하지 않고 최대 계측 수를 제한한다',async()=>{
 const logs=[];
 const handler=withAdminRequestTiming('adminPages',async req=>{await Promise.resolve();for(let i=0;i<(req.url==='/admin'?1:MAX_SPANS+2);i++)await measure('admin.session.get',()=>i);measure('PRIVATE_UNKNOWN',()=>1);},{emit:x=>logs.push(JSON.parse(x))});
 await Promise.all([handler(request('/admin'),response()),handler(request('/admin/cards'),response())]);
 assert.equal(new Set(logs.map(x=>x.requestId)).size,2);assert.equal(logs.find(x=>x.route==='/admin').spans.length,1);assert.equal(logs.find(x=>x.route==='/admin/cards').spans.length,MAX_SPANS);assert.equal(logs.find(x=>x.route==='/admin/cards').droppedSpans,2);
});
test('finish/close는 한 번만 출력하고 종료 후 span은 추가하지 않는다',async()=>{
 const res=Object.assign(new EventEmitter(),{statusCode:503}),logs=[];
 await withAdminRequestTiming('adminPages',async()=>{await measure('admin.session.get',()=>1);res.emit('close');await measure('admin.session.get',()=>2);res.emit('finish');},{emit:x=>logs.push(JSON.parse(x))})(request(),res);
 assert.equal(logs.length,1);assert.equal(logs[0].completed,false);assert.equal(logs[0].spans.length,1);
});
const metrics=['activeUsers','sessions','screenPageViews'];
const report=(m,dimensions=[])=>({metricHeaders:m.map(name=>({name})),dimensionHeaders:dimensions.map(name=>({name})),metadata:{timeZone:'Asia/Seoul'},rowCount:0,rows:[]});
const reports=()=>({reports:[report(metrics),report(metrics),report(['activeUsers'],['date'])]});
for(const [category,change] of [
 ['REPORTS_MISSING',x=>x.reports=[]],['REPORT_MISSING',x=>x.reports[0]=null],
 ['TIMEZONE_MISMATCH',x=>x.reports[0].metadata.timeZone='America/Los_Angeles'],
 ['METRIC_HEADERS',x=>x.reports[0].metricHeaders=[]],['DIMENSION_HEADERS',x=>x.reports[2].dimensionHeaders=[]],
 ['ROW_COUNT',x=>x.reports[0].rowCount=1],['METRIC_HEADERS',x=>x.reports[0].metricHeaders={}],
 ['COUNT_VALUE',x=>{x.reports[0].rowCount=1;x.reports[0].rows=[{metricValues:[{value:'-1'},{value:'0'},{value:'0'}]}];}],
])test(`통계 ${category}를 분류하되 외부 응답과 실패 재시도 계약을 유지한다`,async()=>{
 const data=reports();change(data);let calls=0;const get=createTrafficSummaryService({run:async()=>{calls++;return data;}});
 const handler=async(req,res)=>{try{await get();res.json({success:true});}catch(e){assert.equal(e.message,calls===1?'traffic-summary-unavailable':'traffic-cooldown');res.status(503).json({success:false});}};
 const first=await timed(handler,request('/admin/api/traffic'));assert.deepEqual(first.res.body,{success:false});assert.equal(first.res.statusCode,503);assert.equal(first.records[0].trafficFailures[0].category,category);
 if(category==='TIMEZONE_MISMATCH')assert.equal(first.records[0].trafficFailures[0].timeZone,'America/Los_Angeles');
 const second=await timed(async(req,res)=>{await assert.rejects(get(),{message:'traffic-cooldown'});res.status(503).json({success:false});},request('/admin/api/traffic'));
 assert.equal(calls,1);assert.equal(second.records[0].trafficFailures[0].category,'COOLDOWN');
});
for(const [category,error]of [
 ['UPSTREAM_SCOPE',{response:{status:403,data:{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}}}}],
 ['UPSTREAM_DISABLED',{response:{status:403,data:{error:{details:[{reason:'SERVICE_DISABLED'}]}}}}],
 ['UPSTREAM_PERMISSION',{response:{status:403}}],['UPSTREAM_QUOTA',{response:{status:429}}],
 ['UPSTREAM_TIMEOUT',{code:'ETIMEDOUT'}],['UPSTREAM_NETWORK',{code:'ECONNRESET'}],['UPSTREAM_HTTP',{response:{status:500}}],['UPSTREAM_UNKNOWN',{}],
])test(`통계 ${category}는 SDK 오류 본문·헤더·원문을 기록하지 않는다`,async()=>{
 const get=createTrafficSummaryService({run:async()=>{throw Object.assign(Error('PRIVATE_ERROR'),error,{config:{headers:{authorization:'PRIVATE_TOKEN'}},request:{private:'PRIVATE'}});}});
 const {records}=await timed(async(req,res)=>{await assert.rejects(get(),{message:'traffic-summary-unavailable'});res.status(503).json({success:false});},request('/admin/api/traffic'));
 assert.equal(records[0].trafficFailures[0].category,category);assert.doesNotMatch(JSON.stringify(records),/PRIVATE|authorization|config|message/);
});
test('시간대는 IANA로 검증하며 임의 문자열·추가 필드·과다 오류는 제외한다',async()=>{
 const {records}=await timed(async()=>{for(let i=0;i<4;i++)recordTrafficFailure({category:'TIMEZONE_MISMATCH',timeZone:'PRIVATE_TOKEN',report:'current',private:'PRIVATE'});});
 assert.equal(records[0].trafficFailures.length,2);assert.equal(records[0].trafficFailures[0].timeZone,'invalid');assert.doesNotMatch(JSON.stringify(records),/PRIVATE/);
});

test('정상 통계의 진행 중 공유·캐시를 구분하고 GA를 중복 실행하지 않는다',async()=>{
 let finish,calls=0;const get=createTrafficSummaryService({run:()=>{calls++;return new Promise(r=>finish=r);}});
 const handler=async(req,res)=>res.json(await get());
 const first=timed(handler,request('/admin/api/traffic')),second=timed(handler,request('/admin/api/traffic'));finish(reports());
 const results=await Promise.all([first,second]);assert.equal(calls,1);assert(results[1].records[0].spans.some(s=>s.name==='admin.traffic.shared'));
 const third=await timed(handler,request('/admin/api/traffic'));assert(third.records[0].spans.some(s=>s.name==='admin.traffic.cache'));assert.equal(calls,1);
});

test('안전한 헤더 진단은 고정 열·순서·유형만 기록하며 값/임의 이름은 남기지 않는다',async()=>{
 const {recordTrafficSchema}=require('../services/adminRequestTiming');
 const {records:[output]}=await timed(async()=>{
  const r=reports();r.reports[0].metricHeaders=[{name:'sessions',type:'TYPE_INTEGER'},{name:'activeUsers',type:'TYPE_INTEGER'},{name:'screenPageViews',type:'TYPE_INTEGER'}];
  const data=await createTrafficSummaryService({run:async()=>r})();assert.equal(data.current.sessions,0);
  recordTrafficSchema('current',{metricHeaders:[{name:'PRIVATE_ACCOUNT',type:'PRIVATE_TYPE'}],rows:[{private:'PRIVATE_DATA'}]});
 });
 assert.equal(output.trafficSchemas.length,3);
 assert.deepEqual(output.trafficSchemas[0].metricHeaders.map(x=>x.name),['sessions','activeUsers','screenPageViews']);
 assert.doesNotMatch(JSON.stringify(output),/PRIVATE_ACCOUNT|PRIVATE_TYPE|PRIVATE_DATA/);
 const {records:[extra]}=await timed(()=>recordTrafficSchema('current',{metricHeaders:[{name:'PRIVATE_ACCOUNT',type:'PRIVATE_TYPE'}]}));
 assert.deepEqual(extra.trafficSchemas[0].metricHeaders,[{name:'other',type:'other'}]);
});
