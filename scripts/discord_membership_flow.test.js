const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/script.js'),'utf8');
const begin=source.indexOf('let discordMembershipStarting = false;'),end=source.indexOf('/**\n * 멤버십 인증 메시지',begin);
const state='a'.repeat(64);
function fixture({query='',pending=true,otherUser=false,switchAt=null,waiting=false}={}) {
 const storage=new Map(),calls=[],toasts=[],cleaned=[];let applied=0;
 if(pending)storage.set('discord_membership_verification',JSON.stringify({uid:'user-a',state,expiresAt:Date.now()+300000}));
 const user={uid:otherUser?'user-b':'user-a'},location={origin:'http://localhost:5005',search:query,href:'http://localhost:5005/'+query+'#settings'};
 const ctx={URL,URLSearchParams,Date,location,authStateRevision:1,registrationCheckPending:waiting,
 UserStore:{user:waiting?null:user,settings:{}},firebase:{auth:()=>({currentUser:user})},
 window:{location,isAuthInitialized:!waiting,history:{replaceState:(_,__,url)=>cleaned.push(url)}},document:{title:'테스트'},
 sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 setTimeout:fn=>{ctx.registrationCheckPending=false;ctx.UserStore.user=user;ctx.window.isAuthInitialized=true;fn();},
 callApi:async(name,_,body)=>{calls.push({name,body});if(switchAt===name){ctx.authStateRevision++;ctx.UserStore.user={uid:'user-b'};}
 const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({redirect_uri:'http://localhost:5005/',state}).toString();
 return name==='startDiscordMembershipVerification'?{success:true,uid:'user-a',verificationId:state,authorizationUrl:url.href}
 :{success:true,uid:'user-a',isMemberActive:true,membership:{status:'active',type:'discord'}};},
 showToast:msg=>toasts.push(msg),applyMembershipStatus:()=>applied++,updateAuthUI(){},loadUserData(){}
 };
 vm.createContext(ctx);vm.runInContext(source.slice(begin,end),ctx);
 return{ctx,calls,storage,toasts,cleaned,applied:()=>applied};
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
