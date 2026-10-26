'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const {fulfillTestWebAsset}=require('../docker/offline-web-assets.cjs');
const origin='http://127.0.0.1:5019';
const endpoint='https://asia-northeast3-ygo-synapse.cloudfunctions.net/manageAdminRole';
function pageHtml({role,delayed,fullAuth}){
 const mock=`<script>
 const syntheticOwner={uid:'synthetic-owner',getIdToken:async()=>'synthetic-token'};
 const listeners=[];let redirectDone;
 const auth={currentUser:${delayed?'null':'syntheticOwner'},onAuthStateChanged(callback){listeners.push(callback);${delayed?'':'queueMicrotask(()=>callback(auth.currentUser));'}return()=>{};},getRedirectResult:()=>${delayed?'new Promise(resolve=>{redirectDone=resolve;})':'Promise.resolve()'},signOut:async()=>window.setSyntheticAuthUser(null)};
 window.setSyntheticAuthUser=user=>{auth.currentUser=user;for(const callback of listeners)callback(user);};
 window.restoreSyntheticAuth=()=>{window.setSyntheticAuthUser(syntheticOwner);redirectDone?.();};
 window.firebase={auth:()=>auth};
 </script>`;
 return fs.readFileSync('functions/templates/admin/settings.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,script=>(fullAuth?/src="\/(?:admin-settings|admin-session|admin|auth-session)\.js/:/src="\/admin-settings\.js/).test(script)?script:'').replace(/(<div id="admin-content"[^>]*?) hidden>/,`$1 data-admin-uid="synthetic-owner" data-admin-role="${role}">`).replace('id="admin-login" class="admin-login"','id="admin-login" class="admin-login" hidden').replace('</head>',mock+'</head>');
}
async function fixture(page,{lost=false,role='owner',delayed=false,fullAuth=false}={}){
 const calls=[],errors=[],sessions=[];let bot={uid:'synthetic-bot',email:'bot@example.invalid',displayName:'합성 봇 계정',role:'none',disabled:false};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  if(await fulfillTestWebAsset(route))return;
  const url=new URL(route.request().url());
  if(url.href===endpoint){
   const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
   const body=route.request().postDataJSON();calls.push(body);
   assert.equal(route.request().headers().authorization,'Bearer synthetic-token');
   let data;
   if(body.action==='settingsList')data={accounts:[{uid:'synthetic-owner',displayName:'합성 소유자',role:'owner',disabled:false}],nextPageToken:null};
   else if(body.action==='settingsLookup')data={account:bot};
   else {bot={...bot,role:body.isAdmin?'admin':'none'};if(lost)return route.fulfill({status:503,headers,json:{success:false}});data={account:bot};}
   return route.fulfill({headers,json:{success:true,...data}});
  }
  if(url.origin!==origin)return route.abort();
  if(url.pathname==='/admin/settings')return route.fulfill({contentType:'text/html',body:pageHtml({role,delayed,fullAuth})});
  if(url.pathname.startsWith('/admin/session')){sessions.push(url.pathname);return route.fulfill({status:204});}
  if(!/^\/(styles\/|admin-settings\.js|admin-session\.js|admin\.js|auth-session\.js)/.test(url.pathname))return route.fulfill({status:404});
  const file=path.join(process.cwd(),'public',url.pathname);return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
 });
 await page.goto(origin+'/admin/settings');
 if(role==='owner'&&!delayed){try{await page.waitForFunction(()=>document.getElementById('admin-accounts-status').textContent.includes('관리자 목록을 확인했습니다'),null,{timeout:5000});}catch(error){throw Error(JSON.stringify({status:await page.locator('#admin-accounts-status').textContent(),errors,actions:calls.map(call=>call.action)}));}}
 return{calls,errors,sessions};
}
const lookup=async page=>{await page.locator('#admin-accounts-query').fill('synthetic-bot');await page.getByRole('button',{name:'조회',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('admin-accounts-detail').hidden&&!document.getElementById('admin-accounts-grant').disabled);};
test('소유자 화면에서 계정 조회·권한 변경 확인/취소·모바일·로그아웃을 확인한다',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),f=await fixture(page);await lookup(page);
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'관리자 지정',exact:true}).click();assert.equal(f.calls.filter(c=>c.action==='settingsSetAdmin').length,0);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'관리자 지정',exact:true}).click();await page.waitForFunction(()=>document.getElementById('admin-accounts-role').textContent==='관리자');
  assert.deepEqual(f.calls.find(c=>c.action==='settingsSetAdmin'),{action:'settingsSetAdmin',targetUid:'synthetic-bot',isAdmin:true,expectedRole:'none'});
  const artifacts=process.env.TEST_ARTIFACT_DIR || '/tmp/admin-settings';fs.mkdirSync(artifacts,{recursive:true});
  await page.screenshot({path:path.join(artifacts,'관리자설정_데스크톱.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.classList.add('is-mobile-device','dark-mode'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(artifacts,'관리자설정_모바일다크.png'),fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'관리자 해제',exact:true}).click();await page.waitForFunction(()=>document.getElementById('admin-accounts-role').textContent==='일반 계정');
  await page.evaluate(()=>document.getElementById('admin-content').hidden=true);await page.waitForFunction(()=>document.getElementById('admin-accounts-fields').disabled);assert.deepEqual(f.errors,[]);
 }finally{await browser.close();}
});
test('쓰기 응답이 유실되면 자동 재시도하지 않고 계정 재조회까지 변경을 차단한다',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),f=await fixture(page,{lost:true});await lookup(page);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'관리자 지정',exact:true}).click();await page.waitForFunction(()=>document.getElementById('admin-accounts-status').textContent.includes('반영 결과를 확인하지 못했습니다'));
  assert.equal(await page.locator('#admin-accounts-grant').isDisabled(),true);assert.equal(await page.locator('#admin-accounts-revoke').isDisabled(),true);assert.equal(f.calls.filter(c=>c.action==='settingsSetAdmin').length,1);
  await page.getByRole('button',{name:'조회',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('admin-accounts-revoke').disabled);assert.equal(f.calls.filter(c=>c.action==='settingsSetAdmin').length,1);assert.deepEqual(f.errors,[]);
 }finally{await browser.close();}
});
test('소유자가 아닌 화면에서는 계정 관리 API를 호출하지 않는다',async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage(),f=await fixture(page,{role:'admin'});assert.equal(f.calls.length,0);}finally{await browser.close();}
});
test('실제 공통 인증 스크립트와 로그인 지연 복원을 함께 사용해도 설정 본문을 유지하고 재발급하지 않는다',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),f=await fixture(page,{delayed:true,fullAuth:true});
  for(let i=0;i<3;i++){
   if(i)await page.reload();
   assert.equal(await page.locator('#admin-content').isVisible(),true);
   assert.equal(await page.locator('#admin-login').isVisible(),false);
   assert.deepEqual(f.errors,[]);
   assert.equal(await page.locator('#admin-accounts-fields').evaluate(element=>element.disabled),true);
   assert.equal(f.calls.length,i);
   await page.evaluate(()=>window.restoreSyntheticAuth());
   await page.waitForFunction(()=>document.getElementById('admin-accounts-status').textContent.includes('관리자 목록을 확인했습니다'));
   assert.equal(await page.locator('#admin-content').isVisible(),true);
   assert.equal(await page.locator('#admin-login').isVisible(),false);
   assert.equal(f.calls.length,i+1);
   assert.deepEqual(f.sessions,[]);
  }
  await page.evaluate(()=>window.setSyntheticAuthUser(null));
  await page.waitForFunction(()=>document.getElementById('admin-content').hidden);
  assert.equal(await page.locator('#admin-login').isVisible(),true);
  assert.equal(await page.locator('#admin-accounts-fields').evaluate(element=>element.disabled),true);
  assert.deepEqual(f.errors,[]);
 }finally{await browser.close();}
});
