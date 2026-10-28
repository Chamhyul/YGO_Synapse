'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');const {chromium}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0,name);const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
const code=`
const UIStore={};const UserStore={user:null,settings:{},accountRevision:0,inventorySyncStatus:'idle'};let authStateRevision=0,serviceAuthStarted=false,serviceLoginPending=false,registrationCheckPending=false,loginInProgress=false,pendingRegistrationUser=null,pendingServiceAuthUser=null,pendingConsentVersions=null,serviceLoginFailureCode=null;
let userDataSyncTask=null,userDataSyncSerial=0,inventoryMigrationTimer;const serviceUiReady=Promise.resolve();
const auth={currentUser:{uid:'synthetic'}};window.firebase={auth:()=>auth};const M={Modal:{getInstance:()=>({close(){}})}};
window.events=[];window.apiCalls=[];window.failSync=false;window.summaryOnly=false;window.holdClaims=false;let finishClaims;const claimsBlocked=new Promise(r=>finishClaims=r);window.releaseClaims=()=>finishClaims();let finishSync;const blocked=new Promise(r=>finishSync=r);
window.releaseSync=()=>finishSync();window.signOutFixture=()=>{authStateRevision++;auth.currentUser=null;applyServiceAuthState(null);};
const AutoLogoutManager={start:()=>true,stop(){}};const cardCacheInstance={clearAll(){},getInventory:()=>[]};
function loadUserTheme(){}function loadUserSettings(x){UserStore.settings={...UserStore.settings,...x};}
function followMembershipClaims(){}function updateProviderUI(){}function applyMembershipStatus(){}function updateUserInfoCard(){}function renderLinkedAccounts(){}function checkAndHideInitialLoading(){if(UserStore.isUserDataSyncDone)showLoading(false);}function toggleLoginBtn(){}function showToast(){}
function applyUserData(x){document.getElementById('inventory').textContent=x.allCards.length?'보유 카드':'등록된 카드가 없습니다.';events.push('inventory-applied');}
async function refreshMembershipClaims(){if(holdClaims)await claimsBlocked;return true;}
async function callApi(name,query){apiCalls.push(name);if(name==='getRegistrationStatus'&&summaryOnly)return{success:true,registered:true,initialAccount:{success:true,nickname:'fixture',settings:{theme:'dark',membership:{status:'active'}}}};
 await blocked;const data=failSync?{success:false,code:'INITIAL_USER_DATA_UNAVAILABLE'}:{success:true,allCards:[['fixture']],settings:{theme:'light'},membershipClaims:{status:'synced',version:'synthetic'}};
 return name==='getRegistrationStatus'?{success:true,registered:true,initialData:data}:data;}
window.endOtherLoading=()=>showLoading(false);
${['showLoading','setServiceLoginPending','getServiceRegistrationStatus','handleFirebaseAuthState','applyServiceAuthState','setInventorySyncStatus','requireInventoryReady','applyAccountData','loadUserData','performUserDataSync','retryUserDataSync'].map(fn).join('\n')}
window.beginFixture=()=>handleFirebaseAuthState(auth.currentUser);window.retryFixture=()=>retryUserDataSync();window.fixtureState=()=>({signedIn:!!UserStore.user,status:UserStore.inventorySyncStatus,claims:UserStore.claimsSyncStatus,theme:UserStore.settings.theme,ready:requireInventoryReady()});
`;
async function fixture(page){const errors=[];page.setDefaultTimeout(5000);page.on('pageerror',e=>{errors.push(e.message);console.log('synthetic-browser-error',e.message);});await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><body><button id="start" onclick="beginFixture()">로그인</button><div id="loading-overlay" style="display:none"><span id="loading-text"></span></div><div id="home-unauth-content">로그인 필요</div><div id="home-auth-content" hidden>계정 화면</div><div id="auth-modal"></div><div id="signup-modal"></div><div id="user-sync-status" hidden><span data-sync-message></span><button onclick="retryFixture()" hidden>다시 시도</button></div><button data-requires-inventory>등록</button><div id="inventory">동기화 중</div><script>${fs.readFileSync('public/login-timing.js','utf8')}</script><script>${code}</script></body>`}));await page.goto('https://synthetic.web.app/');return errors;}
test('통합 초기 조회·claims·보유 정보 반영까지 전체 로딩을 유지하고 추가 HTTP를 만들지 않는다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),errors=await fixture(p),logs=[];
 p.on('console',m=>{if(m.text().startsWith('[YGO login'))logs.push(m.text());});
 await p.evaluate(()=>setServiceLoginPending(true));
 assert.equal(await p.locator('#loading-text').textContent(),'로그인 중...');
 await p.evaluate(()=>endOtherLoading());assert.equal(await p.locator('#loading-text').textContent(),'로그인 중...');
 await p.locator('#start').click();assert(await p.locator('#loading-overlay').isVisible());
 assert.equal(await p.locator('#loading-text').textContent(),'내 인벤토리 로딩 중...');
 assert(!logs.some(x=>x.startsWith('[YGO login entry timing]')));
 await p.evaluate(()=>endOtherLoading());assert(await p.locator('#loading-overlay').isVisible());
 assert.equal(await p.locator('#loading-text').textContent(),'내 인벤토리 로딩 중...');
 await p.evaluate(()=>releaseSync());await p.waitForFunction(()=>fixtureState().status==='ready');
 assert.equal(await p.locator('#loading-overlay').isVisible(),false);
 assert.equal(await p.locator('[data-requires-inventory]').isDisabled(),false);
 assert.equal(await p.locator('#inventory').textContent(),'보유 카드');
 assert.deepEqual(await p.evaluate(()=>apiCalls),['getRegistrationStatus']);
 assert(logs.some(x=>x.startsWith('[YGO login entry timing]')));assert(logs.some(x=>x.startsWith('[YGO login timing]')));
 assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
test('호환 별도 조회와 claims 갱신도 전체 화면을 가리며 다른 조회 종료가 닫지 못한다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),errors=await fixture(p);
 await p.evaluate(()=>{summaryOnly=true;holdClaims=true;});await p.locator('#start').click();
 await p.waitForFunction(()=>fixtureState().status==='loading');assert(await p.locator('#loading-overlay').isVisible());
 assert.equal(await p.locator('#loading-text').textContent(),'내 인벤토리 로딩 중...');
 assert(await p.locator('[data-requires-inventory]').isDisabled());
 await p.evaluate(()=>endOtherLoading());assert(await p.locator('#loading-overlay').isVisible());
 await p.evaluate(()=>releaseSync());await p.waitForTimeout(30);
 assert.equal(await p.evaluate(()=>fixtureState().status),'loading');assert(await p.locator('#loading-overlay').isVisible());
 await p.evaluate(()=>releaseClaims());await p.waitForFunction(()=>fixtureState().status==='ready');
 assert.equal(await p.locator('#loading-overlay').isVisible(),false);
 assert.deepEqual(await p.evaluate(()=>apiCalls),['getRegistrationStatus','getUserData']);assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
test('동기화 실패는 로딩을 해제하고 오류를 표시하며 명시 재시도로만 복구한다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),errors=await fixture(p);
 await p.evaluate(()=>{summaryOnly=true;failSync=true;});await p.locator('#start').click();await p.evaluate(()=>releaseSync());
 await p.waitForFunction(()=>fixtureState().status==='error');assert.equal(await p.locator('#loading-overlay').isVisible(),false);
 assert(await p.locator('#user-sync-status button').isVisible());assert(await p.locator('[data-requires-inventory]').isDisabled());
 await p.evaluate(()=>{failSync=false;});await p.locator('#user-sync-status button').click();
 await p.waitForFunction(()=>fixtureState().status==='ready');assert.equal(await p.evaluate(()=>apiCalls.filter(x=>x==='getUserData').length),2);
 assert.equal(await p.locator('#loading-overlay').isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
test('동기화 중 로그아웃하면 늦은 보유 정보·완료 상태를 적용하거나 로딩을 다시 열지 않는다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),errors=await fixture(p);
 await p.evaluate(()=>{summaryOnly=true;});await p.locator('#start').click();await p.waitForFunction(()=>fixtureState().status==='loading');
 await p.evaluate(()=>signOutFixture());await p.evaluate(()=>releaseSync());await p.waitForFunction(()=>!fixtureState().signedIn);
 assert.equal(await p.locator('#home-auth-content').isVisible(),false);assert.equal(await p.locator('#loading-overlay').isVisible(),false);
 assert.equal(await p.evaluate(()=>events.includes('inventory-applied')),false);assert.deepEqual(errors,[]);
 }finally{await b.close();}
});


test('최초 세션 확인은 실제 로그인·보유 로딩과 문구를 구분한다', async () => {
 const b=await chromium.launch();try {
  const p=await b.newPage(),errors=await fixture(p);
  await p.addScriptTag({content:fn('checkAndHideInitialLoading')});
  await p.evaluate(()=>{UserStore.isInitialSyncDone=true;window.isAuthInitialized=false;checkAndHideInitialLoading();});
  assert.equal(await p.locator('#loading-text').textContent(),'로그인 상태 확인 중...');
  await p.evaluate(()=>{window.isAuthInitialized=true;checkAndHideInitialLoading();});
  assert.equal(await p.locator('#loading-overlay').isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
