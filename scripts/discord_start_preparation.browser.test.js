'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright'),source=fs.readFileSync('public/script.js','utf8');
const a=source.indexOf('let discordMembershipStarting = false;'),b=source.indexOf('// Firebase 초기화',a);
test('Chromium: 준비 후 실제 클릭은 새 시작 요청 없이 OAuth navigation을 바로 요청한다',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();let nav;
  await page.route('https://discord.com/**',route=>{nav=true;return route.fulfill({contentType:'text/html',body:'<p>synthetic OAuth</p>'});});
  await page.route('https://synthetic.invalid/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><button id="go">Discord</button>
   <script>
   let authStateRevision=1;const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'},firebase={auth:()=>({currentUser:user})};
   let startCalls=0;const requireInventoryReady=()=>true,beginMembershipPreparation=()=>{},showToast=()=>{};
   async function callApi(){startCalls++;const state='a'.repeat(64);return{success:true,uid:user.uid,verificationId:state,authorizationUrl:'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,redirect_uri:location.origin+'/'})};}
   ${source.slice(a,b)}
   setDiscordMembershipHeader=()=>{};
   prepareDiscordMembershipStart();
   document.getElementById('go').onclick=()=>{const at=performance.now();startDiscordMembershipVerify();sessionStorage.setItem('syntheticClickMs',String(performance.now()-at));sessionStorage.setItem('syntheticStartCalls',String(startCalls));};
   </script>`}));
  await page.goto('https://synthetic.invalid/');await page.waitForFunction(()=>discordMembershipStartPreparation?.result);
  await Promise.all([page.waitForURL('https://discord.com/**'),page.click('#go')]);assert(nav);
  await page.goto('https://synthetic.invalid/result');
  const result=await page.evaluate(()=>({calls:Number(sessionStorage.getItem('syntheticStartCalls')),clickHandlerMs:Number(sessionStorage.getItem('syntheticClickMs'))}));
  assert.equal(result.calls,1);assert(Number.isFinite(result.clickHandlerMs));console.log('synthetic prepared click handler '+result.clickHandlerMs.toFixed(3)+'ms; start API calls '+result.calls);
 }finally{await browser.close();}
});
