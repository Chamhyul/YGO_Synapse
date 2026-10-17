'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWriterHistoryMaintenanceHandler}=require('../services/writerHistoryMaintenance');

function fixture(compact, clock=()=>0){
  let closed=0,calls=0;const logs=[];
  const handler=createWriterHistoryMaintenanceHandler({clock,log:value=>logs.push(value),createRuntime:()=>({
    getProfileWriterBinding:()=>({transition:{withSession:fn=>fn(),compact:async options=>{assert.deepEqual(options,{limit:4});calls++;return compact(calls);}}}),
    closeProfileWriterRuntime:async()=>{closed++;},
  })});
  return {handler,logs,get closed(){return closed;},get calls(){return calls;}};
}
test('worker는 최대16건/4묶음만 기다리고 다음 예약 실행에 나머지를 남긴다',async()=>{
  const f=fixture(()=>({moved:4,removedEvents:4}));const result=await f.handler();
  assert.equal(result.moved,16);assert.equal(f.calls,4);assert.equal(f.closed,1);assert.equal(f.logs.length,1);
  assert.deepEqual(Object.keys(result).sort(),['durationMs','event','moved','passes','removedEvents']);
});
test('worker는 유휴에서 멈추고 시간 예산이 지나면 다음 묶음을 시작하지 않는다',async()=>{
  const idle=fixture(()=>({moved:0,removedEvents:0}));await idle.handler();assert.equal(idle.calls,1);assert.equal(idle.closed,1);
  let now=0;const busy=fixture(()=>{now=46000;return {moved:4,removedEvents:0};},()=>now);
  await busy.handler();assert.equal(busy.calls,1);assert.equal(busy.closed,1);
});
test('보관 장애는 성공으로 삼지 않으며 오류 원문 없이 재시도하고 연결을 닫는다',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('synthetic private detail'),{code:'USER_STORAGE_WRITE_AMBIGUOUS'});});
  await assert.rejects(f.handler(),error=>error.code==='USER_STORAGE_WRITE_AMBIGUOUS'&&!error.message.includes('private'));
  assert.equal(f.closed,1);assert.equal(f.logs.length,0);
});
test('예약 정의는 단일 동시 실행·제한 재시도·기존 Job 계정을 유지한다',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),exports={};
  vm.runInNewContext(fs.readFileSync(require.resolve('../schedules/userWriterHistory'),'utf8'),{exports,process:{env:{GCLOUD_PROJECT:'ygo-synapse'}},require:name=>name==='firebase-functions/v2/scheduler'?{onSchedule:(options,handler)=>({options,handler})}:{createWriterHistoryMaintenanceHandler:()=>()=>{}}});
  const options=exports.compactUserWriterHistory.options;
  assert.equal(options.serviceAccount,'user-storage-writer@ygo-synapse.iam.gserviceaccount.com');
  assert.equal(options.schedule,'* * * * *');assert.equal(options.maxInstances,1);assert.equal(options.concurrency,1);assert.equal(options.retryCount,3);
});
