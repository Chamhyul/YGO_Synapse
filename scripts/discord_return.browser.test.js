const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8'),css=fs.readFileSync('public/style.css','utf8'),layout=fs.readFileSync('public/styles/layout.css','utf8'),components=fs.readFileSync('public/styles/components.css','utf8');
const timing=fs.readFileSync('public/login-timing.js','utf8');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0,name);const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
const start=source.indexOf('let discordMembershipStarting = false;'),dc=source.slice(start,source.indexOf('/**\n * 멤버십 인증 메시지',start));
async function fixture(p,{mobile=false,pending=false,fail=false}={}){
 const errors=[],logs=[];p.setDefaultTimeout(5000);p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.text().startsWith('[YGO auth recovery]'))logs.push(JSON.parse(m.text().slice(m.text().indexOf('{'))));});
 await p.clock.install({time:new Date('2026-10-21T03:00:00Z')});await p.clock.pauseAt(new Date('2026-10-21T03:00:00Z'));
 await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><html class="${mobile?'is-mobile-device':''}"><style>:root{--navi-sidebar-width:240px;--navi-sidebar-compact-width:80px;--theme-000:blue;} ${components} ${layout} ${css} #run{margin-top:100px;}</style>
 <body><header class="app-header"><button id="auth-capsule-btn" class="ui-button color-type000 app-header-button shape-capsule auth-capsule is-logged-in"><i class="material-icons auth-icon color-text-theme">account_circle</i><span id="auth-btn-text" class="auth-text">내 계정</span></button></header><main class="app-page-content"><button id="run">완료 처리</button></main><div id="loading-overlay" style="display:none"><span id="loading-text"></span></div><output id="toasts"></output><script>${timing}</script><script>
 const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'};let currentUser=user,authStateRevision=1,registrationCheckPending=false,reloads=0;
 const firebase={auth:()=>({currentUser})};window.isAuthInitialized=true;
 let releaseVerify,releaseSync;const verifyBlocked=new Promise(r=>releaseVerify=r),syncBlocked=new Promise(r=>releaseSync=r);
 function requireInventoryReady(){return true;}function syncMembershipHeader(){renderDiscordMembershipHeader();}
 function applyMembershipStatus(){}function setInventorySyncStatus(status){UserStore.inventorySyncStatus=status;}function showToast(message){document.getElementById('toasts').textContent=message;}
 async function loadUserData(){reloads++;showLoading(true,'내 인벤토리 로딩 중...');await syncBlocked;UserStore.inventorySyncStatus='ready';showLoading(false);return true;}
 async function callApi(){await verifyBlocked;${fail?"throw Error('synthetic');":''}${pending?"UserStore.inventorySyncStatus='loading';showLoading(true,'내 인벤토리 로딩 중...');":''}return{success:true,uid:user.uid,membership:{status:'active'},sourceMembership:{status:'active',type:'discord'}};}
 ${fn('showLoading')}
 ${dc}
 sessionStorage.setItem('discord_membership_verification',JSON.stringify({uid:user.uid,state:'${'a'.repeat(64)}',expiresAt:Date.now()+300000}));
 document.getElementById('run').onclick=()=>handleDiscordOAuthCallback();
 </script></body></html>`}));
 await p.goto('https://synthetic.web.app/?code=synthetic&state='+'a'.repeat(64));return{errors,logs};
}
for(const mobile of [false,true])for(const pending of [false,true])test(`Discord ${mobile?'모바일':'데스크톱'} ${pending?'필수 동기화':'목록 재사용'}: 결과 즉시 완료·5초 복귀와 필수 전체 로딩 유지`,async()=>{
 const b=await chromium.launch();try{
  const p=await b.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900}}),{errors,logs}=await fixture(p,{mobile,pending});
  await p.locator('#run').click();assert.equal(await p.locator('#auth-btn-text').innerText(),'멤버십 인증 중');assert(await p.locator('.is-membership-pending').isVisible());
  const spinner=await p.locator('.is-membership-pending').evaluate(e=>{const s=getComputedStyle(e);return{width:parseFloat(s.width),height:parseFloat(s.height),border:parseFloat(s.borderTopWidth),animation:s.animationName,text:e.textContent};});assert(spinner.width>=15&&spinner.height>=15&&spinner.border>=2);assert.equal(spinner.animation,'spinDash');assert.equal(spinner.text,'sync');
  const widthAnimation=await p.locator('#auth-capsule-btn').evaluate(e=>e.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>k.width)).map(a=>({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes().map(k=>k.width)})));assert.equal(widthAnimation.length,1);assert.equal(widthAnimation[0].duration,220);assert(widthAnimation[0].frames.every(x=>/px$/.test(x)));
  assert.equal(await p.locator('#auth-capsule-btn').getAttribute('aria-busy'),'true');
  await p.evaluate(()=>{document.getElementById('auth-btn-text').textContent='내 계정';syncMembershipHeader();});assert.equal(await p.locator('#auth-btn-text').innerText(),'멤버십 인증 중');
  await p.evaluate(()=>releaseVerify());
  if(pending){assert(await p.locator('#loading-overlay').isVisible());assert.equal(await p.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');assert(!logs.some(x=>x.kind==='discord'));await p.evaluate(()=>showLoading(false));assert(await p.locator('#loading-overlay').isVisible());await p.evaluate(()=>releaseSync());}
  assert.equal(await p.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');assert.equal(await p.locator('.is-membership-pending').count(),0);assert.equal(await p.locator('.auth-icon').textContent(),'diamond');assert.equal(await p.locator('#loading-overlay').isVisible(),false);assert.equal(await p.evaluate(()=>reloads),pending?1:0);assert.equal(await p.locator('#toasts').textContent(),'');
  const log=logs.find(x=>x.kind==='discord');assert.equal(log.outcome,'ready');assert(log.spans.some(s=>s.name==='final_sync'&&s.ok));
  await p.clock.fastForward(4999);assert.equal(await p.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');await p.clock.fastForward(1);assert.equal(await p.locator('#auth-btn-text').textContent(),'내 계정');assert.equal(await p.locator('#auth-capsule-btn').getAttribute('data-membership-verification'),null);
  assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
test('Discord 실패는 헤더 대기를 해제하고 기존 오류 안내를 유지한다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),{errors,logs}=await fixture(p,{fail:true});await p.locator('#run').click();await p.evaluate(()=>releaseVerify());assert.equal(await p.locator('#auth-btn-text').textContent(),'내 계정');assert.equal(await p.locator('.is-membership-pending').count(),0);assert.match(await p.locator('#toasts').textContent(),/다시 인증/);assert.equal(logs.find(x=>x.kind==='discord').outcome,'failed');assert.deepEqual(errors,[]);}finally{await b.close();}
});
test('이전 완료 타이머는 새 인증 대기·로그아웃·다른 계정 상태를 덮어쓰지 않는다',async()=>{
 const b=await chromium.launch();try{const p=await b.newPage(),{errors}=await fixture(p);await p.evaluate(()=>setDiscordMembershipHeader('complete',user.uid));await p.clock.fastForward(4000);await p.evaluate(()=>setDiscordMembershipHeader('pending',user.uid));await p.clock.fastForward(1000);assert.equal(await p.locator('#auth-btn-text').textContent(),'멤버십 인증 중');
 await p.evaluate(()=>{UserStore.user=null;currentUser=null;syncMembershipHeader();});assert.equal(await p.locator('#auth-btn-text').textContent(),'로그인');
 await p.evaluate(()=>{UserStore.user=user;currentUser=user;setDiscordMembershipHeader('complete',user.uid);UserStore.user={uid:'other'};currentUser=UserStore.user;syncMembershipHeader();});assert.equal(await p.locator('#auth-btn-text').textContent(),'내 계정');assert.equal(await p.locator('#auth-capsule-btn').getAttribute('data-membership-verification'),null);assert.deepEqual(errors,[]);}finally{await b.close();}
});
