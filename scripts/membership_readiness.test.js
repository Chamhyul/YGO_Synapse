'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync('public/script.js', 'utf8');
const start = source.indexOf('let youtubeMembershipVerificationPending = false;');
const yt = source.slice(start, source.indexOf('/**', start));
function gate() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function flush() { for (let i=0;i<25;i++) await Promise.resolve(); }
function harness({ failure = false, oldServer = false } = {}) {
  const popup=gate(), verify=gate(), data=gate(), sync=gate(), calls=[], events=[], user={uid:'synthetic-a'};
  const ctx={UserStore:{user,settings:{},inventorySyncStatus:'error'},authStateRevision:1,requireInventoryReady:()=>true,followMembershipClaims:()=>{},setInventorySyncStatus:status=>{ctx.UserStore.inventorySyncStatus=status;},
    firebase:{auth:()=>({currentUser:ctx.UserStore.user})},
    getYoutubeAccessTokenViaSecondaryApp:()=>{events.push('popup');return popup.promise;},
    setDiscordMembershipHeader:state=>events.push(state),showToast:()=>events.push('toast'),applyMembershipStatus(){},
    M:{Modal:{getInstance:()=>({close(){}})}},document:{getElementById:()=>null},resetMembershipVerifyModal(){},
    loadUserData:async()=>{events.push('sync');await sync.promise;return true;},
    callApi:async(name,params,body)=>{calls.push({name,body,params});
      if(body?.membershipPrepare){
        if(failure)throw Error('synthetic-preparation');
        if(oldServer)return{success:true,message:'warmed up'};
        await (name==='getUserData'?data:verify).promise;
        return{success:true,membershipPreparation:{version:1,target:name,ready:true}};
      }
      if(name.startsWith('start'))return{success:true,uid:user.uid,verificationId:'synthetic'};
      return{success:true,uid:user.uid,membership:{status:'active'},sourceMembership:{status:'active'}};
    }};
  vm.createContext(ctx);vm.runInContext(yt,ctx);
  return{ctx,calls,events,popup,verify,data,sync,run:()=>ctx.startYoutubeMembershipVerify()};
}
test('팝업·실제 인증은 선택적 준비를 기다리지 않고 결과를 먼저 표시하며 필요한 전체 동기화는 유지한다',async()=>{
  const f=harness(), run=f.run();await flush();
  assert.equal(f.events[1],'popup');assert.equal(f.calls.filter(x=>x.body?.membershipPrepare).length,3);
  assert.equal(f.calls.filter(x=>!x.body?.membershipPrepare&&x.name==='verifyYoutubeMembership').length,0);
  for(const c of f.calls.filter(x=>x.body?.membershipPrepare))assert.deepEqual(Object.keys(c.body).sort(),['membershipPrepare','warmup']);
  f.popup.resolve('synthetic-oauth');await flush();assert(!f.events.includes('sync'));
  assert.equal(f.calls.filter(x=>!x.body?.membershipPrepare&&x.name==='verifyYoutubeMembership').length,1);
  assert(f.events.includes('complete'));assert(!f.events.includes('sync'));
  f.verify.resolve();f.data.resolve();await flush();assert(f.events.includes('sync'));
  assert(f.events.indexOf('complete')<f.events.indexOf('sync'));
  f.sync.resolve();await run;
});
for(const mode of ['failure','oldServer'])test(`준비 ${mode}는 실제 인증과 최종 동기화를 막지 않는다`,async()=>{
  const f=harness({[mode]:true});f.popup.resolve('synthetic');f.sync.resolve();await f.run();
  assert.equal(f.calls.filter(x=>!x.body?.membershipPrepare&&x.name==='verifyYoutubeMembership').length,1);
  assert(f.events.includes('sync'));assert(f.events.indexOf('complete')<f.events.indexOf('sync'));
});
test('준비 중 계정이 바뀌면 이전 계정의 검증·동기화를 제출하지 않는다',async()=>{
  const f=harness(), run=f.run();await flush();
  f.ctx.authStateRevision++;f.ctx.UserStore.user={uid:'synthetic-b'};f.popup.resolve('synthetic');f.verify.resolve();f.data.resolve();await run;
  assert.equal(f.calls.filter(x=>!x.body?.membershipPrepare&&x.name==='verifyYoutubeMembership').length,0);
  assert(!f.events.includes('sync'));assert(!f.events.includes('complete'));
});
test('Discord는 읽기 준비 완료를 기다리지 않고 기존 OAuth 주소로 이동한다',async()=>{
  const f=harness(), state='a'.repeat(64), saved=new Map();
  f.ctx.location={origin:'https://ygo-synapse.web.app/'};
  f.ctx.location.origin='https://ygo-synapse.web.app';f.ctx.window={location:f.ctx.location};
  f.ctx.sessionStorage={setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  f.ctx.callApi=async(name,_params,body)=>{
    f.calls.push({name,body});if(body?.membershipPrepare)return f.data.promise;
    return{success:true,uid:'synthetic-a',verificationId:state,authorizationUrl:'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,redirect_uri:'https://ygo-synapse.web.app/'}).toString()};
  };
  f.ctx.URL=URL;f.ctx.URLSearchParams=URLSearchParams;
  const a=source.indexOf('let discordMembershipStarting = false;'),b=source.indexOf('// Firebase 초기화',a);
  vm.runInContext(source.slice(a,b),f.ctx);
  await f.ctx.startDiscordMembershipVerify();await flush();
  assert.equal(f.calls.filter(x=>x.body?.membershipPrepare).length,2);
  assert.match(f.ctx.location.href,/discord\.com\/oauth2\/authorize/);assert(saved.has('discord_membership_verification'));
  f.data.resolve();
});

function transport({ token, appCheck } = {}) {
  const user={uid:'synthetic',getIdToken:()=>token||Promise.resolve('synthetic-id')}, sent=[], controllers=[], timeouts=[];
  const ctx={URL,UserStore:{user},firebase:{auth:()=>({currentUser:ctx.UserStore.user})},
    FIREBASE_CONFIG:{ENDPOINTS:{getUserData:'https://synthetic.invalid/getUserData'}},STORAGE_KEY:'synthetic',localStorage:{getItem:()=>null},
    window:{},getApiAppCheckToken:()=>appCheck||Promise.resolve('synthetic-app'),console:{error(){}},
    AbortSignal:{timeout(ms){timeouts.push(ms);const c=new AbortController();controllers.push(c);return c.signal;}},
    fetch:async(url,options)=>{sent.push({url,options});return{ok:true,json:async()=>({success:true})};}};
  const a=source.indexOf('function awaitApiPreparation('),b=source.indexOf('// 검색 시 최신 공통 목록',a);
  vm.createContext(ctx);vm.runInContext(source.slice(a,b),ctx);
  return{ctx,sent,timeouts,controllers,run:()=>ctx.requestApi('getUserData',{warmup:'true'},{warmup:'true',membershipPrepare:true})};
}
test('준비 HTTP는 기존 인증·App Check와 keepalive·5초 제한을 사용한다',async()=>{
  const f=transport();await f.run();assert.deepEqual(f.timeouts,[5000]);assert.equal(f.sent.length,1);
  const o=f.sent[0].options;assert.equal(o.keepalive,true);assert.equal(o.method,'POST');
  assert.equal(o.headers.Authorization,'Bearer synthetic-id');assert.equal(o.headers['X-Firebase-AppCheck'],'synthetic-app');
  assert.equal(JSON.parse(o.body).membershipPrepare,true);
});
test('토큰 준비가 멈춰도5초 signal 취소로 끝나고 계정 변경 후에는 fetch하지 않는다',async()=>{
  const g=gate(),f=transport({token:g.promise}),pending=f.run();await flush();f.controllers[0].abort();
  await assert.rejects(pending,{code:'SERVICE_CHECK_TIMEOUT'});assert.equal(f.sent.length,0);g.resolve('synthetic');
  const app=gate(),other=transport({appCheck:app.promise}),work=other.run();await flush();
  other.ctx.UserStore.user={uid:'other'};app.resolve('synthetic');await assert.rejects(work,{code:'REQUEST_SUPERSEDED'});assert.equal(other.sent.length,0);
});

test('준비된 인벤토리는 getUserData 준비 완료를 기다리거나 재조회하지 않는다',async()=>{
 const f=harness();f.ctx.UserStore.inventorySyncStatus='ready';const run=f.run();
 f.popup.resolve('synthetic');f.verify.resolve();await run;
 assert(!f.events.includes('sync'));assert.equal(f.events.at(-1),'complete');f.data.resolve();
});

function entryHarness(options) {
 const f=harness(options);f.ctx.UserStore.inventorySyncStatus='ready';f.ctx.location={origin:'https://synthetic.invalid'};
 f.ctx.URL=URL;f.ctx.URLSearchParams=URLSearchParams;
 const original=f.ctx.callApi;f.ctx.callApi=async(name,params,body)=>{
  if(name==='startDiscordMembershipVerification'&&!body?.membershipPrepare){
   f.calls.push({name,params,body});const state='a'.repeat(64);
   return{success:true,uid:f.ctx.UserStore.user.uid,verificationId:state,authorizationUrl:'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,redirect_uri:f.ctx.location.origin+'/'})};
  }
  return original(name,params,body);
 };
 const a=source.indexOf('let discordMembershipStarting = false;'),b=source.indexOf('// Firebase 초기화',a);
 vm.runInContext(source.slice(a,b),f.ctx);return f;
}
test('설정 진입의 두 제공자 준비는4개 함수와 시작 상태1개를 병렬로 시작하고 재진입·모달·클릭 준비를 공유한다',async()=>{
 const f=entryHarness();f.ctx.prepareMembershipEntry();f.ctx.prepareMembershipEntry();await flush();
 const preps=f.calls.filter(c=>c.body?.membershipPrepare&&!c.body.workerPrepare);assert.equal(preps.length,4);
 assert.equal(f.calls.filter(c=>c.body?.workerPrepare).length,1);
 assert.deepEqual(preps.map(c=>c.name).sort(),['getUserData','startYoutubeMembershipVerification','verifyDiscordMembership','verifyYoutubeMembership']);
 assert.equal(f.calls.filter(c=>!c.body?.membershipPrepare).length,1);assert(!f.events.includes('popup'));assert(!f.events.includes('pending'));
 f.verify.resolve();f.data.resolve();await flush();f.ctx.beginMembershipPreparation('youtube');f.ctx.beginMembershipPreparation('discord');await flush();assert.equal(f.calls.length,6);
});
test('준비 상태의 짧은 공유 기한과 계정·revision 변경은 fresh 준비를 요구한다',async()=>{
 const f=entryHarness();let elapsed=0;f.ctx.performance={now:()=>elapsed};f.verify.resolve();f.data.resolve();
 f.ctx.prepareMembershipEntry();await flush();f.ctx.prepareMembershipEntry();await flush();assert.equal(f.calls.length,6);
 elapsed=60000;f.ctx.prepareMembershipEntry();await flush();assert.equal(f.calls.filter(c=>c.body?.membershipPrepare&&!c.body.workerPrepare).length,8);
 assert.equal(f.calls.filter(c=>!c.body?.membershipPrepare).length,1);
 f.ctx.authStateRevision++;f.ctx.UserStore.user={uid:'synthetic-b'};f.ctx.prepareMembershipEntry();await flush();
 assert.equal(f.calls.filter(c=>c.body?.membershipPrepare&&!c.body.workerPrepare).length,12);assert.equal(f.calls.filter(c=>!c.body?.membershipPrepare).length,2);
});
test('미준비 인벤토리·로그아웃·진행 중 인증에서는 계정 진입 준비를 새로 시작하지 않는다',async()=>{
 for(const status of ['idle','error','loading']){const f=entryHarness();f.ctx.UserStore.inventorySyncStatus=status;f.ctx.prepareMembershipEntry();await flush();assert.equal(f.calls.length,0);}
 const f=entryHarness();f.ctx.UserStore.user=null;f.ctx.prepareMembershipEntry();await flush();assert.equal(f.calls.length,0);
 const pending=entryHarness();vm.runInContext('discordMembershipStarting=true',pending.ctx);pending.ctx.prepareMembershipEntry();await flush();assert.equal(pending.calls.length,0);
});
test('실패·구형 서버 준비는 캐시된 권한이나 성공으로 간주하지 않고 다음 명시 요청에서 재시도한다',async()=>{
 for(const options of [{failure:true},{oldServer:true}]){const f=entryHarness(options);f.ctx.prepareMembershipEntry();await flush();assert.equal(await f.ctx.beginMembershipPreparation('youtube').wait('verifyYoutubeMembership'),false);await flush();assert(f.calls.filter(c=>c.body?.membershipPrepare).length>4);assert(!f.events.includes('complete'));}
});

test('내 계정·설정 라우팅은 화면 대기 없이 준비를 호출하고 인증 초기화 전에는 시작하지 않는다',async()=>{
 const user={uid:'synthetic'},ready=gate();let started=0;
 const ctx={UIStore:{mode:'settings'},window:{isAuthInitialized:true,location:{hash:'#settings'}},document:{getElementById:()=>null},currentToastInstance:null,
 prepareMembershipEntry:()=>{started++;},waitForAuthInit:()=>ready.promise};
 vm.createContext(ctx);const a=source.indexOf('function switchToMode('),b=source.indexOf('function checkClearBtn(',a);
 vm.runInContext(source.slice(a,b),ctx);ctx.switchToMode('settings');assert.equal(started,1);
 ctx.window.isAuthInitialized=false;ctx.switchToMode('settings');assert.equal(started,1);
 ctx.window.isAuthInitialized=true;ready.resolve();await flush();assert.equal(started,2);
});


test('worker 준비는 기존 제공자 준비와 별개로 실행하고 실패·중복 진입·계정 변경을 처리한다',async()=>{
 const f=entryHarness();let elapsed=0;f.ctx.performance={now:()=>elapsed};
 f.ctx.setDiscordMembershipHeader=state=>f.events.push(state);
 const sent=[],slow=gate(),original=f.ctx.callApi;
 f.ctx.callApi=(name,params,body)=>{if(body?.workerPrepare){sent.push(body);return slow.promise;}return original(name,params,body);};
 f.ctx.prepareMembershipEntry();f.ctx.prepareMembershipEntry();await flush();assert.equal(sent.length,1);
 f.popup.resolve('synthetic');f.verify.resolve();await f.run();
 assert.equal(f.events.at(-1),'complete');assert(!f.events.includes('sync'));
 slow.reject(Error('unavailable'));await flush();f.ctx.prepareMembershipEntry();await flush();assert.equal(sent.length,1);
 elapsed=60000;f.ctx.prepareMembershipEntry();await flush();assert.equal(sent.length,2);
 f.ctx.authStateRevision++;f.ctx.prepareMembershipEntry();await flush();assert.equal(sent.length,3);
 const other=entryHarness();const requests=other.calls;other.ctx.beginMembershipWorkerPreparation();
 other.ctx.UserStore.user=null;other.ctx.authStateRevision++;await flush();assert.equal(requests.length,0);
});
