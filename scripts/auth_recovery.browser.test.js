'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const app=fs.readFileSync('public/script.js','utf8'),timing=fs.readFileSync('public/login-timing.js','utf8');
function fn(name){const start=app.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0);const tail=app.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
const dcStart=app.indexOf('let discordMembershipStarting = false;'),dc=app.slice(dcStart,app.indexOf('/**\n * 멤버십 인증 메시지',dcStart));
for(const mode of ['late','expired','switched','appcheck-denied'])test(`실제 Chromium Discord 복귀 ${mode}: 보안 장벽·URL 정리·완료 안내`,async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage(),errors=[],logs=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('[YGO auth recovery]'))logs.push(JSON.parse(m.text().slice(m.text().indexOf('] ')+2)));});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><button id="run">복귀</button><div id="overlay">사용자 데이터 동기화 중</div><p id="notice"></p><output id="done"></output><output id="writes">0</output><output id="reload">0</output><script>
   ${timing}
   const mode=${JSON.stringify(mode)},realSetTimeout=window.setTimeout.bind(window),user={uid:'synthetic'},authStateRevision=1;
   let clock=0,registrationCheckPending=true;Date.now=()=>clock;window.isAuthInitialized=false;
   const UserStore={user:null,settings:{},inventorySyncStatus:'loading'};
   const firebase={auth:()=>({currentUser:mode==='switched'?{uid:'other'}:user}),appCheck:()=>({getToken:async()=>{if(mode==='appcheck-denied')throw{code:'appCheck/throttled',customData:{httpStatus:403,private:'PRIVATE'},message:'PRIVATE'};return{token:'PRIVATE'};}})};
   window.setTimeout=(callback,delay)=>delay===5000?realSetTimeout(callback,delay):realSetTimeout(()=>{clock+=delay*100;if(clock>=65000){registrationCheckPending=false;UserStore.user=user;UserStore.inventorySyncStatus='ready';window.isAuthInitialized=true;document.getElementById('overlay').hidden=true;}callback();},0);
   function syncMembershipHeader(){}function requireInventoryReady(){return true;}function showToast(m){document.getElementById('notice').textContent=m;}
   function applyMembershipStatus(){}function loadUserData(){document.getElementById('reload').value='1';}
   ${fn('getApiAppCheckToken')}
   async function callApi(){await getApiAppCheckToken();document.getElementById('writes').value='1';return{success:true,uid:user.uid,membership:{status:'active',type:'account'},sourceMembership:{status:'none',type:'discord'}};}
   ${dc}
   sessionStorage.setItem('discord_membership_verification',JSON.stringify({uid:user.uid,state:'${'a'.repeat(64)}',expiresAt:mode==='expired'?20000:300000}));
   document.getElementById('run').onclick=async()=>{await handleDiscordOAuthCallback();document.getElementById('done').value='완료';};
   </script>`}));
  await page.goto('https://synthetic.web.app/?code=PRIVATE_CODE&state='+'a'.repeat(64));
  assert.equal(await page.locator('#overlay').isVisible(),true);await page.getByRole('button',{name:'복귀',exact:true}).click();await page.waitForFunction(()=>document.getElementById('done').value==='완료');
  assert(!page.url().includes('PRIVATE_CODE'));assert.equal(await page.evaluate(()=>sessionStorage.getItem('discord_membership_verification')),null);
  assert.equal(await page.locator('#writes').textContent(),mode==='late'?'1':'0');assert.equal(await page.locator('#reload').textContent(),'0');
  const notice=await page.locator('#notice').innerText();if(mode==='late')assert.equal(notice,'');else assert.match(notice,mode==='appcheck-denied'?/앱 인증/:/만료되었거나/);
  const trace=logs.find(l=>l.kind==='discord');assert.equal(trace.outcome,mode==='late'?'ready':'failed');assert(!JSON.stringify(logs).includes('PRIVATE'));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
