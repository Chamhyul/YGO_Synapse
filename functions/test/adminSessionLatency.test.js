'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSessionWriterRepository}=require('../services/adminSessionWriterRepository');
const key='a'.repeat(64),value={uid:'synthetic-owner',lastActivity:1,expiresAt:100000};
function fixture({initializeMissing=false,atomic=true}={}){
 let writer={backend:'rtdb',epoch:1,phase:'accepting'},readHook,atomicHook;
 const calls={routes:0,begin:0,extend:[],end:0,prepare:0,execute:0,atomic:0,inspect:0,journalScopes:0},rows=new Map(),ops=new Map(),generations=new Map();
 const transition={
  async withSession(work){calls.journalScopes++;return work();},
  async route(){calls.routes++;return writer;},
  async beginExternal(){calls.begin++;},async addExternalResources(_id,resources){calls.extend.push(resources);},async endExternal(){calls.end++;},
  async prepare(_writer,id,changes,result){calls.prepare++;const op={id,changes,result};ops.set(id,op);return op;},
  async execute(_writer,id){calls.execute++;const op=ops.get(id);for(const entry of op.changes){if(entry.exists)rows.set(entry.key,entry.value);else rows.delete(entry.key);}return op.result;},
 };
 if(atomic)transition.prepareAndExecuteWithReceipt=async(w,id,changes,result,options)=>{
  calls.atomic++;const op={id,changes,result};await atomicHook?.(op,options);options.onPrepared(op);
  for(const entry of changes){if(entry.exists)rows.set(entry.key,entry.value);else rows.delete(entry.key);}
  return{result,receipt:{}};
 };
 const initial=writer;
 const initialize=()=>initializeMissing?Promise.resolve(initial):transition.route();
 const adapter={async inspect(selected){calls.inspect++;await readHook?.();return{generation:generations.get(selected)||0,entry:{key:selected,exists:rows.has(selected),token:rows.has(selected)?'1':'0',...(rows.has(selected)?{value:structuredClone(rows.get(selected))}:{})}};},cancellationReason:async()=> 'fenced'};
 const store=createSessionWriterRepository({transition,adapters:{legacy:adapter,rtdb:adapter},initialize,initializeMissing});
 return{store,calls,rows,generations,writer:()=>writer,flip(){writer={...writer,backend:writer.backend==='rtdb'?'legacy':'rtdb',epoch:writer.epoch+1};},set readHook(v){readHook=v;},set atomicHook(v){atomicHook=v;}};
}
test('한 요청의 fresh route만 재사용하고 다음 요청은 새 backend/epoch를 읽는다',async()=>{
 const f=fixture();
 await f.store.withRequest({},async()=>{await f.store.beginLogin(value.uid);await f.store.set(key,value);});
 assert.equal(f.calls.routes,1);assert.equal(f.calls.atomic,1);assert.equal(f.calls.prepare,0);assert.equal(f.calls.execute,0);
 assert.equal(f.calls.begin,1);assert.equal(f.calls.extend.length,1);assert.equal(f.calls.end,1);
 f.flip();f.calls.routes=0;
 await f.store.withRequest({},async()=>assert.equal((await f.store.get(key)).uid,value.uid));
 assert.equal(f.calls.routes,2);assert.equal(f.calls.end,2);
});
test('시험 초기화의 오래된 route를 재사용하지 않고 양방향 전환을 따른다',async()=>{
 const f=fixture({initializeMissing:true});
 for(let i=0;i<3;i++){
  await f.store.withRequest({},async()=>{await f.store.set(key,value);assert.equal((await f.store.get(key)).uid,value.uid);});
  f.flip();
 }
 assert.equal(f.calls.routes,6);assert.equal(f.calls.end,3);
});
test('같은 요청이 이미 확보한 잠금은 다시 확장하지 않으며 요청 간에는 재확보한다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 await f.store.withRequest({},async()=>{await f.store.beginLogin(value.uid,key);await f.store.remove(key);});
 assert.equal(f.calls.begin,1);assert.equal(f.calls.extend.length,0);
 await f.store.withRequest({},async()=>{await f.store.beginLogin(value.uid);await f.store.set(key,value);});
 assert.equal(f.calls.begin,2);assert.equal(f.calls.extend.length,1);
});
test('요청 도중 최종 epoch가 달라지면 새 backend에 재송신하지 않고 거부한다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);f.readHook=()=>{f.readHook=null;f.flip();};
 await assert.rejects(f.store.withRequest({},()=>f.store.get(key)),{code:'WRITER_FENCED'});
 assert.equal(f.calls.atomic,0);assert.equal(f.calls.begin,0);
});
test('영구 준비 뒤 미확정 오류는 같은 요청을 재실행하지 않고 잠금 종료를 기다린다',async()=>{
 const f=fixture();f.atomicHook=(op,options)=>{options.onPrepared(op);throw Object.assign(Error(),{code:'WRITER_RESOURCE_BUSY'});};
 await assert.rejects(f.store.withRequest({},()=>f.store.set(key,value)),{code:'WRITER_RESOURCE_BUSY'});
 assert.equal(f.calls.atomic,1);assert.equal(f.calls.end,1);
});
test('영구 취소를 새 ID로 재실행하지 않고 기존 사유를 보존한다',async()=>{
 const f=fixture();f.atomicHook=(op,options)=>{options.onPrepared(op);throw Object.assign(Error(),{code:'WRITER_CANCELLED'});};
 await assert.rejects(f.store.withRequest({},()=>f.store.set(key,value)),{code:'WRITER_CANCELLED'});
 assert.equal(f.calls.atomic,1);assert.equal(f.calls.end,1);
});
test('통합 준비·실행이 없는 주입 저장소도 기존 준비/실행 계약을 유지한다',async()=>{
 const f=fixture({atomic:false});await f.store.withRequest({},()=>f.store.set(key,value));
 assert.equal(f.calls.prepare,1);assert.equal(f.calls.execute,1);assert.equal(f.calls.end,1);
});

