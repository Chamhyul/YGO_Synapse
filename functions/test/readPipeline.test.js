'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWriterJournalStore}=require('../services/user-storage/writerJournalStore');
const {createPartitionedInventoryStore}=require('../services/user-storage/partitionedInventoryStore');
const {splitInventory,cardBlobPath}=require('../services/user-storage/inventoryManifest');
const {encodeKey,encodeValue}=require('../services/user-storage/codec');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
function journalFixture({raw=null,head={},legacy}={}){
 const run='1'.repeat(32),id='2'.repeat(32),base=`journal/${encodeKey(run)}`,calls=[],gates=new Map();
 const values=new Map([[`${base}/body/value/${encodeKey('external')}/${encodeKey(id)}`,raw],[`${base}/head`,head],[base,legacy]]);
 const database={ref(path){return{async get(){calls.push(path);if(gates.has(path))await gates.get(path).promise;return{val:()=>values.get(path)??null};}};}};
 return{store:createWriterJournalStore({database,path:'journal'}),run,id,base,calls,gates};
}
test('현재 완료 기록이 없을 때만 헤더와 보관 원문 검증을 겹친다',async()=>{
 const f=journalFixture(),header=deferred(),archive=deferred(),op={id:f.id,status:'completed'};let archiveStarted=false,finished=false;
 f.gates.set(f.base+'/head',header);
 const result=f.store.readExternalWithFallback(f.run,f.id,()=>{archiveStarted=true;return archive.promise;}).then(v=>{finished=true;return v;});
 await tick();assert(archiveStarted);assert(f.calls.includes(f.base+'/head'));assert(!finished);
 archive.resolve(op);await tick();assert(!finished);header.resolve();assert.deepEqual(await result,op);assert.equal(f.calls.length,2);
});
test('현재 기록이 있으면 보관 조회·추가 헤더 조회 없이 기존 우선순위를 유지한다',async()=>{
 const id='2'.repeat(32),op={id,status:'running'},raw=encodeValue(op).value;
 const f=journalFixture({raw});let archives=0;
 assert.deepEqual(await f.store.readExternalWithFallback(f.run,id,()=>{archives++;throw Error('archive');}),op);
 assert.equal(archives,0);assert.equal(f.calls.length,1);
});
test('구형 원본이 있으면 보관 실패보다 원본을 우선하고 보관이 필요하면 실패를 전파한다',async()=>{
 const id='2'.repeat(32),op={id,status:'running'},legacy={format:1,revision:1,generation:0,tombstone:false,payload:encodeValue({external:{[id]:op}})};
 const f=journalFixture({head:null,legacy});assert.deepEqual(await f.store.readExternalWithFallback(f.run,id,async()=>{throw Error('archive');}),op);
 const modern=journalFixture();await assert.rejects(modern.store.readExternalWithFallback(modern.run,id,async()=>{throw Error('archive');}),/archive/);
 assert.equal(await modern.store.readExternal(modern.run,id),undefined);
});
test('헤더 실패도 시작한 보관 검증이 끝나기 전에 반환하지 않는다',async()=>{
 const f=journalFixture(),gate=deferred();f.gates.set(f.base+'/head',{promise:Promise.reject(Error('header'))});
 let finished=false;const result=f.store.readExternalWithFallback(f.run,f.id,()=>gate.promise).catch(e=>{finished=true;assert.match(e.message,/header/);});
 await tick();assert(!finished);gate.resolve();await result;assert(finished);
});
function inventoryFixture(count=33,{missing=false,revisionChange=false}={}){
 const uid='synthetic',gate=deferred(),cards=Object.fromEntries(Array.from({length:count},(_,i)=>['S-'+i,{name:'합성',cid:'cid-'+i,items:[{rarity:'N',qty:1,loc:'A',illustration:'1'}]}]));
 const candidate=splitInventory({inventory:{version:3,amount:count,locations:{A:count},rarities:{N:count},cards},locationState:{locationNames:{},nextLocationId:1}},{uid});
 const base=`inventories/${encodeKey(uid)}`,raw={format:1,revision:1,generation:0,tombstone:false,payload:candidate.manifest};
 const blobs=new Map(candidate.blobs.map((b,i)=>[cardBlobPath(uid,b.hash,candidate.manifest.cards[b.hash].v),{value:b.value,index:i}]));
 let active=0,max=0,started=0,revisionReads=0;
 const store=createPartitionedInventoryStore({maxAttempts:1,database:{ref(path){return{async get(){
  if(path===base)return{val:()=>raw};
  if(path===base+'/revision'){revisionReads++;return{val:()=>revisionChange?2:1};}
  assert(blobs.has(path),path);const entry=blobs.get(path);active++;started++;max=Math.max(max,active);
  if(entry.index===0)await gate.promise;else await tick();active--;
  return{val:()=>missing&&entry.index===16?null:entry.value};
 }};}}});
 return{store,uid,gate,counts:()=>({active,max,started,revisionReads})};
}
test('늦은 카드1건이 있어도 빈 자리에 다음 카드를 조회하며 상한16과 최종 revision 순서를 유지한다',async()=>{
 const f=inventoryFixture(),result=f.store.read(f.uid);await tick();await tick();
 assert(f.counts().started>16);assert(f.counts().max<=16);assert.equal(f.counts().revisionReads,0);
 f.gate.resolve();const record=await result;assert.equal(record.value.amount,33);assert.equal(Object.keys(record.value.cards).length,33);
 assert.equal(f.counts().started,33);assert.equal(f.counts().revisionReads,1);assert.equal(f.counts().active,0);
});
test('카드 누락도 진행 중 조회를 회수한 뒤 revision 대조·기존 오류로 반환한다',async()=>{
 const f=inventoryFixture(65,{missing:true});let finished=false;
 const result=f.store.read(f.uid).catch(e=>{finished=true;assert.equal(e.code,'USER_STORAGE_MISSING_CARD_VERSION');});
 await tick();await tick();await tick();assert(!finished);assert(f.counts().max<=16);f.gate.resolve();await result;
 assert.equal(f.counts().active,0);assert.equal(f.counts().revisionReads,1);assert(f.counts().started<65);
});
test('조회 도중 revision 변경은 혼합된 성공 응답으로 반환하지 않는다',async()=>{
 const f=inventoryFixture(17,{revisionChange:true}),result=f.store.read(f.uid);f.gate.resolve();await assert.rejects(result,{code:'USER_STORAGE_CONFLICT'});
});
