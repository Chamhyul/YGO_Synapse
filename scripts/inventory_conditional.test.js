'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
const between = (a,b) => { const start=source.indexOf(a), end=source.indexOf(b,start); assert(start>=0&&end>start); return source.slice(start,end); };
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
const token='i1:'+'a'.repeat(64);
const full = (qty=2) => ({ success:true, allCards:[['합성','SYN-1','N',qty,'A','1','100']], amount:qty, locations:{A:['SYN-1']}, rarities:{N:qty},
  inventoryMigration:{status:'complete',unresolvedCount:0}, inventoryVersion:3, inventorySync:{status:'full',token}, settings:{membership:{status:'active'}}, nickname:'최신 합성', membershipClaims:{status:'synced',version:'synthetic'} });
const unchanged = () => ({success:true,inventorySync:{status:'unchanged',token},settings:{membership:{status:'none'}},nickname:'새 합성',membershipClaims:{status:'synced',version:'synthetic'}});
function fixture() {
 const calls=[], overlays=[], accounts=[], toasts=[], responses=[];
 const user={uid:'synthetic'}, store={user,settings:{},inventorySyncStatus:'ready',accountRevision:0};
 const context={console:{error(){},warn(){}},UserStore:store,authStateRevision:1,UIStore:{mode:'home'},firebase:{auth:()=>({currentUser:store.user})},
  showLoading:(visible)=>overlays.push(visible),setInventorySyncStatus:s=>{store.inventorySyncStatus=s;},checkAndHideInitialLoading(){},
  refreshMembershipClaims:async()=>true,followMembershipClaims(){},applyAccountData:x=>accounts.push(x),loadUserTheme(){},loadUserSettings(){},
  applyMembershipStatus(){},showToast:t=>toasts.push(t),scheduleInventoryMigration:r=>{store.inventoryMigration=r.inventoryMigration;},
  updateTotals(){},updateRarityInputs(){},refreshCurrentSearchResult(){},getChosung:()=>'',normalizeStr:x=>String(x),
  callApi:async(name,_query,body)=>{calls.push({name,body:JSON.parse(JSON.stringify(body))});const response=responses.shift();return typeof response==='function'?response():response;},
 };
 vm.createContext(context);
 vm.runInContext(between('class ClientCache {','const cardCacheInstance = new ClientCache();')+'\nconst cardCacheInstance = new ClientCache();\n'+
  between('let userDataSyncTask = null;','function setInventorySyncStatus(')+between('async function performUserDataSync(','async function syncYoutubeMembership(')+between('function applyUserData(','function rarityLangsToRows(')+
  '\nglobalThis.testApi={load:loadUserData,cache:cardCacheInstance,snapshot:()=>inventorySyncSnapshot};',context);
 return {context,store,calls,overlays,accounts,toasts,responses,...context.testApi};
}
async function prime(f){ f.responses.push(full()); await f.load();assert(f.snapshot()); }
test('검증된 전체 응답 뒤 동일 버전은 새 프로필/claims를 적용하고 기존 목록·집계를 보존한다',async()=>{
 const f=fixture(); await prime(f);const rows=f.cache.getInventory(); f.responses.push(unchanged());await f.load(undefined,{membershipClaimsReadOnly:true});
 assert.equal(f.calls[1].body.inventoryToken,token);assert.equal(f.accounts.at(-1).nickname,'새 합성');
 assert.equal(f.cache.getInventory(),rows);assert.equal(f.cache.getAmount(),2);assert.equal(f.store.claimsSyncStatus,'ready');
 assert.equal(f.store.inventorySyncStatus,'ready');assert.deepEqual(f.overlays,[true,false,true,false]);
});
for(const change of ['update','clear','summary','new-auth','new-account'])test(`${change} 이후 이전 token을 전송하지 않고 전체 응답을 적용한다`,async()=>{
 const f=fixture();await prime(f);
 if(change==='update')f.cache.updateInventory([{cardNo:'SYN-1',rarity:'N',loc:'A',illustration:'1',qty:3}]);
 if(change==='clear')f.cache.clearAll();if(change==='summary')f.cache.setSummary(3,{},{});
 if(change==='new-auth')f.context.authStateRevision++;
 if(change==='new-account'){f.context.authStateRevision++;f.store.user={uid:'other'};}
 f.responses.push(full(4));await f.load(undefined,{membershipClaimsReadOnly:true});assert(!f.calls[1].body.inventoryToken);
 assert.equal(f.cache.getAmount(),4);
});
test('조건부 응답 대기 중 로컬 수정이 끝나면 같은 전체 로딩 안에서 전체 snapshot으로 대체한다',async()=>{
 const f=fixture();await prime(f);const gate=deferred();f.responses.push(()=>gate.promise,full(5));
 const pending=f.load(undefined,{membershipClaimsReadOnly:true});await new Promise(setImmediate);
 f.cache.updateInventory([{cardNo:'SYN-1',rarity:'N',loc:'A',illustration:'1',qty:3}]);gate.resolve(unchanged());await pending;
 assert.equal(f.calls.length,3);assert.equal(f.calls[2].body.inventoryToken,undefined);assert.equal(f.cache.getAmount(),5);
 assert.deepEqual(f.overlays,[true,false,true,false]);assert.equal(f.store.inventorySyncStatus,'ready');
});
test('claims 확인 대기 중 캐시가 바뀌어도 전체 응답으로 회복하고 새 프로필을 반영한다',async()=>{
 const f=fixture();await prime(f);const gate=deferred();let entered;
 const ready=new Promise(r=>entered=r);f.context.refreshMembershipClaims=async()=>{entered();await gate.promise;return true;};
 f.responses.push(unchanged(),full(6));const pending=f.load(undefined,{membershipClaimsReadOnly:true});await ready;
 f.cache.clearAll();gate.resolve();await pending;assert.equal(f.calls.length,3);assert.equal(f.cache.getAmount(),6);
});
for(const bad of [()=>({...unchanged(),inventorySync:{status:'unchanged',token:'i1:'+'b'.repeat(64)}}),()=>({...unchanged(),allCards:[]})])test('캐시와 맞지 않는 축약 응답을 빈 인벤토리로 적용하지 않는다',async()=>{
 const f=fixture();await prime(f);f.responses.push(bad(),full(7));await f.load(undefined,{membershipClaimsReadOnly:true});
 assert.equal(f.cache.getAmount(),7);assert.equal(f.calls.length,3);assert.equal(f.toasts.length,0);
});
test('복구 전체 요청도 unchanged면 실패 안내로 끝내고 기존 보유 목록을 삭제하지 않는다',async()=>{
 const f=fixture();await prime(f);const rows=f.cache.getInventory();f.cache.setSummary(2,{A:['SYN-1']},{N:2});
 f.responses.push(unchanged(),unchanged());assert.equal(await f.load(undefined,{membershipClaimsReadOnly:true}),false);
 assert.equal(f.cache.getInventory(),rows);assert.equal(f.store.inventorySyncStatus,'error');
});
test('구버전 서버 전체 응답과 미완료 이관은 정상 적용하되 재사용 token을 보관하지 않는다',async()=>{
 for(const mode of ['old','pending']){const f=fixture(),r=full();if(mode==='old')delete r.inventorySync;else if(mode==='pending')r.inventoryMigration.status='pending';else r.inventoryMigration.unresolvedCount=1;
  f.responses.push(r);await f.load();assert.equal(f.cache.getAmount(),2);assert.equal(f.snapshot(),null);
  f.responses.push(full());await f.load(undefined,{membershipClaimsReadOnly:true});assert(!f.calls[1].body.inventoryToken);
 }
});
test('계정 교체 후 도착한 조건부 응답은 새 계정 목록/프로필로 적용하지 않는다',async()=>{
 const f=fixture();await prime(f);const gate=deferred();f.responses.push(()=>gate.promise);const pending=f.load(undefined,{membershipClaimsReadOnly:true});
 await new Promise(setImmediate);f.context.authStateRevision++;f.store.user={uid:'other'};gate.resolve(unchanged());await pending;
 assert.equal(f.accounts.length,1);assert.equal(f.cache.getAmount(),2);assert.equal(f.calls.length,2);
});

test('서버가 기한을 검증한 complete 응답은 미확정 CID가 있어도 토큰을 보관하고 다음 요청에 재사용한다',async()=>{
 const f=fixture(),r=full();r.inventoryMigration.unresolvedCount=1;f.responses.push(r,unchanged());
 assert.equal(await f.load(),true);assert.equal(await f.load(undefined,{membershipClaimsReadOnly:true}),true);assert.equal(f.calls[1].body.inventoryToken,token);
});

test('설정에서 로그인 복원이 끝나면 준비를 시작하고 실패한 인벤토리는 준비 시작으로 처리하지 않는다',async()=>{
 for(const success of [true,false]){
  const f=fixture();let started=0;f.context.UIStore.mode='settings';f.context.prepareMembershipEntry=()=>started++;
  f.responses.push(success?full():{success:false});await f.load();assert.equal(started,success?1:0);
 }
});
