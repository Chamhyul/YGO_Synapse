'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto');
const {open}=require('../../integration/user-migration/connection.cjs');
const {createWriterJournalStore}=require('../services/user-storage/writerJournalStore');
const {createWriterHistoryStore}=require('../services/user-storage/writerHistoryStore');
const {createPartitionedInventoryStore}=require('../services/user-storage/partitionedInventoryStore');
const {encodeKey}=require('../services/user-storage/codec');
const id=()=>randomBytes(16).toString('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
test('실제 SDK의 보관 완료·현재 미확정 우선순위와 전체 이력 변조 검증을 유지한다',async()=>{
 const run=id(),operation=id(),c=open(run),journal=createWriterJournalStore({database:c.targetDatabase}),history=createWriterHistoryStore({database:c.targetDatabase,runId:run});
 const completed={id:operation,status:'completed',backend:'rtdb',epoch:1,resources:['fs/users/synthetic']};
 const state={format:1,backend:'rtdb',epoch:1,phase:'accepting',sequence:0,operations:{},events:[],frozen:{},external:{}};
 try{
  await journal.compareAndSet(run,0,state);await history.put('external',operation,completed);
  assert.deepEqual(await journal.readExternalWithFallback(run,operation,()=>history.get('external',operation)),completed);
  await journal.update(run,current=>({value:{...current,external:{[operation]:{...completed,status:'running'}}}}));
  let archives=0;const hot=await journal.readExternalWithFallback(run,operation,()=>{archives++;throw Error('archive');});
  assert.equal(hot.status,'running');assert.equal(archives,0);
  await journal.update(run,current=>({value:{...current,external:{}}}));
  const ref=c.targetDatabase.ref(`profileWriterHistory/${encodeKey(run)}/external/${encodeKey(operation)}`),raw=(await ref.get()).val();
  // 보관 본문의 전체 digest 검사는 생략하지 않는다.
  raw.payload.value[encodeKey('digest')]='0'.repeat(64);await ref.set(raw);
  await assert.rejects(journal.readExternalWithFallback(run,operation,()=>history.get('external',operation)));
 }finally{await c.close();}
});
test('실제 카드 버전 조회는 진행 중인 느린 요청을 넘겨 읽고 상한·최종 revision을 보존한다',async()=>{
 const c=open(id()),uid='synthetic-'+id(),store=createPartitionedInventoryStore({database:c.targetDatabase}),count=40;
 try{
  await store.update(uid,inventory=>{
   inventory.version=3;inventory.amount=count;inventory.locations={A:count};inventory.rarities={N:count};
   inventory.cards=Object.fromEntries(Array.from({length:count},(_,i)=>['S-'+i,{name:'합성',cid:'cid-'+i,items:[{rarity:'N',qty:1,loc:'A',illustration:'1'}]}]));
  });
  const gate=deferred(),started=deferred();let reads=0,active=0,peak=0,revisionReads=0;
  const db={ref(path){const ref=c.targetDatabase.ref(path);return new Proxy(ref,{get(target,key){
   if(key==='get')return async()=>{
    if(path.includes('inventoryCardVersions/')){const nth=++reads;active++;peak=Math.max(peak,active);if(nth===17)started.resolve();try{if(nth===1)await gate.promise;return await target.get();}finally{active--;}}
    if(path.endsWith('/revision'))revisionReads++;return target.get();
   };const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});}};
  const result=createPartitionedInventoryStore({database:db}).read(uid);
  await started.promise;assert.equal(revisionReads,0);gate.resolve();
  const record=await result;assert.equal(record.value.amount,count);assert.equal(reads,count);assert(peak<=16);assert.equal(active,0);assert.equal(revisionReads,1);
 }finally{await c.close();}
});
