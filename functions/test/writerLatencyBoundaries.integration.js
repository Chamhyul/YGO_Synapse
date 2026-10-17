'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createWriterHistoryStore } = require('../services/user-storage/writerHistoryStore');
const { createWriterPlanStore } = require('../services/user-storage/writerPlanStore');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createUserWriterTransition, createTransitionWriter } = require('../services/userWriterTransition');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
function meter(database) {
  const original = database.ref, calls = { get: 0, on: 0, off: 0, transaction: 0 };
  database.ref = path => {
    const ref = original(path);
    return new Proxy(ref, { get(o,k) { const value = o[k]; if (typeof value !== 'function') return value;
      return (...args) => { if (k in calls) calls[k]++; return value.apply(o,args); }; } });
  };
  return { calls, close: () => { database.ref = original; } };
}
test('불변 최초 생성은 두 SDK 중 하나만 승인하고 기존 자료·revision을 덮어쓰지 않는다', async () => {
  const run = id(), a = open(run), b = open(run);
  try {
    const sa = createRecordStore({database:a.targetDatabase,path:'immutableTest'}), sb = createRecordStore({database:b.targetDatabase,path:'immutableTest'});
    const results = await Promise.allSettled([sa.createIfAbsent('item',{source:'a'}),sb.createIfAbsent('item',{source:'b'})]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.code,'USER_STORAGE_CONFLICT');
    const saved = await sb.read('item'); assert.equal(saved.revision,1);
    await assert.rejects(sa.createIfAbsent('item',{source:'replacement'}),{code:'USER_STORAGE_CONFLICT'});
    assert.deepEqual(await sb.read('item'),saved);
    await sb.delete('item',1); await assert.rejects(sa.createIfAbsent('item',{source:'recreated'}),{code:'USER_STORAGE_CONFLICT'});
    assert.equal((await sb.read('item')).generation,1);
  } finally { await Promise.all([a.close(),b.close()]); }
});
test('명령 구독은 한 번만 열고 CAS 경합·명령 종료·예외에서 새 값과 정리를 보장한다', async () => {
  const run=id(),a=open(run),b=open(run);
  try {
    const store=createRecordStore({database:a.targetDatabase,path:'sessionTest'}),other=createRecordStore({database:b.targetDatabase,path:'sessionTest'});
    await store.createIfAbsent('item',{n:0}); const m=meter(a.targetDatabase);
    try {
      await store.withSession(async()=>{
        let current=await store.read('item');
        current=await store.compareAndSet('item',current.revision,{n:1});
        current=await store.compareAndSet('item',current.revision,{n:2});
        await other.compareAndSet('item',current.revision,{n:3});
        await assert.rejects(store.compareAndSet('item',current.revision,{n:999}),{code:'USER_STORAGE_CONFLICT'});
        assert.equal((await store.read('item')).value.n,3);
      });
      assert.equal(m.calls.on,1);assert.equal(m.calls.off,1);assert.equal(m.calls.get,2);
      await assert.rejects(store.withSession(async()=>{await store.read('item');throw Error('synthetic');}));
      assert.equal(m.calls.on,2);assert.equal(m.calls.off,2);
    } finally {m.close();}
    await other.compareAndSet('item',4,{n:4});assert.equal((await store.read('item')).value.n,4);
  } finally {await Promise.all([a.close(),b.close()]);}
});
test('명령의 첫 읽기는 오래된 구독 캐시가 있어도 서버 get의 최신값을 반환한다',async()=>{
  const run=id(),a=open(run);
  try{
    const actual=createRecordStore({database:a.targetDatabase,path:'freshSession'});await actual.createIfAbsent('item',{n:0});
    const stale=await a.targetDatabase.ref('freshSession/'+encodeKey('item')).get();await actual.compareAndSet('item',1,{n:9});
    const database={ref:path=>{const ref=a.targetDatabase.ref(path);return new Proxy(ref,{get(o,k){if(k==='on')return(_event,callback)=>{callback(stale);};if(k==='off')return()=>{};const v=o[k];return typeof v==='function'?v.bind(o):v;}});}};
    const store=createRecordStore({database,path:'freshSession'});
    await store.withSession(async()=>assert.equal((await store.read('item')).value.n,9));
  }finally{await a.close();}
});
test('불변 최초 생성의 승인 시간초과는 연결을 차단하고 새 연결의 실제 결과를 보존한다', async () => {
  const run=id(),a=open(run),b=open(run);let release;
  try {
    let entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const database={ref:path=>{const ref=a.targetDatabase.ref(path);return new Proxy(ref,{get(o,k){if(k==='transaction')return async(...args)=>{const saved=await o.transaction(...args);entered();await gate;return saved;};const v=o[k];return typeof v==='function'?v.bind(o):v;}});}};
    const store=createRecordStore({database,path:'ambiguousImmutable',timeoutMs:100});
    const pending=store.createIfAbsent('item',{kept:true});await ready;
    await assert.rejects(pending,{code:'USER_STORAGE_WRITE_AMBIGUOUS'});
    await assert.rejects(store.createIfAbsent('second',{}),{code:'USER_STORAGE_WRITE_AMBIGUOUS'});
    release();assert.equal((await createRecordStore({database:b.targetDatabase,path:'ambiguousImmutable'}).read('item')).value.kept,true);
  } finally {release?.();await Promise.all([a.close(),b.close()]);}
});
async function preparedHistory(count=12) {
  const runId=id(),connection=open(runId),database=connection.targetDatabase;
  const binding=createUserInventoryWriterBinding({db:connection.db,database,bucket:connection.bucket,FieldValue,runId,config:connection.config,migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
  await binding.initialize();
  const journal=createWriterJournalStore({database}),history=createWriterHistoryStore({database,runId}),plans=createWriterPlanStore({database,runId});
  // 정상 명령으로 자료를 만든다. v8 이전 자동 보관 목표를 주입해 큰 hot 이력만 구성한다.
  const old=createUserWriterTransition({journal:{...journal,withSession:undefined},history,plans,runId,stores:binding.stores,checkKey:()=>{}});
  const writer=await old.route(),ops=[];
  for(let n=0;n<count;n++){
    const op=id(),before=await binding.stores.legacy.read('fs/users/synthetic');
    await createTransitionWriter(old,writer).write(op,[{key:'fs/users/synthetic',exists:true,token:before.token,value:{n,text:'x'.repeat(8192)}}],null,{details:{kind:'profile',serverTimestampPaths:[]}});ops.push(op);
  }
  const create=(h=history,options={})=>createUserWriterTransition({journal,history:h,plans,runId,stores:binding.stores,checkKey:()=>{},...options});
  return{connection,runId,journal,history,writer,binding,create,ops,close:()=>connection.close()};
}
test('큰 hot의 자동 보관은 최대4건·동시4건으로 제한하고 나머지 완료 원문을 유지한다',async()=>{
  const f=await preparedHistory();let release;
  try {
    const before=await f.journal.read(f.runId);let active=0,peak=0,started=0,entered;
    const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const history={...f.history,put:async(...args)=>{started++;active++;peak=Math.max(peak,active);if(started===4)entered();await gate;try{return await f.history.put(...args);}finally{active--;}}};
    const transition=f.create(history),key='fs/users/next',op=id();
    const pending=transition.prepare(f.writer,op,[{key,exists:true,token:'0',value:{ready:true}}]);
    await ready;assert.equal(started,4);release();await pending;
    assert.equal(started,4);assert.equal(peak,4);
    const after=await f.journal.read(f.runId);assert.equal(Object.keys(after.value.operations).length,Object.keys(before.value.operations).length-4+1);
    for(const previous of f.ops)assert.ok(after.value.operations[previous]||await f.history.get('operations',previous));
    await transition.cancelPrepared(f.writer,op);
    assert.equal((await f.binding.stores.legacy.read('fs/users/synthetic')).value.n,11);
  }finally{release?.();await f.close();}
});
test('병렬 보관 일부 실패는 시작된 작업을 기다리고 hot을 남겨 새 SDK에서 재개한다',async()=>{
  const f=await preparedHistory(8);let release;
  try {
    const before=await f.journal.read(f.runId);let count=0,entered,settled=false;
    const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const history={...f.history,put:async(...args)=>{const n=++count;if(n===4)entered();await gate;if(n===1)throw undefined;return f.history.put(...args);}};
    const pending=f.create(history).compact({limit:4});pending.then(()=>{settled=true;},()=>{settled=true;});
    await ready;assert.equal(settled,false);release();await assert.rejects(pending);
    assert.deepEqual(await f.journal.read(f.runId),before);
    const second=open(f.runId);
    try{
      const fresh=createWriterHistoryStore({database:second.targetDatabase,runId:f.runId});
      await f.create(fresh).compact({limit:4});
      for(const previous of f.ops)assert.ok((await f.journal.read(f.runId)).value.operations[previous]||await fresh.get('operations',previous));
      assert.equal((await f.binding.stores.legacy.read('fs/users/synthetic')).value.n,7);
    }finally{await second.close();}
  }finally{release?.();await f.close();}
});
test('64KiB를 넘는 작은 완료 기록은4건씩 모아 매 수정의 보관을 피한다',async()=>{
  const f=await preparedHistory(3);
  try{
    const transition=f.create(),initial=await transition.historyStatus();assert(initial.hotBytes>64*1024&&initial.hotBytes<512*1024);
    for(let n=3;n<5;n++){
      const key='fs/users/synthetic',before=await f.binding.stores.legacy.read(key);
      await createTransitionWriter(transition,f.writer).write(id(),[{key,exists:true,token:before.token,value:{n,text:'x'.repeat(8192)}}],null,{details:{kind:'profile',serverTimestampPaths:[]}});
      assert.equal((await transition.historyStatus()).archived.operations,n===3?0:4);
    }
    assert.equal((await f.binding.stores.legacy.read('fs/users/synthetic')).value.n,4);
  }finally{await f.close();}
});

test('deferred 저장은 보관 장애를 기다리지 않고 완료하며 새 worker가 기존 본문을 대조 보관한다',async()=>{
  const f=await preparedHistory(8);
  try{
    let puts=0;
    const transition=f.create({...f.history,put:async()=>{puts++;throw Error('synthetic archive unavailable');}}, {historyMaintenance:'deferred'});
    const before=await f.binding.stores.legacy.read('fs/users/synthetic'),op=id();
    await createTransitionWriter(transition,f.writer).write(op,[{key:before.key,exists:true,token:before.token,value:{n:99}}],null,{details:{kind:'profile',serverTimestampPaths:[]}});
    assert.equal(puts,0);assert.equal((await f.journal.read(f.runId)).value.operations[op].status,'completed');
    const {createWriterHistoryMaintenanceHandler}=require('../services/writerHistoryMaintenance');
    let closed=0;const reports=[];
    const result=await createWriterHistoryMaintenanceHandler({createRuntime:()=>({getProfileWriterBinding:()=>({transition:f.create()}),closeProfileWriterRuntime:async()=>{closed++;}}),log:r=>reports.push(r)})();
    assert.equal(closed,1);assert.equal(result.moved,9);assert.equal(reports.length,1);
    assert.equal((await f.create().historyStatus()).retainedOperations,0);
    for(const previous of [...f.ops,op])assert.ok(await f.history.get('operations',previous));
    assert.equal((await f.binding.stores.legacy.read('fs/users/synthetic')).value.n,99);
    const head=await f.journal.read(f.runId);await f.create().compact({limit:4});
    assert.equal((await f.journal.read(f.runId)).revision,head.revision,'유휴 worker는 CAS하지 않는다');
    await f.create().copy(f.writer);await f.create().drain(f.writer);const active=await f.create().activate(f.writer);
    assert.equal(active.backend,'rtdb');assert.equal((await f.binding.stores.rtdb.read('fs/users/synthetic')).value.n,99);
    await f.create().copy(active);await f.create().drain(active);assert.equal((await f.create().activate(active)).backend,'legacy');
  }finally{await f.close();}
});

test('deferred도 hard 건수 상한에서는 보관을 동기 확정하고 미완료 명령은 잠금과 함께 남긴다',async()=>{
  const f=await preparedHistory(4);
  try{
    let puts=0;const transition=f.create({...f.history,put:async(...args)=>{puts++;await f.history.put(...args);}},{historyMaintenance:'deferred',maxOperations:4});
    const op=id(),key='fs/users/pressure';await transition.prepare(f.writer,op,[{key,exists:true,token:'0',value:{safe:true}}]);
    assert.equal(puts,4);assert.equal((await f.journal.read(f.runId)).value.operations[op].status,'prepared');
    await transition.compact({limit:4});
    assert.equal((await f.journal.read(f.runId)).value.operations[op].status,'prepared');
    assert.equal(await f.history.get('operations',op),undefined);
    await assert.rejects(transition.prepare(f.writer,id(),[{key,exists:true,token:'0',value:{other:true}}]),{code:'WRITER_RESOURCE_BUSY'});
    await transition.cancelPrepared(f.writer,op);
  }finally{await f.close();}
});
