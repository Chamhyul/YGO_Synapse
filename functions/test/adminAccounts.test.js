'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAdminAccounts,roleGuard,validateRequest}=require('../services/adminAccounts');
const {updateAccountClaims}=require('../services/membershipClaims');
function fixture(){
 const rows=new Map([['owner',{uid:'owner',customClaims:{role:'owner'}}],['bot',{uid:'bot',email:'bot@example.invalid',customClaims:{unrelated:{keep:1}}}]]);
 let writes=0,beforeWrite;
 const auth={async getUser(uid){if(!rows.has(uid))throw Object.assign(Error(),{code:'auth/user-not-found'});return structuredClone(rows.get(uid));},async getUserByEmail(email){return this.getUser([...rows.values()].find(row=>row.email===email)?.uid);},async listUsers(size,token){assert.equal(size,200);return{users:[...rows.values()],pageToken:token?undefined:'synthetic-page'};},async setCustomUserClaims(uid,claims){writes++;rows.get(uid).customClaims=structuredClone(claims);}};
 const manage=createAdminAccounts({auth,updateClaims:async(uid,patch,validateCurrentClaims)=>{beforeWrite?.();return updateAccountClaims(uid,patch,{auth,env:{},validateCurrentClaims});}});
 return{rows,auth,manage,writes:()=>writes,race:fn=>{beforeWrite=fn;}};
}
test('소유자만 관리자 목록과 UID/이메일로 계정을 조회하며 전체 claims는 노출하지 않는다',async()=>{
 const f=fixture();assert.equal((await f.manage({action:'settingsList'},'owner')).accounts.length,1);
 const result=await f.manage({action:'settingsLookup',kind:'email',value:'bot@example.invalid'},'owner');assert.equal(result.account.uid,'bot');assert.equal(result.account.customClaims,undefined);
 await assert.rejects(f.manage({action:'settingsList'},'bot'),{status:403});f.rows.get('owner').disabled=true;await assert.rejects(f.manage({action:'settingsList'},'owner'),{status:403});
});
test('관리자 부여/해제는 기존 claims를 보존하고 반복 요청도 같은 권한을 유지한다',async()=>{
 const f=fixture(),grant={action:'settingsSetAdmin',targetUid:'bot',isAdmin:true,expectedRole:'none'};
 assert.equal((await f.manage(grant,'owner')).account.role,'admin');assert.deepEqual(f.rows.get('bot').customClaims.unrelated,{keep:1});
 assert.equal((await f.manage(grant,'owner')).account.role,'admin');
 assert.equal((await f.manage({...grant,isAdmin:false,expectedRole:'admin'},'owner')).account.role,'none');
});
test('자기 자신/소유자/비활성 부여/문자열 boolean/위조 필드/없는 계정은 변경하지 않는다',async()=>{
 const f=fixture();f.rows.set('other-owner',{uid:'other-owner',customClaims:{role:'owner'}});
 for(const targetUid of ['owner','other-owner'])await assert.rejects(f.manage({action:'settingsSetAdmin',targetUid,isAdmin:true,expectedRole:'none'},'owner'),{status:403});
 f.rows.get('bot').disabled=true;await assert.rejects(f.manage({action:'settingsSetAdmin',targetUid:'bot',isAdmin:true,expectedRole:'none'},'owner'),{status:400});
 assert.throws(()=>validateRequest({action:'settingsSetAdmin',targetUid:'bot',isAdmin:'false',expectedRole:'none'}),{status:400});assert.throws(()=>validateRequest({action:'settingsList',role:'owner'}),{status:400});
 await assert.rejects(f.manage({action:'settingsLookup',kind:'uid',value:'missing'},'owner'),{status:404});assert.equal(f.writes(),0);
});
test('조회 뒤 대상이 소유자로 바뀌면 실제 쓰기 직전 guard가 권한 덮어쓰기를 거부한다',async()=>{
 const f=fixture();f.race(()=>{f.rows.get('bot').customClaims.role='owner';});
 await assert.rejects(f.manage({action:'settingsSetAdmin',targetUid:'bot',isAdmin:true,expectedRole:'none'},'owner'),{status:403});assert.equal(f.writes(),0);
});
test('권한 쓰기/재조회 장애는 성공으로 보고하지 않으며 잘못된 목록 커서와 UID는 거부한다',async()=>{
 const f=fixture();assert.throws(()=>validateRequest({action:'settingsSetAdmin',targetUid:'invalid/uid',isAdmin:true,expectedRole:'none'}),{status:400});
 assert.throws(()=>validateRequest({action:'settingsList',pageToken:123}),{status:400});
 assert.throws(()=>roleGuard('none',true)({role:'owner'}),{status:403});
 const manage=createAdminAccounts({auth:f.auth,updateClaims:async()=>{throw Error('synthetic failure');}});
 await assert.rejects(manage({action:'settingsSetAdmin',targetUid:'bot',isAdmin:true,expectedRole:'none'},'owner'),/synthetic failure/);
});
