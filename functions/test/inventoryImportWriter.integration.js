'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto');
const {FieldValue}=require('firebase-admin/firestore');
const {open}=require('../../integration/user-migration/connection.cjs');
const {createUserInventoryWriterBinding}=require('../services/userInventoryWriterRepository');
const {digestImport}=require('../services/inventoryImportRequests');
const {processAddCards}=require('../utils/inventoryStorage');
const id=()=>randomBytes(16).toString('hex'),uid='synthetic-import',digest=digestImport('file',{data:[{no:'A',qty:4}]}),requestId='a'.repeat(32);
const migration={prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete',pendingCount:0,unresolvedCount:0,retryAt:0})};
async function setup(options={}){const runId=id(),connection=open(runId),binding=createUserInventoryWriterBinding({db:connection.db,database:connection.targetDatabase,bucket:connection.bucket,FieldValue,runId,migration,...options});await binding.initialize();return{...binding,connection,close:connection.close};}
async function flip(f){const w=await f.transition.route();await f.transition.copy(w);await f.transition.drain(w);return f.transition.activate(w);}
async function perform(f,attempt=requestId,hash=digest,entered){return f.inventoryRepository.withImportAttempt(uid,attempt,hash,async()=>{entered?.();let latest,items;const response=()=>({success:true,importedQty:4,inventoryVersion:latest.version,updatedItems:items});await f.inventoryRepository.updateInventoryWithRetry(uid,value=>{items=processAddCards(value,{A:{name:'합성',cid:'42',items:[{rarity:'N',loc:'합성',qty:4,illustration:'1'}]}});latest=value;},3,{importResult:response});return response();});}
for(const backend of ['legacy','rtdb'])test(`${backend} 가져오기 영수증은 응답 유실·후속 수정·보관·전환/역전환 후에도 동일 결과만 반환한다`,{timeout:90000},async()=>{const f=await setup();try{if(backend==='rtdb')await flip(f);let entered=0;const original=await perform(f,requestId,digest,()=>entered++);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,4);await f.inventoryRepository.updateInventoryWithRetry(uid,value=>{value.custom='보존';});await f.transition.compact({limit:32});assert.deepEqual(await perform(f,requestId,digest,()=>entered++),original);assert.equal(entered,1);await flip(f);assert.deepEqual(await perform(f),original);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,4);await assert.rejects(perform(f,requestId,'b'.repeat(64)),{code:'IMPORT_REQUEST_CONFLICT'});await perform(f,'b'.repeat(32));assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,8);await f.inventoryRepository.deleteInventory(uid);assert.deepEqual(await perform(f),original);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,0);await flip(f);assert.deepEqual(await perform(f),original);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,0);assert.equal((await f.transition.inspect()).unresolved,0);}finally{await f.close();}});
test('실행 중 같은 ID 요청은 중복 저장하지 않으며 완료 후에는 원래 결과를 읽는다',{timeout:60000},async()=>{let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);const f=await setup({onCheckpoint:async stage=>{if(stage==='executing'){entered();await hold;}}});try{await flip(f);const first=perform(f);await ready;await assert.rejects(perform(f),{code:'IMPORT_REQUEST_PENDING'});release();const result=await first;assert.deepEqual(await perform(f),result);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,4);}finally{release();await f.close();}});
test('업무 저장 후 ACK 미확정은 재실행을 막고 기존 복구·새 epoch 재개 뒤 완료 영수증을 사용한다',{timeout:60000},async()=>{let lost=true,operationId;const f=await setup({onCheckpoint:async(stage,key)=>{if(stage==='businessCommitted'&&lost){lost=false;operationId=key;throw Error('synthetic-ack-loss');}}});try{await flip(f);await assert.rejects(perform(f),{code:'IMPORT_REQUEST_PENDING'});await assert.rejects(perform(f),{code:'IMPORT_REQUEST_PENDING'});const writer=await f.transition.drain(await f.transition.route());await f.transition.recover(operationId);await f.transition.resume(writer,{id:id(),writersDrained:true});assert.equal((await perform(f)).importedQty,4);assert.equal((await f.inventoryRepository.downloadInventory(uid)).data.amount,4);assert.equal((await f.transition.inspect()).unresolved,0);}finally{await f.close();}});
test('실제 가져오기 함수 POST·결과 GET은 같은 UID/본문 영수증을 사용하고 구형 API를 보존한다',{timeout:60000},async()=>{
 const {fixture,call}=require('./commonWriterFixture.cjs'),f=await fixture();
 try{
  await f.binding.transition.initialize();await f.binding.repository.completeRegistration(f.uid,{terms:'t',privacy:'p'});
  f.mock('functions/services/inventoryCardLookup.js',{resolveCardNumber:async no=>no,findCard:async()=>null,resolveInventoryCid:async()=> '42',getCardByCid:async()=>null,normalizeNumber:x=>x,mapLimited:async(items,fn)=>Promise.all(items.map(fn))});
  const route=f.load('functions/routes/migration.js').migrateFromData,body={data:[{name:'합성',no:'SYN-001',qty:4,loc:'합성',rare:'N',illust:'1'}],importRequestId:requestId};
  const statusQuery={importRequestId:requestId,importFingerprint:digestImport('file',body)};
  assert.equal((await call(route,{method:'GET',query:statusQuery})).body.importRequest.status,'missing');
  const first=await call(route,{body});assert.equal(first.statusCode,200);assert.equal(first.body.importedQty,4);
  const repeated=await call(route,{body});assert.deepEqual(repeated.body,first.body);
  const state=await call(route,{method:'GET',query:statusQuery});assert.equal(state.body.importRequest.status,'completed');assert.deepEqual(state.body.result,first.body);
  assert.equal((await f.binding.inventoryRepository.downloadInventory(f.uid)).data.amount,4);
  const conflict=await call(route,{body:{...body,data:[{...body.data[0],qty:8}]}});assert.equal(conflict.statusCode,409);assert.equal(conflict.body.code,'IMPORT_REQUEST_CONFLICT');
  assert.equal((await call(route,{method:'GET',query:statusQuery,token:'owner'})).statusCode,403);
  assert.equal((await call(route,{body:{data:body.data}})).statusCode,200);assert.equal((await f.binding.inventoryRepository.downloadInventory(f.uid)).data.amount,8);
 }finally{await f.close();}
});
