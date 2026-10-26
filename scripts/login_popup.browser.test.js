'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium,devices}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8');
function fn(name){const i=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(i>=0);const t=source.slice(i),e=t.slice(1).search(/\n(?:async )?function /);return t.slice(0,e+1);}
for(const [label,device,error,expected] of [
 ['desktop',null,null,['popup']],['blocked',null,'auth/popup-blocked',['popup','redirect']],
 ['cancel',null,'auth/popup-closed-by-user',['popup']],['network',null,'auth/network-request-failed',['popup']],
 ['iPhone',devices['iPhone 13'],null,['redirect']],['Android',devices['Pixel 5'],null,['redirect']]]){
 test(`실제 클릭의 ${label} 로그인 선택·활성·실패 복원`,async()=>{
  const browser=await chromium.launch({headless:true});try{
   const context=await browser.newContext(device||{}),page=await context.newPage();
   await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<button id="google-login-btn">Google</button><button id="twitter-login-btn">X</button>'}));
   await page.goto('https://synthetic.web.app/');
   await page.addScriptTag({content:fs.readFileSync('public/login-timing.js','utf8')});
   await page.addScriptTag({content:`const IS_LOCAL_DEV=false;let pendingServiceAuthUser=null,loginInProgress=false,registrationCheckPending=false;window.events=[];const getProviderInstance=()=>({});function retryServiceLoginConfirmation(){events.push('retry');}function setServiceLoginPending(v){document.body.dataset.pending=String(v);}function toggleLoginBtn(){document.querySelectorAll('button').forEach(b=>b.disabled=loginInProgress||registrationCheckPending);}function showToast(){events.push('toast');}function reportAuthFailure(s){events.push(s);}const firebase={auth:()=>({signInWithPopup:async()=>{events.push('popup');events.push(navigator.userActivation.isActive?'active':'inactive');${error?`throw {code:${JSON.stringify(error)}};`:''}},signInWithRedirect:async()=>events.push('redirect')})};${fn('getServiceSignInMode')}\n${fn('signInWithProvider')}\ndocument.getElementById('google-login-btn').onclick=()=>signInWithProvider('google');`});
   await page.getByRole('button',{name:'Google',exact:true}).click();
   await page.waitForFunction(()=>!document.getElementById('google-login-btn').disabled);
   const events=await page.evaluate(()=>window.events);assert.deepEqual(events.filter(e=>['popup','redirect'].includes(e)),expected);
   if(expected.includes('popup'))assert(events.includes('active'),'사용자 클릭 활성 상태에서 팝업 시작');
   if(error&&error!=='auth/popup-blocked'){assert(events.includes('toast'));assert.equal(await page.locator('body').getAttribute('data-pending'),'false');}
   else{assert(!events.includes('toast'));assert.equal(await page.locator('body').getAttribute('data-pending'),'true');}
  }finally{await browser.close();}
 });
}
