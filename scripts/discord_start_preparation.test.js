'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/script.js','utf8');
const start=source.indexOf('let discordMembershipStarting = false;'),end=source.indexOf('// Firebase 초기화',start);
const modalStart=source.indexOf('function openMembershipAuthModal('),modalEnd=source.indexOf('/**',modalStart);
function gate(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function fixture(){
 let elapsed=0;const calls=[],gates=[],storage=new Map(),events=[];
 const user={uid:'synthetic-a'},location={origin:'https://ygo-synapse.web.app',href:'https://ygo-synapse.web.app/#settings'};
 const ctx={URL,Date,window:{location},performance:{now:()=>elapsed},location,authStateRevision:1,youtubeMembershipVerificationPending:false,UserStore:{user,settings:{},inventorySyncStatus:'ready'},
 firebase:{auth:()=>({currentUser:ctx.authUser})},authUser:user,
 prepareMembershipEntry:()=>ctx.prepareDiscordMembershipStart(),requireInventoryReady:()=>true,beginMembershipPreparation:p=>events.push('prepare:'+p),resetMembershipVerifyModal(){},
 document:{getElementById:id=>id==='membership-auth-modal'?{}:null},getAppModal:()=>({open:()=>events.push('open')}),
 sessionStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},showToast:()=>events.push('error'),
 callApi:(name,params,body)=>{const g=gate();g.uid=ctx.UserStore.user.uid;calls.push({name,params,body});gates.push(g);return g.promise;}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);ctx.setDiscordMembershipHeader=s=>events.push(s);
 vm.runInContext(source.slice(modalStart,modalEnd),ctx);
 const reply=(i=0,changes={})=>{const state=(i+1).toString(16).padStart(64,'0');gates[i].resolve({success:true,uid:gates[i].uid,verificationId:state,
 authorizationUrl:'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,redirect_uri:location.origin+'/'}),...changes});};
 return{ctx,calls,gates,events,storage,reply,advance:ms=>{elapsed+=ms;}};
}
test('선택창은 대기 없이 열리고 같은 계정의 재열기는 시작 요청 하나만 공유한다',async()=>{
 const f=fixture();f.ctx.openMembershipAuthModal();f.ctx.openMembershipAuthModal();assert.equal(f.events[0],'open');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'startDiscordMembershipVerification');assert.equal(f.storage.size,0);
 f.reply();await flush();assert.equal(f.storage.size,0);assert(!f.events.includes('pending'));
});
test('준비 완료 뒤 클릭은 추가 API/await 없이 즉시 이동하고 중복 클릭을 차단한다',async()=>{
 const f=fixture();f.ctx.openMembershipAuthModal();f.reply();await flush();
 const run=f.ctx.startDiscordMembershipVerify();assert.match(f.ctx.location.href,/^https:\/\/discord.com\/oauth2\/authorize/);
 await Promise.all([run,f.ctx.startDiscordMembershipVerify()]);assert.equal(f.calls.length,1);assert.equal(f.storage.size,2);assert.equal(JSON.parse(f.storage.get('discord_start_timing')).prepared,true);
});
test('준비 중 클릭도 시작 요청을 공유하고 완료 전에는 이동하지 않는다',async()=>{
 const f=fixture();f.ctx.openMembershipAuthModal();const a=f.ctx.startDiscordMembershipVerify(),b=f.ctx.startDiscordMembershipVerify();
 assert.equal(f.calls.length,1);assert(!f.ctx.location.href.includes('discord.com'));f.reply();await Promise.all([a,b]);assert(f.ctx.location.href.includes('discord.com'));
});
test('만료된 준비는 명시적 클릭에서 새로 만들며 서버보다 짧은 남은 기한만 저장한다',async()=>{
 const f=fixture();f.ctx.openMembershipAuthModal();f.reply();await flush();f.advance(270000);
 const run=f.ctx.startDiscordMembershipVerify();assert.equal(f.calls.length,2);f.reply(1);f.advance(10000);await run;
 const saved=JSON.parse(f.storage.get('discord_membership_verification'));assert(saved.expiresAt<=Date.now()+260000);assert.equal(saved.state,'2'.padStart(64,'0'));
});
test('준비 실패 후 사용자 클릭은 재시도하지만 클릭 중 실패는 자동으로 재전송하지 않는다',async()=>{
 const f=fixture();f.ctx.openMembershipAuthModal();f.gates[0].reject(Error('synthetic'));await flush();
 const run=f.ctx.startDiscordMembershipVerify();assert.equal(f.calls.length,2);f.gates[1].reject(Error('synthetic'));await run;
 assert.equal(f.calls.length,2);assert.equal(f.storage.size,0);assert(!f.ctx.location.href.includes('discord.com'));assert(f.events.includes('error'));
});
test('계정 변경/로그아웃/인증 revision 변경은 이전 준비와 늦은 응답을 적용하지 않는다',async()=>{
 for(const change of ['account','logout','revision']){
  const f=fixture();f.ctx.openMembershipAuthModal();
  if(change==='account')f.ctx.UserStore.user=f.ctx.authUser={uid:'synthetic-b'};
  if(change==='logout')f.ctx.UserStore.user=f.ctx.authUser=null;
  f.ctx.authStateRevision++;f.reply();await flush();
  if(change!=='logout'){const run=f.ctx.startDiscordMembershipVerify();assert.equal(f.calls.length,2);f.reply(1);await run;
   assert.equal(JSON.parse(f.storage.get('discord_membership_verification')).uid,f.ctx.UserStore.user.uid);}
  else assert.equal(f.ctx.prepareDiscordMembershipStart(),null);
 }
});
test('state·UID·도메인·복귀 주소 변조와 중복 query는 저장/이동 전에 거부한다',async()=>{
 for(const changes of [{uid:'other'},{verificationId:'bad'},{authorizationUrl:'https://evil.invalid/'},
 {authorizationUrl:'https://discord.com/oauth2/authorize?state='+('1'.padStart(64,'0'))+'&state=bad&redirect_uri=https://ygo-synapse.web.app/'},
 {authorizationUrl:'https://discord.com/oauth2/authorize?state='+('1'.padStart(64,'0'))+'&redirect_uri=https://evil.invalid/'}]){
  const f=fixture();const run=f.ctx.startDiscordMembershipVerify();f.reply(0,changes);await run;
  assert.equal(f.storage.size,0);assert(!f.ctx.location.href.includes('discord.com'));assert.equal(f.calls.length,1);
 }
});
test('대기 중 계정 변경과 브라우저 저장 실패는 이동/성공 안내를 하지 않는다',async()=>{
 for(const changed of [true,false]){
  const f=fixture(),run=f.ctx.startDiscordMembershipVerify();
  if(changed){f.ctx.authStateRevision++;f.ctx.UserStore.user=f.ctx.authUser={uid:'other'};}
  else f.ctx.sessionStorage.setItem=()=>{throw Error('storage-disabled');};
  f.reply();await run;assert.equal(f.storage.size,0);assert(!f.ctx.location.href.includes('discord.com'));assert(!f.events.includes('complete'));
 }
});
