const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/script.js'),'utf8');
const begin=source.indexOf('let discordMembershipStarting = false;'),end=source.indexOf('/**\n * 멤버십 인증 메시지',begin);
const state='a'.repeat(64);
function fixture({query='',pending=true,otherUser=false,switchAt=null,waiting=false,verified=null}={}) {
 const storage=new Map(),calls=[],toasts=[],cleaned=[];let applied=0,reloaded=0;
 if(pending)storage.set('discord_membership_verification',JSON.stringify({uid:'user-a',state,expiresAt:Date.now()+300000}));
 const user={uid:otherUser?'user-b':'user-a'},location={origin:'http://localhost:5005',search:query,href:'http://localhost:5005/'+query+'#settings'};
 const ctx={requireInventoryReady:()=>true,URL,URLSearchParams,Date,location,authStateRevision:1,registrationCheckPending:waiting,
 UserStore:{user:waiting?null:user,settings:{},inventorySyncStatus:'ready'},firebase:{auth:()=>({currentUser:user})},
 window:{location,isAuthInitialized:!waiting,history:{replaceState:(_,__,url)=>cleaned.push(url)}},document:{title:'테스트'},
 sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 syncMembershipHeader:()=>{},clearTimeout:()=>{},
 setTimeout:(fn,delay)=>{if(delay===5000)return 1;ctx.registrationCheckPending=false;ctx.UserStore.user=user;ctx.window.isAuthInitialized=true;fn();},
 callApi:async(name,_,body)=>{if(body?.membershipPrepare)return {success:true,membershipPreparation:{version:1,target:name,ready:true}};calls.push({name,body});if(switchAt===name){ctx.authStateRevision++;ctx.UserStore.user={uid:'user-b'};}
 const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({redirect_uri:'http://localhost:5005/',state}).toString();
 return name==='startDiscordMembershipVerification'?{success:true,uid:'user-a',verificationId:state,authorizationUrl:url.href}
 :verified||{success:true,uid:'user-a',isMemberActive:true,membership:{status:'active',type:'discord'}};},
 followMembershipClaims:()=>{},setInventorySyncStatus:status=>{ctx.UserStore.inventorySyncStatus=status;},refreshMembershipClaims:async()=>true,
 showToast:msg=>toasts.push(msg),applyMembershipStatus:()=>applied++,loadUserData(){reloaded++;}
 };
 vm.createContext(ctx);
 const prep=source.indexOf('function beginMembershipPreparation('),prepEnd=source.indexOf('async function startYoutubeMembershipVerify(',prep);
 vm.runInContext(source.slice(prep,prepEnd),ctx);vm.runInContext(source.slice(begin,end),ctx);
 return{ctx,calls,storage,toasts,cleaned,applied:()=>applied,reloaded:()=>reloaded};
}
test('Discord 시작은 서버 URL·state를 사용하며 중복 클릭은 요청 하나만 보낸다',async()=>{
 const f=fixture();await Promise.all([f.ctx.startDiscordMembershipVerify(),f.ctx.startDiscordMembershipVerify()]);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].body.redirectUri,'http://localhost:5005/');assert.equal(new URL(f.ctx.location.href).searchParams.get('state'),state);
 assert.equal(JSON.parse(f.storage.get('discord_membership_verification')).uid,'user-a');
});
test('state 불일치·다른 서비스 계정은 API 호출 전에 거부하고 URL에서 코드를 지운다',async()=>{
 for(const options of [{query:'?code=PRIVATE&state=bad'},{query:'?code=PRIVATE&state='+state,otherUser:true}]){
 const f=fixture(options);await f.ctx.handleDiscordOAuthCallback();assert.equal(f.calls.length,0);assert.equal(f.applied(),0);assert.ok(!f.cleaned[0].includes('PRIVATE'));
 assert.ok(f.toasts.every(v=>!v.includes('PRIVATE')));}
});
test('가입 확인 완료를 기다린 뒤 완료 요청하며 사용자 토큰·시크릿을 브라우저 저장소에 남기지 않는다',async()=>{
 const f=fixture({query:'?code=PRIVATE&state='+state+'&foo=1',waiting:true});await f.ctx.handleDiscordOAuthCallback();
 assert.equal(f.calls[0].name,'verifyDiscordMembership');assert.deepEqual(Object.keys(f.calls[0].body).sort(),['code','verificationId']);
 assert.equal(f.applied(),1);assert.equal(f.storage.size,0);assert.ok(f.cleaned[0].includes('foo=1'));assert.ok(f.cleaned[0].endsWith('#settings'));
});
test('완료 응답 중 서비스 계정이 바뀌면 멤버십 화면을 갱신하지 않는다',async()=>{
 const f=fixture({query:'?code=c&state='+state,switchAt:'verifyDiscordMembership'});await f.ctx.handleDiscordOAuthCallback();assert.equal(f.applied(),0);
});
test('동의 취소는 인증 요청 없이 정리하며 유효한 pending 없는 코드를 사용하지 않는다',async()=>{
 const f=fixture({query:'?error=access_denied&state='+state});await f.ctx.handleDiscordOAuthCallback();assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
 const unsolicited=fixture({query:'?code=c&state='+state,pending:false});await unsolicited.ctx.handleDiscordOAuthCallback();assert.equal(unsolicited.calls.length,0);
});

