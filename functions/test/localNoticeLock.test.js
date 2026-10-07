const test=require('node:test'),assert=require('node:assert/strict');const {withLocalNoticeLock}=require('../services/localNoticeLock');
function fixture(initial) {
 let record=initial,chain=Promise.resolve();const ref={};
 const db={collection:()=>({doc:()=>ref}),runTransaction(fn){const p=chain.then(()=>fn({get:async()=>({data:()=>record}),set:(_,data)=>{record=data;},delete:()=>{record=undefined;}}));chain=p.catch(()=>{});return p;}};
 return{db,record:()=>record};
}
test('진행 중 잠금은409로 거부하고 작업 실패 후 잠금을 정리한다',async()=>{
 const f=fixture();let done;const first=withLocalNoticeLock(f.db,()=>new Promise(r=>{done=r;}));await new Promise(r=>setImmediate(r));
 await assert.rejects(withLocalNoticeLock(f.db,async()=>{}),{status:409});done();await first;assert.equal(f.record(),undefined);
 await assert.rejects(withLocalNoticeLock(f.db,async()=>{throw Error('검증 실패');}));assert.equal(f.record(),undefined);
});
test('동일 프로세스의 끝난 작업 기록은 다음 요청에서 회수한다',async()=>{
 const f=fixture({pid:process.pid,token:'inactive-lock'});let called=false;await withLocalNoticeLock(f.db,async()=>{called=true;});assert.equal(called,true);assert.equal(f.record(),undefined);
});