test('사전·최종 인증은 읽기만 수행하고 journal 잠금과 쓰기를 만들지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 const authorize=async()=>{const v=await f.store.get(key);return v&&{uid:v.uid};};
 const result=await f.store.withReadRequest({},authorize,async()=>{
  assert.equal(f.store.writerLease(),undefined);assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
  return{synthetic:true};
 });
 assert.deepEqual(result,{access:{uid:value.uid},result:{synthetic:true}});
 assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
 assert.equal(f.calls.inspect,2);assert.equal(f.calls.journalScopes,0);
 assert.equal(f.calls.atomic,0);assert.equal(f.calls.routes,3);
});
test('조회 중 backend/epoch가 달라지면 이전 결과를 반환하지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 const authorize=async()=>{const v=await f.store.get(key);return v&&{uid:v.uid};};
 await assert.rejects(f.store.withReadRequest({},authorize,async()=>{f.flip();return{private:true};}),{code:'WRITER_FENCED'});
 assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
});
test('같은 키·UID로 재발급해도 삭제 generation이 바뀌면 이전 조회 결과를 반환하지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 const authorize=async()=>{const v=await f.store.get(key);return v&&{uid:v.uid};};
 const result=await f.store.withReadRequest({},authorize,async()=>{f.generations.set('session/'+key,1);return{private:true};});
 assert.equal(result.access,null);
});
test('잠금 대기 중 삭제된 세션은 잠금 전 관측값으로 허용하지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 // 첫 inspect의 사본이 반환된 직후 beginExternal에서 logout 완료를 재현한다.
 const original=f.store.writerLease;
 let reads=0;f.readHook=()=>{if(++reads===2)f.rows.delete('session/'+key);};
 await f.store.withRequest({},async()=>assert.equal(await f.store.get(key),undefined));
 assert.equal(f.calls.begin,1);assert.equal(f.calls.end,1);assert.equal(typeof original,'function');
});
test('사전 인증 문맥에서는 세션 발급·삭제·활동 갱신을 실행할 수 없다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);let authorizations=0;
 const authorize=async options=>{
  if(++authorizations===1){
   assert.equal(options.readOnly,true);
   for(const work of [()=>f.store.set(key,value),()=>f.store.remove(key),()=>f.store.touch(key,value.uid,2),()=>f.store.beginLogin(value.uid)]){
    await assert.rejects(work(),{code:'SESSION_WRITER_READ_ONLY'});
   }
  }
  return {uid:(await f.store.get(key)).uid};
 };
 await f.store.withReadRequest({},authorize,async()=>({}));
 assert.equal(f.calls.begin,0);assert.equal(f.calls.atomic,0);
});
test('문서 요청만 선택한 journal 범위 안에서 승인과 종료를 함께 수행한다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 await f.store.withRequest({},()=>f.store.get(key),{reuseJournal:true});
 assert.equal(f.calls.journalScopes,1);assert.equal(f.calls.begin,1);assert.equal(f.calls.end,1);
 await f.store.withRequest({},()=>f.store.get(key));
 assert.equal(f.calls.journalScopes,1,'쓰기 경계는 임의로 넓히지 않는다');
});
test('drain 중에는 읽기 사전 확인도 외부 조회·잠금 등록 전에 거부한다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);f.writer().phase='draining';
 await assert.rejects(f.store.withReadRequest({},async()=>({uid:(await f.store.get(key)).uid}),()=>assert.fail('drain 중 조회 금지')),{code:'WRITER_DRAINING'});
 assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
});

test('최종 인증도 쓰기 금지이며 권한이 바뀌면 먼저 수집한 결과를 반환하지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);let n=0;
 const result=await f.store.withReadRequest({},async options=>{
  assert.equal(options.readOnly,true);
  if(++n===2){assert.equal(options.confirmSession,true);await assert.rejects(f.store.remove(key),{code:'SESSION_WRITER_READ_ONLY'});}
  return{uid:(await f.store.get(key)).uid,role:n===1?'owner':'admin'};
 },async()=>({private:true}));
 assert.deepEqual(result,{access:null});assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
});
test('최종 세션/route 재조회가 실패하면 수집한 결과를 반환하지 않는다',async()=>{
 const f=fixture();f.rows.set('session/'+key,value);
 await assert.rejects(f.store.withReadRequest({},async()=>({uid:(await f.store.get(key)).uid}),async()=>{
  f.readHook=()=>{throw Object.assign(Error(),{code:'SYNTHETIC_READ_FAILURE'});};return{private:true};
 }),{code:'SYNTHETIC_READ_FAILURE'});
 assert.equal(f.calls.begin,0);assert.equal(f.calls.end,0);
});
