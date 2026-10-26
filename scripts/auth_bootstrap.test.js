'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../public/auth-bootstrap.js'),'utf8');
function fixture({local=false,redirectFailure=false}={}){
 const marks=[],events=[],options={authDomain:'original'},auth={onAuthStateChanged:fn=>{events.push('observe');fn({uid:'never-log'});},getRedirectResult:()=>{events.push('redirect');return redirectFailure?Promise.reject({code:'auth/network-request-failed',private:'never-log'}):Promise.resolve({credential:'never-log'});}};
 const root={YgoLoginTiming:{mark:n=>marks.push(n)}};
 const check={activate(_provider,refresh){events.push(['activate',refresh]);},getToken:async()=>{events.push('appcheck');return{token:'never-log'};}};
 const firebase={app:()=>({options}),auth:()=>{events.push('auth');return auth;},appCheck:Object.assign(()=>check,{ReCaptchaEnterpriseProvider:class{}})};
 vm.runInNewContext(source,{window:root,location:{hostname:local?'localhost':'example.web.app'},firebase,Promise,Error,Object});
 return{root,marks,events,options,auth};
}
test('기본 Auth·동일 도메인·App Check를 UI 없이 먼저 준비하고 redirect 결과를 한 번만 소비한다',async()=>{
 const f=fixture(),api=f.root.YgoAuthBootstrap;assert(api);assert.equal(api.auth,f.auth);assert.equal(f.options.authDomain,'example.web.app');assert.equal(f.events.filter(x=>x==='redirect').length,1);
 assert(f.events.indexOf('appcheck')<f.events.indexOf('auth'));assert.equal(await api.redirect,undefined);
 let done=false;const wait=api.whenUiReady().then(()=>{done=true;});await Promise.resolve();assert(!done);
 api.uiPrepared();await wait;assert(done);assert(f.marks.includes('auth_user_ready'));assert(!JSON.stringify(f.marks).includes('never-log'));
});
test('로컬 도메인은 보존하고 기존 debug 방식만 사용한다',async()=>{const f=fixture({local:true});assert.equal(f.options.authDomain,'original');assert.equal(f.root.FIREBASE_APPCHECK_DEBUG_TOKEN,true);f.root.YgoAuthBootstrap.uiPrepared();await f.root.YgoAuthBootstrap.redirect;});
test('redirect 실패는 원래 오류를 유지하고 UI 준비 실패는 장벽을 거부한다',async()=>{const f=fixture({redirectFailure:true});await assert.rejects(f.root.YgoAuthBootstrap.redirect,e=>e.code==='auth/network-request-failed');f.root.YgoAuthBootstrap.uiFailed();await assert.rejects(f.root.YgoAuthBootstrap.whenUiReady());assert(f.marks.includes('redirect_result_failed'));});
test('SDK 조기 준비 실패에도 UI 장벽은 남겨 두고 준비 신호 없이 적용하지 않는다',async()=>{
 const marks=[],root={YgoLoginTiming:{mark:x=>marks.push(x)}};
 vm.runInNewContext(source,{window:root,location:{hostname:'example.web.app'},firebase:{app(){throw Error('never-log');}},Promise,Error,Object});
 assert(root.YgoAuthBootstrap);assert.equal(root.YgoAuthBootstrap.auth,null);assert.equal(root.YgoAuthBootstrap.appCheckStarted,false);
 let done=false;const pending=root.YgoAuthBootstrap.whenUiReady().then(()=>{done=true;});await Promise.resolve();assert(!done);root.YgoAuthBootstrap.uiPrepared();await pending;assert(done);assert(marks.includes('auth_bootstrap_failed'));assert(!JSON.stringify(marks).includes('never-log'));
});
