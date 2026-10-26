const test=require('node:test');const assert=require('node:assert/strict');
const {createTrafficSummaryService}=require('../services/adminTrafficSummary');
const time=Date.parse('2026-10-07T04:00:00Z');
const report=(metrics,rows=[],dimensions=[])=>({metricHeaders:metrics.map(name=>({name})),dimensionHeaders:dimensions.map(name=>({name})),metadata:{timeZone:'Asia/Seoul'},rowCount:rows.length,rows});
const row=(values,date)=>({metricValues:values.map(value=>({value:String(value)})),...(date?{dimensionValues:[{value:date}]}:{})});
const result=()=>({reports:[report(['activeUsers','sessions','screenPageViews'],[row([1,2,3])]),report(['activeUsers','sessions','screenPageViews']),report(['activeUsers'],[row([7],'20261001')],['date'])]});
test('오늘/어제/30일 보고서를 독립 조회하며 운영 호스트·관리자 제외 필터를 적용한다',async()=>{
 let requests;const data=await createTrafficSummaryService({now:()=>time,run:async r=>{requests=r;return result();}})();
 assert.deepEqual(requests.map(r=>r.dateRanges[0]),[{startDate:'2026-10-07',endDate:'2026-10-07'},{startDate:'2026-10-06',endDate:'2026-10-06'},{startDate:'2026-09-08',endDate:'2026-10-07'}]);
 assert.equal(requests[0].dimensionFilter.andGroup.expressions[0].filter.stringFilter.value,'ygo-synapse.web.app');
 const pattern=new RegExp(requests[0].dimensionFilter.andGroup.expressions[1].notExpression.filter.stringFilter.value);
 assert.ok(pattern.test('/admin/settings'));assert.ok(pattern.test('/admin.html'));assert.equal(pattern.test('/administrator'),false);
 assert.deepEqual(data.current,{activeUsers:1,sessions:2,screenPageViews:3});assert.deepEqual(data.previous,{activeUsers:0,sessions:0,screenPageViews:0});
 assert.equal(data.daily.length,30);assert.equal(data.daily[23].value,7);assert.equal(data.daily[0].value,0);assert.equal(data.daily.at(-1).date,'2026-10-07');
});
test('불완전·시간대 불일치·잘못된 건수/날짜/중복 날짜는 확정0건으로 대체하지 않는다',async()=>{
 for(const change of [r=>{r.reports=[];},r=>{r.reports[0].metadata.timeZone='America/Los_Angeles';},r=>{r.reports[0].rows[0].metricValues[0].value='-1';},r=>{delete r.reports[0].rows[0].metricValues;},r=>{r.reports[2].rows[0].dimensionValues[0].value='20260931';},r=>{r.reports[2].rows.push(r.reports[2].rows[0]);r.reports[2].rowCount=2;}]) {
 const r=result();change(r);await assert.rejects(createTrafficSummaryService({now:()=>time,run:async()=>r})(),{message:'traffic-summary-unavailable'});
 }
});
test('캐시·진행 중 중복 공유와 실패 재시도 제한을 적용하고 날짜가 바뀌면 캐시를 새로 읽는다',async()=>{
 let now=Date.parse('2026-10-07T14:59:50Z'),calls=0,done,fail=false;
 const get=createTrafficSummaryService({now:()=>now,run:async()=>{calls++;if(fail)throw Error('private-secret');return new Promise(r=>{done=r;});}});
 const one=get(),two=get();const empty=()=>({reports:[report(['activeUsers','sessions','screenPageViews']),report(['activeUsers','sessions','screenPageViews']),report(['activeUsers'],[],['date'])]});done(empty());await Promise.all([one,two]);await get();assert.equal(calls,1);
 now+=11000;const next=get();done(empty());assert.equal((await next).today,'2026-10-08');assert.equal(calls,2);
 now+=60000;fail=true;await assert.rejects(get());await assert.rejects(get());assert.equal(calls,3);
});
test('GA4 제한 메타데이터는 표시용 플래그만 전달한다',async()=>{
 const r=result();r.reports[0].metadata.subjectToThresholding=true;r.reports[0].metadata.private='secret';
 const data=await createTrafficSummaryService({now:()=>time,run:async()=>r})();assert.equal(data.limited,true);assert.doesNotMatch(JSON.stringify(data),/private|secret/);
});

test('반환된 지표 열 순서가 달라도 이름으로 값을 연결한다',async()=>{
 const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
 for(const order of permutations){
  const r=result(), current=r.reports[0];
  current.metricHeaders=order.map(i=>({name:['activeUsers','sessions','screenPageViews'][i]}));
  current.rows[0].metricValues=order.map(i=>({value:String([11,22,33][i])}));
  assert.deepEqual((await createTrafficSummaryService({now:()=>time,run:async()=>r})()).current,{activeUsers:11,sessions:22,screenPageViews:33});
 }
});
test('이름 매핑은 누락·중복·예상 외·형식 오류를 완화하지 않는다',async()=>{
 for(const headers of [[],[{name:'activeUsers'},{name:'sessions'}],[{name:'activeUsers'},{name:'sessions'},{name:'sessions'}],[{name:'activeUsers'},{name:'sessions'},{name:'totalUsers'}],[{name:'activeUsers'},{name:'sessions'},{}],{}]){
  const r=result();r.reports[0].metricHeaders=headers;
  await assert.rejects(createTrafficSummaryService({now:()=>time,run:async()=>r})(),{message:'traffic-summary-unavailable'});
 }
});

test('정식 GA의 헤더/행 생략 0행 보고서만 정상 빈 집계로 취급한다',async()=>{
 const empty=()=>({kind:'analyticsData#runReport',metadata:{timeZone:'Asia/Seoul'}});
 const r=result();r.reports[0]=empty();r.reports[1]={...empty(),rowCount:0,rows:[],metricHeaders:[],dimensionHeaders:[]};r.reports[2]=empty();
 const data=await createTrafficSummaryService({now:()=>time,run:async()=>r})();
 assert.deepEqual(data.current,{activeUsers:0,sessions:0,screenPageViews:0});assert.equal(data.daily.length,30);assert.ok(data.daily.every(row=>row.value===0));
 for(const change of [x=>delete x.kind,x=>x.kind='invalid',x=>x.rowCount=1,x=>x.rowCount=null,x=>x.rows={},x=>x.rows=[{metricValues:[{value:'4'}]}],x=>x.metricHeaders=null,x=>x.metricHeaders=[{name:'activeUsers'}],x=>x.metadata.timeZone='UTC',x=>x.totals=[{metricValues:[{value:'4'}]}]]){
  const bad=result();bad.reports[0]=empty();change(bad.reports[0]);await assert.rejects(createTrafficSummaryService({now:()=>time,run:async()=>bad})(),{message:'traffic-summary-unavailable'});
 }
});
