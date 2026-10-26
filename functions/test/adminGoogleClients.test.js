'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 let factory;const loads=[],calls=[];
 const mocks={
 'firebase-functions/v2/https':{onRequest:(_o,h)=>h},'node:fs/promises':{},'node:path':require('node:path'),
 '../../services/adminPageRuntime':{createAdminRouteHandlers:options=>{factory=options.productionDependencies;return{};}},
 '../../services/adminTransport':{createAdminProxy:()=>{},createLocalAdminRenderer:()=>{}},
 '../../config/firebase':{admin:{auth:()=>({}),storage:()=>({bucket:()=>({})})},db:{}},
 '../../services/adminErrorSummary':{createErrorSummaryService:x=>x.list},
 '../../services/adminTrafficSummary':{createTrafficSummaryService:x=>x.run},
 '../../services/noticeService':{createNoticeService:()=>({}),createStorageNoticeStore:()=>({})},
 '../../services/membershipCsvService':{createMembershipCsvService:()=>({})},
 '../../services/membershipCsvRepository':{getMembershipCsvStore:()=>({})},
 'google-auth-library':{GoogleAuth:class{constructor(options){calls.push(options.scopes);}}},
 'googleapis/build/src/apis/analyticsdata':{analyticsdata:options=>{calls.push(options.version);return{properties:{batchRunReports:async (request,options)=>{calls.push(options.timeout);return{data:request};}}};}},
 'googleapis/build/src/apis/clouderrorreporting':{clouderrorreporting:options=>{calls.push(options.version);return{projects:{locations:{groupStats:{list:async (request,options)=>{calls.push(options.timeout);return{data:request};}}}}};}},
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../routes/admin/pages'),'utf8'),{exports:{},__dirname:'/synthetic/routes/admin',require:name=>{loads.push(name);assert(name in mocks, name);return mocks[name];}});
 return{dependencies:factory(),loads,calls};
}
test('로그인·세션·공지·CSV 의존성 준비는 Google 통계 SDK를 로딩하지 않는다',()=>{
 const f=fixture();assert(!f.loads.some(x=>x.includes('googleapis')||x==='google-auth-library'));
 assert.equal(typeof f.dependencies.getTrafficSummary,'function');assert.equal(typeof f.dependencies.getErrorSummary,'function');
});
test('통계별 하위 SDK를 첫 요청에만 생성하고 기존 OAuth 범위·timeout을 유지한다',async()=>{
 const f=fixture();await f.dependencies.getTrafficSummary([]);await f.dependencies.getTrafficSummary([]);
 assert.equal(f.loads.filter(x=>x==='googleapis/build/src/apis/analyticsdata').length,1);
 assert(!f.loads.includes('googleapis/build/src/apis/clouderrorreporting'));
 await f.dependencies.getErrorSummary({period:'PERIOD_1_DAY'});await f.dependencies.getErrorSummary({period:'PERIOD_1_DAY'});
 assert.equal(f.loads.filter(x=>x==='googleapis/build/src/apis/clouderrorreporting').length,1);
 assert(!f.loads.includes('googleapis'));assert(f.calls.includes(10000));assert(f.calls.includes(5000));
 assert(f.calls.some(x=>Array.isArray(x)&&x.includes('https://www.googleapis.com/auth/analytics.readonly')));
 assert(f.calls.some(x=>Array.isArray(x)&&x.includes('https://www.googleapis.com/auth/cloud-platform')));
});
test('고정 설치 SDK의 하위 factory와 API 메서드가 실제로 존재한다',()=>{
 const {GoogleAuth}=require('google-auth-library');
 const traffic=require('googleapis/build/src/apis/analyticsdata').analyticsdata({version:'v1beta',auth:new GoogleAuth({scopes:['https://www.googleapis.com/auth/analytics.readonly']})});
 const errors=require('googleapis/build/src/apis/clouderrorreporting').clouderrorreporting({version:'v1beta1',auth:new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']})});
 assert.equal(typeof traffic.properties.batchRunReports,'function');assert.equal(typeof errors.projects.locations.groupStats.list,'function');
 assert(!Object.keys(require.cache).some(p=>p.endsWith('/googleapis/build/src/index.js')));
});
