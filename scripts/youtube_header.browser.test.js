'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8');
const css=['public/styles/tokens.css','public/styles/base.css','public/styles/components.css','public/styles/layout.css','public/style.css'].map(p=>fs.readFileSync(p,'utf8')).join('\n');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0,name);const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
const ytStart=source.indexOf('let youtubeMembershipVerificationPending = false;'),yt=source.slice(ytStart,source.indexOf('/**',ytStart));
const sharedStart=source.indexOf('let discordMembershipStarting = false;'),shared=source.slice(sharedStart,source.indexOf('/**\n * 멤버십 인증 메시지',sharedStart));
async function fixture(page,{mobile=false,dark=false,fail='',member=true,reduced=false,needsSync=true}={}){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
 await page.clock.install({time:new Date('2026-10-22T11:20:00Z')});await page.clock.pauseAt(new Date('2026-10-22T11:20:00Z'));
 if(reduced)await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><html class="${mobile?'is-mobile-device':''} ${dark?'dark-mode':''}"><style>:root{--navi-sidebar-width:240px;--navi-sidebar-compact-width:80px;--theme-000:blue;}${css} #run{margin-top:120px;}</style>
 <body><header class="app-header"><button id="auth-capsule-btn" class="ui-button color-type000 app-header-button shape-capsule auth-capsule is-logged-in"><i class="material-icons auth-icon color-text-theme">account_circle</i><span id="auth-btn-text" class="auth-text">내 계정</span></button></header><main class="app-page-content"><button id="run">YouTube 인증</button></main><div id="membership-auth-modal"></div><div id="loading-overlay" style="display:none"><span id="loading-text"></span></div><output id="toasts"></output><output id="done"></output><script>
 const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'};let currentUser=user,authStateRevision=1,registrationCheckPending=false,popups=0,starts=0,verifies=0,reloads=0;
 const firebase={auth:()=>({currentUser})};window.isAuthInitialized=true;
 let releasePopup,rejectPopup,releaseVerify,releaseSync;const popup=new Promise((r,j)=>{releasePopup=r;rejectPopup=j;}),verify=new Promise(r=>releaseVerify=r),sync=new Promise(r=>releaseSync=r);
 function requireInventoryReady(){return UserStore.inventorySyncStatus==='ready';}function syncMembershipHeader(){renderDiscordMembershipHeader();}
 function setInventorySyncStatus(status){UserStore.inventorySyncStatus=status;}function showToast(message){document.getElementById('toasts').textContent+=message;}function applyMembershipStatus(){syncMembershipHeader();}
 function followMembershipClaims(){}function resetMembershipVerifyModal(){}const M={Modal:{getInstance:el=>({close(){el.hidden=true;}})}};
 function getYoutubeAccessTokenViaSecondaryApp(){popups++;return popup;}
 async function callApi(name,_params,body){if(body?.membershipPrepare)return{success:true,membershipPreparation:{version:1,target:name,ready:true}};if(name.startsWith('start')){starts++;return{success:true,uid:user.uid,verificationId:'synthetic'};}verifies++;await verify;${needsSync ? "UserStore.inventorySyncStatus='error';" : ''}${fail==='api'?"throw Object.assign(Error('synthetic-secret'),{code:'APPCHECK_UNAVAILABLE'});":''}return{success:true,uid:user.uid,membership:{status:'${member?'active':'none'}'},sourceMembership:{status:'${member?'active':'none'}',type:'csv'},membershipClaims:{status:'pending'}};}
 async function loadUserData(){reloads++;UserStore.inventorySyncStatus='loading';showLoading(true,'내 인벤토리 로딩 중...');await sync;UserStore.inventorySyncStatus='${fail==='sync'?'error':'ready'}';showLoading(false);${fail==='sync'?"showToast('합성 동기화 실패');return false;":'return true;'}}
 ${fn('showLoading')}
 ${fn('refreshMembershipClaims')}
 ${yt}
 ${shared}
 document.getElementById('run').onclick=async()=>{await startYoutubeMembershipVerify();document.getElementById('done').value='완료';};
 </script></body></html>`}));
 await page.goto('https://synthetic.web.app/');return errors;
}
for(const mobile of [false,true])for(const dark of [false,true])test(`YouTube ${mobile?'모바일':'데스크톱'} ${dark?'다크':'라이트'}는 결과 즉시 완료를 표시하고 필수 전체 로딩·5초 복귀를 유지한다`,async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900}}),errors=await fixture(page,{mobile,dark});
 await page.locator('#run').click();assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 중');assert.equal(await page.locator('#auth-capsule-btn').getAttribute('aria-busy'),'true');assert(await page.locator('.is-membership-pending').isVisible());
 const spinner=await page.locator('.is-membership-pending').evaluate(el=>{const s=getComputedStyle(el);return{animation:s.animationName,border:parseFloat(s.borderTopWidth),width:parseFloat(s.width),height:parseFloat(s.height)};});assert.equal(spinner.animation,'spinDash');assert(spinner.border>=2&&spinner.width>=15&&spinner.height>=15);
 assert.equal(await page.locator('#auth-capsule-btn').evaluate(el=>el.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>k.width))[0].effect.getTiming().duration),220);
 if(process.env.HEADER_PROOF_DIR&&!mobile&&!dark){await page.clock.fastForward(250);await page.locator('#auth-capsule-btn').screenshot({path:process.env.HEADER_PROOF_DIR+'/youtube-header-v52-pending.png'});}
 await page.evaluate(()=>{startYoutubeMembershipVerify();startDiscordMembershipVerify();});assert.deepEqual(await page.evaluate(()=>({popups,starts,verifies})),{popups:1,starts:1,verifies:0});
 await page.evaluate(()=>releasePopup('synthetic-token'));assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 중');
 await page.evaluate(()=>releaseVerify());await page.locator('#loading-overlay').waitFor({state:'visible'});assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');await page.evaluate(()=>showLoading(false));assert(await page.locator('#loading-overlay').isVisible());
 await page.evaluate(()=>releaseSync());await page.waitForFunction(()=>document.getElementById('done').value==='완료');assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');assert.equal(await page.locator('.auth-icon').innerText(),'diamond');assert.equal(await page.locator('.is-membership-pending').count(),0);assert.equal(await page.locator('#loading-overlay').isVisible(),false);assert.equal(await page.locator('#toasts').textContent(),'');assert.equal(await page.evaluate(()=>reloads),1);
 await page.clock.fastForward(4999);assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');await page.clock.fastForward(1);assert.equal(await page.locator('#auth-btn-text').textContent(),'내 계정');assert.equal(await page.locator('#auth-capsule-btn').getAttribute('data-membership-verification'),null);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
for(const kind of ['popup','api','sync','account'])test(`YouTube ${kind} 실패는 스피너를 해제하고 검증된 인증 결과와 동기화 오류를 구분한다`,async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage(),errors=await fixture(page,{fail:kind});await page.locator('#run').click();
 if(kind==='popup')await page.evaluate(()=>rejectPopup(Object.assign(Error('synthetic-secret'),{code:'auth/popup-closed-by-user'})));
 else{await page.evaluate(()=>releasePopup('synthetic-token'));if(kind==='account')await page.evaluate(()=>{authStateRevision++;UserStore.user={uid:'other'};currentUser=UserStore.user;});await page.evaluate(()=>releaseVerify());if(kind==='sync'){await page.locator('#loading-overlay').waitFor({state:'visible'});await page.evaluate(()=>releaseSync());}}
 await page.waitForFunction(()=>document.getElementById('done').value==='완료');assert.equal(await page.locator('.is-membership-pending').count(),0);assert.equal(await page.locator('#auth-btn-text').textContent(),kind==='sync'?'멤버십 인증 완료':'내 계정');assert.equal(await page.locator('#auth-capsule-btn').getAttribute('data-membership-verification'),kind==='sync'?'complete':null);if(kind==='sync'){assert.equal(await page.evaluate(()=>UserStore.inventorySyncStatus),'error');assert.match(await page.locator('#toasts').textContent(),/동기화 실패/);}assert(!String(await page.locator('#toasts').textContent()).includes('synthetic-secret'));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('YouTube 비회원 결과는 회원 아이콘을 부여하지 않고 안내하며 동작 줄이기를 유지한다',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage(),errors=await fixture(page,{member:false,reduced:true});await page.locator('#run').click();assert.equal(await page.locator('#auth-capsule-btn').evaluate(el=>el.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>k.width)).length),0);await page.evaluate(()=>releasePopup('synthetic-token'));await page.evaluate(()=>releaseVerify());await page.locator('#loading-overlay').waitFor({state:'visible'});await page.evaluate(()=>releaseSync());await page.waitForFunction(()=>document.getElementById('done').value==='완료');assert.equal(await page.locator('#auth-btn-text').textContent(),'멤버십 인증 완료');assert.equal(await page.locator('.auth-icon').textContent(),'account_circle');assert.match(await page.locator('#toasts').textContent(),/등록되어 있지 않습니다/);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('YouTube 준비된 인벤토리는 전체 로딩 없이 완료하고 pending claims만 후속 확인한다',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage(),errors=await fixture(page,{needsSync:false});
 await page.locator('#run').click();await page.evaluate(()=>releasePopup('synthetic-token'));await page.evaluate(()=>releaseVerify());
 await page.waitForFunction(()=>document.getElementById('done').value==='완료');
 assert.equal(await page.evaluate(()=>reloads),0);assert.equal(await page.locator('#loading-overlay').isVisible(),false);
 assert.equal(await page.evaluate(()=>UserStore.claimsSyncStatus),'pending');assert.equal(await page.locator('#auth-btn-text').innerText(),'멤버십 인증 완료');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