test('관리자 혜택이 있어도 Discord 외부 비회원 판정은 보존한다',async()=>{const f=fixture({query:'?code=synthetic&state='+state,verified:{success:true,uid:'user-a',isMemberActive:true,membership:{status:'active',type:'account'},sourceMembership:{status:'none',type:'discord'}}});await f.ctx.handleDiscordOAuthCallback();assert.equal(f.applied(),1);assert.equal(f.ctx.UserStore.sourceMembership.status,'none');assert.equal(f.toasts.length,0);});

test('Discord 완료는 외부 회원 여부와 관계없이 준비된 인벤토리를 재사용한다',async()=>{
 for(const status of ['none','active']){
  const membership={status:'active',type:'account'},sourceMembership={status,type:'discord'};
  const f=fixture({query:'?code=synthetic&state='+state,verified:{success:true,uid:'user-a',membership,sourceMembership,isMemberActive:true}});
  await f.ctx.handleDiscordOAuthCallback();
  assert.equal(f.reloaded(),0);assert.equal(f.ctx.UserStore.settings.membership,membership);assert.equal(f.ctx.UserStore.sourceMembership,sourceMembership);
  assert.equal(f.toasts.length,0);
 }
});
test('Discord 계정 변경·동의 취소는 완료 후 재조회를 실행하지 않는다',async()=>{
 for(const options of [{query:'?code=c&state='+state,switchAt:'verifyDiscordMembership'},{query:'?error=access_denied&state='+state}]){
  const f=fixture(options);await f.ctx.handleDiscordOAuthCallback();assert.equal(f.reloaded(),0);
 }
});

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
test('완료 도중 필요한 동기화는 끝까지 기다린 뒤 토스트와 ready 계측을 남긴다',async()=>{
 const f=fixture({query:'?code=c&state='+state}),gate=deferred(),events=[];
 f.ctx.callApi=async()=>{f.ctx.UserStore.inventorySyncStatus='loading';return{success:true,uid:'user-a',membership:{status:'active'}};};
 f.ctx.window.YgoLoginTiming={recovery:()=>({measure:(name,work)=>{events.push(name);return work();},finish:outcome=>events.push(outcome)})};
 f.ctx.loadUserData=async()=>{await gate.promise;f.ctx.UserStore.inventorySyncStatus='ready';return true;};
 const work=f.ctx.handleDiscordOAuthCallback();for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(f.ctx.UserStore.inventorySyncStatus,'loading');assert.equal(f.toasts.length,0);assert(!events.includes('ready'));
 gate.resolve();await work;assert.equal(f.applied(),1);assert.equal(events.at(-1),'ready');assert(events.includes('final_sync'));
});
test('인증 결과는 전체 동기화보다 먼저 표시하고 동기화 실패·계정 변경을 준비 완료로 바꾸지 않는다',async()=>{
 for(const changed of [false,true]){
  const f=fixture({query:'?code=c&state='+state});
  f.ctx.callApi=async()=>{f.ctx.UserStore.inventorySyncStatus='error';return{success:true,uid:'user-a',membership:{status:'active'}};};
  f.ctx.loadUserData=async()=>{if(changed){f.ctx.authStateRevision++;f.ctx.UserStore.user={uid:'user-b'};return true;}return false;};
  await f.ctx.handleDiscordOAuthCallback();assert.equal(f.applied(),1);assert(!f.toasts.some(t=>t.includes('성공')));
  assert.equal(f.ctx.UserStore.inventorySyncStatus,'error');
  if(changed)assert.equal(f.ctx.UserStore.user.uid,'user-b');else assert(f.toasts.some(t=>t.includes('복원하지 못')));
 }
});
test('claims 미완료는 목록 재조회 없이 재시도 가능한 pending을 보존한다',async()=>{
 for(const ready of [false,true]){
  const f=fixture({query:'?code=c&state='+state,verified:{success:true,uid:'user-a',membership:{status:'active'},membershipClaims:{status:ready?'synced':'pending'}}});
  f.ctx.refreshMembershipClaims=async()=>ready;
  await f.ctx.handleDiscordOAuthCallback();assert.equal(f.reloaded(),0);assert.equal(f.ctx.UserStore.inventorySyncStatus,'ready');
  assert.equal(f.ctx.UserStore.claimsSyncStatus,ready?'ready':'pending');assert.equal(f.applied(),1);
 }
});
