'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMembershipWriterRepository}=require('../services/userMembershipWriterRepository');
test('인증 잠금 진단은 고정 코드·종류만 남기며 원래 실패와 무쓰기 경계를 유지한다',async()=>{
 for(const code of ['WRITER_RESOURCE_BUSY','token-like-secret']){
  const error=Object.assign(Error('sensitive-message'),{code}),lines=[],warn=console.warn;
  const repository=createMembershipWriterRepository({transition:{route:async()=>({backend:'rtdb',epoch:1,phase:'accepting'}),beginExternal:async()=>{throw error;},withSession:action=>action()},adapters:{rtdb:{}},profiles:{},initialize:async()=>{},timeoutMs:1});
  console.warn=line=>lines.push(line);
  try{await assert.rejects(repository.withVerification('synthetic','discord',()=>assert.fail('거부 뒤 작업 실행')),(actual)=>actual===error);}finally{console.warn=warn;}
  assert.deepEqual(JSON.parse(lines[0]),{event:'membership_lease_failure',stage:'begin',code:code==='WRITER_RESOURCE_BUSY'?code:'UNCLASSIFIED',kind:'Error'});assert(!lines.join().includes('sensitive-message'));assert(!lines.join().includes('token-like-secret'));assert(!lines.join().includes('synthetic'));
 }
});
test('진단 출력 실패는 원래 잠금 거부를 대체하지 않는다',async()=>{
 const error=new TypeError('sensitive-message'),warn=console.warn;
 const repository=createMembershipWriterRepository({transition:{route:async()=>({backend:'rtdb',epoch:1}),beginExternal:async()=>{throw error;}},adapters:{rtdb:{}},profiles:{},initialize:async()=>{}});
 console.warn=()=>{throw Error('logging unavailable');};try{await assert.rejects(repository.withVerification('synthetic','discord',()=>{}),(actual)=>actual===error);}finally{console.warn=warn;}
});
