'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/script.js'),'utf8');
function fixture(){
 const calls=[],c=vm.createContext({UserStore:{user:{uid:'a'},settings:{},accountRevision:0},document:{getElementById:()=>null,querySelectorAll:()=>[]},window:{},UIStore:{},console:{error(){}},
 showLoading(){},followMembershipClaims(){},refreshMembershipClaims:async()=>{calls.push('claims');},applyMembershipStatus(){},updateAuthUI(){},updateUserInfoCard(){},
 applyUserData:data=>calls.push(['data',data]),loadUserTheme(){},loadUserSettings(){},showToast(){calls.push('error');},checkAndHideInitialLoading(){},
 callApi:async()=>{calls.push('api');return {success:true,settings:{},allCards:[]};}});
 vm.runInContext('let authStateRevision=1;',c);
 const start=source.indexOf('let userDataSyncTask = null;'),end=source.indexOf('\nfunction applyMembershipStatus(',start);
 vm.runInContext(source.slice(start,end),c);return{c,calls};
}
test('초기 통합 본문은 추가 HTTP 없이 기존 claims·렌더링 경로로 적용한다',async()=>{
 const f=fixture(),data={success:true,settings:{},allCards:[],membershipClaims:{status:'pending'}};
 await f.c.loadUserData(data);assert(!f.calls.includes('api'));assert(f.calls.includes('claims'));assert(f.calls.some(x=>x[0]==='data'&&x[1]===data));
});
test('구버전 서버의 초기 본문 없음은 기존 별도 조회로 호환한다',async()=>{const f=fixture();await f.c.loadUserData();assert.equal(f.calls.filter(x=>x==='api').length,1);});
test('본문 장애는 자동 재조회하지 않고 기존 실패 안내로 처리한다',async()=>{const f=fixture();await f.c.loadUserData({success:false,code:'INITIAL_USER_DATA_UNAVAILABLE'});assert(!f.calls.includes('api'));assert(f.calls.includes('error'));assert.equal(f.c.UserStore.settings.membership.status,'unknown');});
test('계정 변경 중 도착한 통합 본문은 적용하지 않는다',async()=>{const f=fixture();const p=f.c.loadUserData({success:true,settings:{}});f.c.UserStore.user={uid:'b'};vm.runInContext('authStateRevision++;',f.c);await p;assert(!f.calls.some(x=>x[0]==='data'));});

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(setImmediate);
test('별도 동기화도 전역 로딩을 유지하며 중복 조회와 완료 전 쓰기를 막는다',async()=>{
 const f=fixture(),d=deferred();f.c.showLoading=(...args)=>f.calls.push(['overlay',...args]);f.c.callApi=()=>{f.calls.push('api');return d.promise;};
 const a=f.c.loadUserData(undefined,{background:true}),b=f.c.loadUserData(undefined,{background:true});await tick();
 assert.equal(f.calls.filter(x=>x==='api').length,1);assert.equal(f.c.UserStore.isUserDataSyncDone,false);assert.equal(f.c.requireInventoryReady(),false);
 assert.deepEqual(f.calls.filter(x=>x[0]==='overlay').map(x=>x[1]),[true]);
 d.resolve({success:true,settings:{},allCards:[]});await Promise.all([a,b]);assert.equal(f.c.UserStore.inventorySyncStatus,'ready');assert.equal(f.c.requireInventoryReady(),true);
 assert.deepEqual(f.calls.filter(x=>x[0]==='overlay').map(x=>x[1]),[true,false]);
});
test('별도 동기화 실패는 확인된 계정·멤버십을 유지하고 실패를 빈 목록으로 완료하지 않는다',async()=>{
 const f=fixture();f.c.UserStore.settings.membership={status:'active',type:'account'};
 await f.c.loadUserData({success:false,code:'INITIAL_USER_DATA_UNAVAILABLE'},{background:true});
 assert.equal(f.c.UserStore.settings.membership.status,'active');assert.equal(f.c.UserStore.inventorySyncStatus,'error');assert.equal(f.c.UserStore.isUserDataSyncDone,false);
 assert.equal(f.c.requireInventoryReady(),false);assert(!f.calls.some(x=>x[0]==='data'));
 assert.equal(await f.c.retryUserDataSync(),true);assert.equal(f.calls.filter(x=>x==='api').length,1);
});
test('느린 동기화 동안 바뀐 계정 설정은 늦은 전체 응답으로 되돌리지 않는다',async()=>{
 const f=fixture(),d=deferred();f.c.callApi=()=>d.promise;const p=f.c.loadUserData(undefined,{background:true});await tick();
 f.c.UserStore.accountRevision++;f.c.UserStore.settings.theme='dark';
 d.resolve({success:true,settings:{theme:'light'},allCards:[]});await p;
 assert.equal(f.c.UserStore.settings.theme,'dark');assert(f.calls.some(x=>x[0]==='data'));
});
test('같은 계정의 오래된 응답도 강제 재조회 뒤에는 최신 snapshot을 덮지 않는다',async()=>{
 const f=fixture(),old=deferred(),fresh=deferred();let n=0;f.c.callApi=()=>++n===1?old.promise:fresh.promise;
 const a=f.c.loadUserData(undefined,{background:true});await tick();const b=f.c.loadUserData(undefined,{background:true,force:true});await tick();
 const data={success:true,settings:{},allCards:[['fresh']]};fresh.resolve(data);await b;old.resolve({success:true,allCards:[['old']]});await a;
 assert.deepEqual(f.calls.filter(x=>x[0]==='data').map(x=>x[1].allCards),[[['fresh']]]);
});
test('claims 미확정은 인벤토리 준비와 구분하고 확정 토큰으로 간주하지 않는다',async()=>{
 const f=fixture();await f.c.loadUserData({success:true,settings:{},allCards:[],membershipClaims:{status:'pending'}},{background:true});
 assert.equal(f.c.UserStore.inventorySyncStatus,'ready');assert.equal(f.c.UserStore.claimsSyncStatus,'pending');
});
