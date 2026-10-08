const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../routes/admin/notices.js'),'utf8');
function fixture({valid=true,role='admin',disabled=false}={}) {
 let writes=0,revokedCheck;
 const auth={async verifyIdToken(token,check){revokedCheck=check;if(!valid)throw Object.assign(Error(),{code:'auth/argument-error'});return{uid:'test-user'};},async getUser(){return{disabled,customClaims:{role}};}};
 const authModule={exports:{}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../utils/auth.js'),'utf8'), {
  module:authModule,process:{env:{}},console:{error(){}},require(name){
   if(name==='../services/publicReadTransport')return{isLocal:()=>false};
   if(name==='../config/firebase')return{admin:{auth:()=>auth}};
   if(name==='./safeError')return{safeErrorSummary:()=>({type:'internal_error'})};
   throw Error(name);
  }
 });
 const sandbox={exports:{},process:{env:{}},console,
 require(name){if(name==='firebase-functions/v2/https')return{onRequest:(_,fn)=>fn};if(name==='../../config/firebase')return{db:{},admin:{auth:()=>auth,storage:()=>({bucket:()=>({})})}};if(name==='../../services/localNoticeLock')return{withLocalNoticeLock:(_,action)=>action()};if(name==='../../utils/auth')return authModule.exports;if(name==='../../services/adminActionTransport')return{forwardAdminRequest:async()=>false};if(name==='../../utils/safeError')return{safeErrorSummary:()=>({type:'internal_error'})};if(name==='../../services/noticeService')return{createStorageNoticeStore:()=>({}),createNoticeService:()=>({async mutate(){writes++;return{};}})};throw Error(name);}};
 vm.runInNewContext(source,sandbox);
 return {async call(){const res={code:200,status(n){this.code=n;return this;},json(data){this.body=data;return this;},set(){return this;}};await sandbox.exports.manageNotice({method:'POST',headers:{authorization:'Bearer test'},body:{action:'add'}},res);return res;},writes:()=>writes,checked:()=>revokedCheck};
}
test('기존 공지 콘솔 API도 철회 검증을 요청하고 조작 토큰/일반/비활성 계정은 저장하지 않는다',async()=>{
 for(const input of [{valid:false},{role:'user'},{disabled:true}]){const f=fixture(input);assert.ok([401,403].includes((await f.call()).code));assert.equal(f.writes(),0);assert.equal(f.checked(),true);}
 const f=fixture();assert.equal((await f.call()).code,200);assert.equal(f.writes(),1);assert.equal(f.checked(),true);
});
