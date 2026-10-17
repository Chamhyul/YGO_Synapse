'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(role='owner'){
 const users=new Map([['caller',{uid:'caller',customClaims:{role}}],['bot',{uid:'bot',email:'bot@example.invalid',customClaims:{keep:true}}]]),checks=[];
 const auth={async getUser(uid){return structuredClone(users.get(uid));},async getUserByEmail(){return this.getUser('bot');},async listUsers(){return{users:[...users.values()]};},async setCustomUserClaims(uid,claims){users.get(uid).customClaims=claims;}};
 const sandbox={exports:{},console,require(name){
  if(name==='firebase-functions/v2/https')return{onRequest:(_,fn)=>fn};
  if(name==='../../config/firebase')return{db:{},admin:{auth:()=>auth}};
  if(name==='../../utils/auth')return{setCors(){},async verifyAdmin(_req,res,options){checks.push(options);if(options.ownerOnly&&role!=='owner'){res.status(403).json({success:false});return;}return{uid:'caller',role};}};
  if(name==='../../services/adminActionTransport')return{forwardAdminRequest:async()=>false};
  if(name==='../../services/safeError'||name==='../../utils/safeError')return{safeErrorSummary:()=>({type:'test'})};
  return require(name.replace('../../services/','../services/'));
 }};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../routes/admin/notices.js'),'utf8'),sandbox);
 return{checks,async call(body){const res={code:200,set(){return this;},status(n){this.code=n;return this;},json(data){this.body=data;return this;}};await sandbox.exports.manageAdminRole({method:'POST',headers:{},body},res);return res;}};
}
test('기존 HTTP 진입점도 새 설정 동작은 조회를 포함해 소유자 검증 후 처리한다',async()=>{
 for(const action of ['settingsList','settingsLookup','settingsSetAdmin']){const f=fixture('admin');assert.equal((await f.call({action})).code,403);assert.equal(f.checks[0].ownerOnly,true);}
 const f=fixture();assert.equal((await f.call({action:'settingsLookup',kind:'uid',value:'bot'})).body.account.role,'none');
 const changed=await f.call({action:'settingsSetAdmin',targetUid:'bot',isAdmin:true,expectedRole:'none'});assert.equal(changed.code,200);assert.equal(changed.body.account.role,'admin');
 const protectedAccount=await f.call({action:'settingsSetAdmin',targetUid:'caller',isAdmin:false,expectedRole:'admin'});assert.equal(protectedAccount.code,403);
});
