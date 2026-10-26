'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const app=fs.readFileSync(require.resolve('../public/script.js'),'utf8'),timing=fs.readFileSync(require.resolve('../public/login-timing.js'),'utf8');
function fn(name){const start=app.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert(start>=0,name);const tail=app.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return tail.slice(0,end+1);}
function fixture({readyAt=0,expiry=300000,restoreFailure=false,switched=false,appError=null,throwingLog=false}={}){
 let clock=0,applied=0,reloaded=0;const logs=[],calls=[],toasts=[],storage=new Map(),user={uid:'synthetic'},state='a'.repeat(64);
 class Clock extends Date{static now(){return clock;}}
 const location={origin:'http://localhost:5005',search:'?code=PRIVATE_CODE&state='+state,href:'http://localhost:5005/?code=PRIVATE_CODE&state='+state};
 storage.set('discord_membership_verification',JSON.stringify({uid:user.uid,state,expiresAt:expiry}));
 const root={performance:{now:()=>clock,getEntriesByType:()=>[]},crypto:{getRandomValues:a=>a.fill(1)},
 console:{info:s=>{if(throwingLog)throw Error('PRIVATE');logs.push(JSON.parse(s.slice(s.indexOf('] ')+2)));}},location,isAuthInitialized:readyAt===0,
 history:{replaceState:(_,__,url)=>{location.href=url;}}};
 const ctx=vm.createContext({window:root,URL,URLSearchParams,Uint8Array,Date:Clock,AbortSignal,Promise,Set,Map,Object,Number,JSON,Error,
 location,document:{title:'synthetic'},authStateRevision:1,registrationCheckPending:readyAt>0,
 UserStore:{user:readyAt>0?null:user,settings:{},inventorySyncStatus:readyAt>0?'loading':'ready'},IS_LOCAL_DEV:true,
 firebase:{auth:()=>({currentUser:switched?{uid:'other'}:user}),appCheck:()=>({getToken:async()=>{calls.push('appcheck');if(appError)throw appError;return{token:'PRIVATE_TOKEN'};}})},
 requireInventoryReady:()=>true,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 showToast:m=>toasts.push(m),applyMembershipStatus:()=>applied++,loadUserData:()=>reloaded++,
 syncMembershipHeader:()=>{},clearTimeout:()=>{},
 setTimeout(callback,delay){if(delay===5000)return 1;clock+=delay;if(clock>=readyAt){ctx.registrationCheckPending=false;ctx.UserStore.user=restoreFailure?null:user;ctx.UserStore.inventorySyncStatus=restoreFailure?'error':'ready';root.isAuthInitialized=true;}callback();},
 callApi:async(name)=>{calls.push(name);return{success:true,uid:user.uid,membership:{status:'active',type:'account'},sourceMembership:{status:'none',type:'discord'}};},
 });
 vm.runInContext(timing,ctx);
 for(const name of ['getApiAppCheckToken','awaitApiPreparation','getServiceRegistrationStatus'])vm.runInContext(fn(name),ctx);
 const begin=app.indexOf('let discordMembershipStarting = false;'),end=app.indexOf('/**\n * 멤버십 인증 메시지',begin);vm.runInContext(app.slice(begin,end),ctx);
 return{ctx,root,api:root.YgoLoginTiming,logs,calls,toasts,storage,applied:()=>applied,reloaded:()=>reloaded,clock:()=>clock};
}
test('App Check SDK 오류는 허용 코드·HTTP 숫자·분류만 복사하며 원문은 버린다',()=>{
 const f=fixture();
 for(const [code,category,retryable,status] of [['fetch-network-error','network',true,null],['recaptcha-error','recaptcha',true,null],['throttled','throttled',false,403],['initial-throttle','throttled',false,429],['fetch-status-error','http',false,403],['fetch-status-error','http',false,429],['fetch-status-error','http',true,503],['storage-get','storage',false,null],['use-before-activation','configuration',false,null]]){
  const value=f.api.appCheckFailure({code:'appCheck/'+code,customData:{httpStatus:status,token:'PRIVATE'},message:'PRIVATE_URL'});
  assert.equal(value.category,category);assert.equal(value.retryable,retryable);assert.equal(value.httpStatus,status);assert(!JSON.stringify(value).includes('PRIVATE'));
 }
 const unknown=f.api.appCheckFailure({code:'PRIVATE',customData:{httpStatus:'403',token:'PRIVATE'}});assert.equal(unknown.code,'unknown');assert.equal(unknown.httpStatus,null);
 assert.doesNotThrow(()=>f.api.appCheckFailure({get code(){throw Error('PRIVATE');}}));
});
test('발급 계측은 같은 SDK 결과·예외를 전달하고 중복 실행·비밀값 기록을 하지 않는다',async()=>{
 const f=fixture(),result={token:'PRIVATE'},error={code:'appCheck/recaptcha-error',message:'PRIVATE'};let count=0;
 assert.equal(await f.api.appCheck('request',false,async()=>{count++;return result;}),result);
 await assert.rejects(f.api.appCheck('bootstrap',false,()=>Promise.reject(error)),e=>e===error);
 assert.equal(count,1);assert.equal(f.logs[1].failure.category,'recaptcha');assert(!JSON.stringify(f.logs).includes('PRIVATE'));
 for(let i=0;i<60;i++)await f.api.appCheck('refresh',true,async()=>result);assert.equal(f.logs.length,48);
 const silent=fixture({throwingLog:true});assert.equal(await silent.api.appCheck('request',false,()=>result),result);
});
test('갱신 제한은 기존 앱 인증 오류 코드를 유지하고 자동 강제 갱신을 반복하지 않는다',async()=>{
 const f=fixture({appError:{code:'appCheck/throttled',customData:{httpStatus:403},message:'PRIVATE'}});
 f.ctx.callApi=async()=>{f.calls.push('registration');return f.ctx.getApiAppCheckToken();};
 await assert.rejects(f.ctx.getServiceRegistrationStatus({uid:'synthetic'},1),e=>e.code==='APPCHECK_UNAVAILABLE'&&e.retryable===false);
 assert.deepEqual(f.calls,['registration','appcheck']);assert(!JSON.stringify(f.logs).includes('PRIVATE'));
 assert.equal(f.logs.at(-1).outcome,'failed');
});
test('네트워크 발급 실패는 기존 로그인 재시도로 회복하며 같은 사용자만 적용한다',async()=>{
 const f=fixture();let attempts=0;f.ctx.callApi=async()=>{attempts++;if(attempts===1)throw Object.assign(Error(),{code:'APPCHECK_UNAVAILABLE'});return{success:true};};
 assert.equal((await f.ctx.getServiceRegistrationStatus({uid:'synthetic'},1)).success,true);assert.equal(attempts,2);
 assert.deepEqual(f.logs.find(x=>x.kind==='registration').spans.map(s=>s.name),['registration_attempt','app_check_refresh','retry_delay','registration_attempt']);
});
test('Discord 복귀는 30초를 넘는 가입·인벤토리 복원을 기다린 뒤 완료 요청을 한 번 보낸다',async()=>{
 const f=fixture({readyAt:70000});await f.ctx.handleDiscordOAuthCallback();
 assert.equal(f.clock(),70000);assert.deepEqual(f.calls,['verifyDiscordMembership']);assert.equal(f.applied(),1);assert.equal(f.reloaded(),0);
 assert.equal(f.storage.size,0);assert(!f.root.location.href.includes('PRIVATE_CODE'));assert.equal(f.toasts.length,0);
 const row=f.logs.find(x=>x.kind==='discord');assert.equal(row.outcome,'ready');assert.equal(row.spans[0].durationMs,70000);assert.equal(row.pageEndMs-row.pageStartMs,row.durationMs);assert(!JSON.stringify(f.logs).includes('PRIVATE'));
});
test('Discord는 기존 nonce 만료·다른 UID·복원 실패에서 쓰기 전에 중단하고 오류를 구분한다',async()=>{
 for(const opts of [{readyAt:70000,expiry:1000},{switched:true},{readyAt:100,restoreFailure:true}]){
  const f=fixture(opts);await f.ctx.handleDiscordOAuthCallback();assert.equal(f.calls.length,0);assert.equal(f.applied(),0);assert.equal(f.reloaded(),0);
  assert.equal(f.logs.at(-1).outcome,'failed');assert.equal(f.storage.size,0);
  if(opts.restoreFailure)assert(f.toasts[0].includes('로그인을 복원하지 못했습니다'));
 }
});
test('복귀 대기는 영구 대기하지 않으며 조작된 만료도 기존 5분 이내로 제한한다',async()=>{
 const f=fixture({readyAt:999999,expiry:999999});await f.ctx.handleDiscordOAuthCallback();assert.equal(f.clock(),300000);assert.equal(f.calls.length,0);
 assert.equal(f.logs.at(-1).failureCode,'DISCORD_VERIFICATION_EXPIRED');
});
test('Discord 완료 요청의 앱 인증 실패를 만료·계정 변경으로 잘못 안내하지 않는다',async()=>{
 const f=fixture();f.ctx.callApi=async()=>{throw Object.assign(Error('PRIVATE'),{code:'APPCHECK_UNAVAILABLE'});};await f.ctx.handleDiscordOAuthCallback();
 assert(f.toasts[0].includes('앱 인증'));assert(!f.toasts[0].includes('만료'));assert.equal(f.applied(),0);assert.equal(f.logs.at(-1).failureCode,'APPCHECK_UNAVAILABLE');
});
test('재발급에서 갱신 제한이 확인되면 다음 가입 요청도 보내지 않는다',async()=>{
 const f=fixture({appError:{code:'appCheck/initial-throttle',customData:{httpStatus:429}}});let attempts=0;
 f.ctx.callApi=async()=>{attempts++;throw Object.assign(Error(),{code:'APPCHECK_UNAVAILABLE'});};
 await assert.rejects(f.ctx.getServiceRegistrationStatus({uid:'synthetic'},1),e=>e.retryable===false);
 assert.equal(attempts,1);assert.deepEqual(f.calls,['appcheck']);
});
