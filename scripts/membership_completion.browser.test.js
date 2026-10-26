'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0);const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
const ytStart=source.indexOf('let youtubeMembershipVerificationPending = false;');
const yt=source.slice(ytStart,source.indexOf('/**',ytStart));
const dcStart=source.indexOf('let discordMembershipStarting = false;');
const dc=source.slice(dcStart,source.indexOf('/**\n * 멤버십 인증 메시지',dcStart));
for(const provider of ['youtube','discord'])for(const status of ['none','active']){
 test(`${provider} 외부 ${status} 결과는 소유자 혜택을 유지하며 실제 DOM 완료 처리를 끝낸다`,async()=>{
  const browser=await chromium.launch();try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">
    <button id="run">확인</button><div id="auth-capsule-btn"><span class="auth-icon">diamond</span><span id="auth-btn-text">내 계정</span></div>
    <section data-account-card><span data-account="membership">소유자</span></section>
    <div id="membership-auth-modal" role="dialog">인증 중</div><div id="toasts"></div><output id="reloaded">0</output><output id="done"></output>
    <script>
    const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'},authStateRevision=1,registrationCheckPending=false;
    const firebase={auth:()=>({currentUser:user})};window.isAuthInitialized=true;
    function followMembershipClaims(){}function requireInventoryReady(){return true;}function syncMembershipHeader(){}function setInventorySyncStatus(status){UserStore.inventorySyncStatus=status;}
    function showToast(message){const el=document.createElement('p');el.textContent=message;document.getElementById('toasts').append(el);}
    function loadUserData(){document.getElementById('reloaded').value=String(Number(document.getElementById('reloaded').value)+1);}
    const M={Modal:{getInstance:el=>({close(){el.hidden=true;}})}};function resetMembershipVerifyModal(){}
    async function getYoutubeAccessTokenViaSecondaryApp(){return 'synthetic-token';}
    async function callApi(name,_params,body){if(body?.membershipPrepare)return{success:true,membershipPreparation:{version:1,target:name,ready:true}};return name.startsWith('start')?{success:true,uid:user.uid,verificationId:'synthetic'}:
      {success:true,uid:user.uid,membership:{status:'active',type:'account',levelName:'소유자'},sourceMembership:{status:'${status}',type:'${provider==='youtube'?'csv':'discord'}'},membershipClaims:{status:'pending'}};}
    ${['getAccountCardElement','renderMembershipSettings','applyMembershipStatus','refreshMembershipClaims'].map(fn).join('\n')}
    ${provider==='youtube'?yt+dc:dc}
    ${provider==='discord'?`sessionStorage.setItem('discord_membership_verification',JSON.stringify({uid:user.uid,state:'${'a'.repeat(64)}',expiresAt:Date.now()+300000}));`:''}
    document.getElementById('run').onclick=async()=>{await ${provider==='youtube'?'startYoutubeMembershipVerify()':'handleDiscordOAuthCallback()'};document.getElementById('done').value='완료';};
    </script>`}));
   await page.goto('https://synthetic.web.app/'+(provider==='discord'?'?code=synthetic&state='+'a'.repeat(64):''));
   await page.getByRole('button',{name:'확인',exact:true}).click();await page.waitForFunction(()=>document.getElementById('done').value==='완료');
   assert.equal(await page.locator('#reloaded').textContent(),'0');assert.equal(await page.locator('[data-account="membership"]').textContent(),'소유자');
   assert.equal(await page.locator('#auth-capsule-btn .auth-icon').textContent(),'diamond');
   const toasts=await page.locator('#toasts').innerText();assert(!/완료하지 못|만료되었거나/.test(toasts));
   if(provider==='youtube'&&status==='none')assert.match(toasts,/등록되어 있지|멤버십 역할이 없습니다/);else {assert.equal(toasts,'');assert.equal(await page.locator('#auth-capsule-btn').getAttribute('data-membership-verification'),'complete');}
   assert.equal(await page.getByRole('dialog').isVisible(),false);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}
