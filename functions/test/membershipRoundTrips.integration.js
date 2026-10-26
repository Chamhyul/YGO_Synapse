'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,createHash}=require('node:crypto');
const {FieldValue}=require('firebase-admin/firestore');
const {open}=require('../../integration/user-migration/connection.cjs');
const {createCustomClaimsStore}=require('../services/user-storage/customClaimsStore');
const {createRecordStore}=require('../services/user-storage/recordStore');
const {createUserInventoryWriterBinding}=require('../services/userInventoryWriterRepository');
const id=()=>randomBytes(16).toString('hex');
function instrument(database,{ambiguousFinish=false}={}){
 const counts={get:0,on:0,off:0,transaction:0},overlap=[];let reads=0;
 const wrapped={ref(path){const ref=database.ref(path);return new Proxy(ref,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(!Object.hasOwn(counts,key))return value.bind(target);
  return(...args)=>{counts[key]++;
   if(key==='get'){reads++;return Promise.resolve(value.apply(target,args)).finally(()=>reads--);}
   if(key==='on')overlap.push(reads>0);
   const result=value.apply(target,args);
   if(key==='transaction'&&ambiguousFinish&&counts.transaction===2)return Promise.resolve(result).then(()=>{throw Object.assign(Error('synthetic ACK loss'),{code:'USER_STORAGE_WRITE_AMBIGUOUS'});});
   return result;
  };}});}};
 return{wrapped,counts,overlap};
}
test('claims 요청 세션은 획득 ACK의 revision으로 종료하며 get2→1·구독2→1, 서버 CAS2회 유지',async()=>{
 const c=open(id());try{
  for(const scoped of [false,true]){
   const f=instrument(c.targetDatabase),s=createCustomClaimsStore({database:f.wrapped}),uid=id();
   const work=async()=>{const op=await s.acquire(uid);await s.finish(uid,op);};
   if(scoped)await s.withSession(work);else await work();
   assert.deepEqual(f.counts,{get:scoped?1:2,on:scoped?1:2,off:scoped?1:2,transaction:2});
   const actual=await createRecordStore({database:c.targetDatabase,path:'customClaimsSync'}).read(uid);assert.equal(actual.value.state,'idle');assert.equal(actual.revision,2);assert.equal(actual.generation,0);
  }
 }finally{await c.close();}
});
test('잠금 영수증은 요청 밖에서 재사용되지 않고 다른 UID·다른 operation 종료를 허용하지 않는다',async()=>{
 const c=open(id());try{const f=instrument(c.targetDatabase),s=createCustomClaimsStore({database:f.wrapped}),uid=id();
  const op=await s.withSession(()=>s.acquire(uid));await s.withSession(()=>s.finish(uid,op));assert.equal(f.counts.get,2);
  await s.withSession(async()=>{const next=await s.acquire(uid);await assert.rejects(s.finish(id(),next),{code:'MEMBERSHIP_CLAIMS_BUSY'});await assert.rejects(s.finish(uid,id()),{code:'MEMBERSHIP_CLAIMS_BUSY'});await s.finish(uid,next);});
  assert.equal((await s.inspect(uid)).state,'idle');
 }finally{await c.close();}
});
test('획득 뒤 레코드가 바뀌면 확정 충돌에서만 fresh 조회하고 최신 값을 보존한다',async()=>{
 const c=open(id());try{const f=instrument(c.targetDatabase),s=createCustomClaimsStore({database:f.wrapped}),uid=id();
  await s.withSession(async()=>{const op=await s.acquire(uid),records=createRecordStore({database:c.targetDatabase,path:'customClaimsSync'});
   await records.update(uid,value=>({value:{...value,startedAt:value.startedAt+100}}));const changed=(await records.read(uid)).value;
   await s.finish(uid,op);const after=(await records.read(uid)).value;assert.equal(after.startedAt,changed.startedAt);assert.equal(after.state,'idle');assert(f.counts.get>=2);
  });
 }finally{await c.close();}
});
test('종료 ACK 유실은 재조회·재제출하지 않고 미확정 오류를 전달한다',async()=>{
 const c=open(id());try{const f=instrument(c.targetDatabase,{ambiguousFinish:true}),s=createCustomClaimsStore({database:f.wrapped}),uid=id();
  await assert.rejects(s.withSession(async()=>{const op=await s.acquire(uid);await s.finish(uid,op);}),{code:'USER_STORAGE_WRITE_AMBIGUOUS'});
  assert.deepEqual(f.counts,{get:1,on:1,off:1,transaction:2});assert.equal((await createCustomClaimsStore({database:c.targetDatabase}).inspect(uid)).state,'idle');
 }finally{await c.close();}
});
test('불확실한 Auth 결과는 scoped 영수증 경로에서도 uncertain 잠금을 유지한다',async()=>{
 const c=open(id());try{const s=createCustomClaimsStore({database:c.targetDatabase}),uid=id();
  await s.withSession(async()=>{const op=await s.acquire(uid);await s.finish(uid,op,true);});assert.equal((await s.inspect(uid)).state,'uncertain');await assert.rejects(s.acquire(uid),{code:'MEMBERSHIP_CLAIMS_BUSY'});
 }finally{await c.close();}
});
test('RTDB 멤버십 문맥 fresh get와 트랜잭션 구독은 병렬 준비하고 성공·거부 모두 해제한다',async()=>{
 const c=open(id());try{
  const f=instrument(c.targetDatabase),b=createUserInventoryWriterBinding({db:c.db,database:f.wrapped,bucket:c.bucket,FieldValue,runId:id(),config:c.config,migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
  await b.initialize();const w=await b.transition.route();await b.transition.copy(w);await b.transition.drain(w);await b.transition.activate(w);
  const uid=id(),now=Date.now(),nonceHash=createHash('sha256').update(id()).digest('hex');
  const reset=()=>{Object.keys(f.counts).forEach(k=>f.counts[k]=0);f.overlap.length=0;};reset();
  await b.membership.start(uid,'discord',{nonceHash,startedAt:now,expiresAt:now+300000,consumed:false,localOnly:false,redirectUri:'https://ygo-synapse.web.app/'});
  // Journal observers are separate; select the adapter alone for exact scope assertions.
  reset();const adapter=b.membershipAdapters.rtdb;
  await adapter.withSession(()=>adapter.context(uid,'discord'));assert.deepEqual(f.counts,{get:1,on:1,off:1,transaction:0});assert.deepEqual(f.overlap,[true]);
  reset();await assert.rejects(adapter.withSession(async()=>{await adapter.context(uid,'discord');throw Error('synthetic reject');}),/synthetic reject/);assert.equal(f.counts.on,f.counts.off);assert.deepEqual(f.overlap,[true]);
  await b.membership.withVerification(uid,'discord',async()=>{await b.membership.consume(uid,'discord',nonceHash);const saved=await b.membership.complete(uid,'discord',nonceHash,{status:'none',type:'discord',levelName:'일반',discordId:'123456789012345678',verificationVersion:2,verificationProvider:'discord',lastChecked:Date.now()});assert.equal(saved.stored,true);});
  assert.equal((await b.transition.inspect()).unresolved,0);
 }finally{await c.close();}
});

test('인증 초기 문맥은 잠금 확보와 겹쳐 읽되 consume 쓰기는 잠금 ACK 이후에만 실행한다', async () => {
  const c = open(id());
  try {
    const f = instrument(c.targetDatabase), runId = id();
    const b = createUserInventoryWriterBinding({ db: c.db, database: f.wrapped, bucket: c.bucket, FieldValue, runId, config: c.config,
      migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } });
    await b.initialize(); const writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
    const uid = id(), nonceHash = createHash('sha256').update(id()).digest('hex'), now = Date.now();
    await b.membership.start(uid, 'discord', { nonceHash, startedAt: now, expiresAt: now+300000, consumed: false, localOnly: true, redirectUri: 'https://ygo-synapse.web.app/' });
    const begin = b.transition.beginExternal; let readsAtBegin, acquired = false;
    const previousGets = f.counts.get;
    b.transition.beginExternal = async (...args) => { readsAtBegin = f.counts.get - previousGets; await new Promise(r => setTimeout(r, 40)); const result = await begin(...args); acquired = true; return result; };
    await b.membership.withVerification(uid, 'discord', async () => { assert(acquired); await b.membership.consume(uid, 'discord', nonceHash); });
    assert(readsAtBegin >= 1, '최초 fresh get를 잠금 시작 전에 제출한다'); assert.equal(f.counts.on, f.counts.off);
    assert.equal((await b.transition.inspect()).unresolved, 0);
  } finally { await c.close(); }
});

test('실제 RTDB 소비·완료 저장 내부 계측은 ACK·재사용·실패 의미를 바꾸지 않는다', async () => {
 const { withMembershipRequestTiming } = require('../services/inventoryRequestTiming');
 const c = open(id());
 try {
  const b = createUserInventoryWriterBinding({db:c.db,database:c.targetDatabase,bucket:c.bucket,FieldValue,runId:id(),config:c.config,historyMaintenance:'deferred',migration:{prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})}});
  await b.initialize();const w=await b.transition.route();await b.transition.copy(w);await b.transition.drain(w);await b.transition.activate(w);
  const uid=id(),nonceHash=createHash('sha256').update(id()).digest('hex'),now=Date.now();
  await b.membership.start(uid,'youtube',{nonceHash,startedAt:now,expiresAt:now+300000,consumed:false,localOnly:false});
  const logs=[];
  await withMembershipRequestTiming('verifyYoutubeMembership',()=>b.membership.withVerification(uid,'youtube',async()=>{
   await b.membership.consume(uid,'youtube',nonceHash);
   await b.membership.complete(uid,'youtube',nonceHash,{status:'none',type:'csv',levelName:'일반',userChannelId:'UC'+'x'.repeat(22),verificationVersion:2,verificationProvider:'youtube',lastChecked:Date.now()});
  }),{emit:line=>logs.push(JSON.parse(line))})({method:'POST'},{});
  const log=logs[0],spans=log.spans;
  assert.equal(log.droppedSpans,0);
  assert.equal(spans.filter(s=>s.name==='membership.storage_transaction').length,2);
  const transactions = spans.filter(s=>s.name==='membership.storage_transaction');
  for (const tx of transactions) {
   assert(tx.numbers.inputParentJsonBytes > 0); assert(tx.numbers.committedParentJsonBytes > tx.numbers.inputParentJsonBytes);
   assert.equal(tx.numbers.committedMembershipReceiptCount, tx.numbers.inputMembershipReceiptCount + 1);
   assert.equal(tx.numbers.callbackCount, spans.filter(s=>s.name==='membership.storage_callback' && s.parent===tx.id).length);
   assert.equal(tx.numbers.metricsErrors,0); assert(Object.values(tx.numbers).every(v=>typeof v==='number' && Number.isFinite(v)));
  }

  assert(spans.filter(s=>s.name==='membership.storage_callback').length>=2);
  assert.equal(spans.filter(s=>s.name==='membership.storage_encode').length,1);
  assert.equal(spans.filter(s=>s.name==='membership.storage_context').length,1);
  assert(spans.every(s=>s.ok));
  assert.doesNotMatch(JSON.stringify(log),new RegExp(uid+'|'+nonceHash+'|UC'+ 'x'.repeat(22)));
  assert.equal((await b.transition.inspect()).unresolved,0);
 } finally {await c.close();}
});
