'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');const {chromium}=require('playwright');
const source=fs.readFileSync('public/script.js','utf8'),timing=fs.readFileSync('public/login-timing.js','utf8');
function fn(name){const i=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));const rest=source.slice(i),e=rest.slice(1).search(/\n(?:async )?function /);return rest.slice(0,e+1);}
for(const readonly of [false,true])test(`실제 브라우저 팝업·네트워크 계측은 클릭 활성과 인증 결과를 유지한다(open readonly=${readonly})`,async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage(),logs=[],errors=[];page.on('console',m=>{if(m.text().startsWith('[YGO '))logs.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());return route.fulfill({contentType:u.hostname==='identitytoolkit.googleapis.com'?'application/json':'text/html',headers:{'access-control-allow-origin':'*'},body:u.hostname==='identitytoolkit.googleapis.com'?'{}':'<button id="google-login-btn">Google</button><button id="twitter-login-btn">X</button>'});});
  await page.goto('https://synthetic.web.app/');
  await page.addScriptTag({content:timing});
  await page.addScriptTag({content:`const originalOpen=window.open;${readonly?"Object.defineProperty(window,'open',{value:originalOpen,writable:false,configurable:true});":''}
   const IS_LOCAL_DEV=false;let pendingServiceAuthUser=null,loginInProgress=false,registrationCheckPending=false;window.events=[];
   const getProviderInstance=()=>({});function retryServiceLoginConfirmation(){}function setServiceLoginPending(){}function toggleLoginBtn(){document.querySelectorAll('button').forEach(b=>b.disabled=loginInProgress);}function showToast(){events.push('toast');}function reportAuthFailure(){events.push('error');}
   const firebase={auth:()=>({signInWithPopup:async()=>{events.push(navigator.userActivation.isActive?'active':'inactive');const p=window.open('/synthetic-popup','fixture-popup');if(!p)throw {code:'auth/popup-blocked'};events.push('opened');
    await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=PRIVATE').then(r=>r.json());await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=PRIVATE').then(r=>r.json());window.syntheticFlow=YgoLoginTiming.start();p.close();return {private:'PRIVATE_CREDENTIAL'};},signInWithRedirect:async()=>events.push('redirect')})};
   ${fn('getServiceSignInMode')}\n${fn('signInWithProvider')}\ndocument.getElementById('google-login-btn').onclick=()=>signInWithProvider('google');`});
  await page.getByRole('button',{name:'Google',exact:true}).click();await page.waitForFunction(()=>window.syntheticFlow&&!document.getElementById('google-login-btn').disabled);
  await page.evaluate(()=>window.syntheticFlow.finish('ready'));
  assert.equal(await page.evaluate(()=>window.open===originalOpen),true);assert.deepEqual(await page.evaluate(()=>events),['active','opened']);assert.deepEqual(errors,[]);
  const rows=logs.map(s=>JSON.parse(s.slice(s.indexOf('] ')+2))),popup=rows.find(r=>r.event==='login_client_timing').popup;
  assert.equal(popup.outcome,'resolved');assert.equal(popup.openHookInstalled,!readonly);assert.equal(popup.resources.filter(r=>['auth_idp','auth_lookup'].includes(r.category)).length,2);
  if(!readonly){assert.equal(popup.opened,true);assert(Number.isFinite(popup.marks.window_open_call));}assert(!logs.join('').includes('PRIVATE'));
 }finally{await browser.close();}
});
