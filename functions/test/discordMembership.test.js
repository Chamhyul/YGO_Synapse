const test=require('node:test'),assert=require('node:assert/strict');
const {createDiscordMembershipHandlers,sanitizeDiscordMembership,DISCORD_REDIRECTS}=require('../services/discordMembership');
const {getDiscordMembershipWithCode}=require('../integrations/discordMembership');
const {forwardDiscordMembership}=require('../services/discordMembershipTransport');
const memberId='123456789012345678',role='1462257396020809800';
function fixture({local=false,app=true,roles=[role],failure=false,accountRole=null}={}) {
 const records=new Map();let time=10000,calls=0,secrets=0,lock=Promise.resolve(),hook;
 const snap=ref=>({data:()=>records.get(ref.path)});
 const db={collection:name=>({doc:id=>({path:name+'/'+id,set:async function(v){records.set(this.path,v);}})}),
 runTransaction:fn=>{const run=lock.then(()=>fn({get:async ref=>snap(ref),set:(ref,v)=>records.set(ref.path,v),update:(ref,v)=>records.set(ref.path,{...records.get(ref.path),...v})}));lock=run.catch(()=>{});return run;}};
 const handlers=createDiscordMembershipHandlers({db,auth:{getUser:async()=>({customClaims:{role:accountRole}})},now:()=>time,isLocal:()=>local,
 setCors(){},verifyAppCheck:async(_,res)=>{if(!app)res.status(401).json({success:false});return app;},verifyRegisteredUser:async req=>req.uid||'user-a',
 clientId:'app-id',guildId:'guild-id',getClientSecret:()=>{secrets++;return 'private-secret';},
 getMembership:async input=>{calls++;assert.ok(DISCORD_REDIRECTS.has(input.redirectUri));if(hook)await hook();if(failure)throw Error('PRIVATE');return{discordId:memberId,roles};},
 forward:async(op,body)=>{assert.equal(body.localOnly,true);return{success:true,uid:'user-a',verificationId:'a'.repeat(64),membership:{type:'account',status:'active',levelName:'관리자'},sourceMembership:{type:'discord',discordId:memberId,verificationProvider:'discord',verificationVersion:2,status:'active'}};}});
 async function call(name,body={},extra={}){const res={statusCode:200,set(){},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;},send(){}};await handlers[name]({method:'POST',body,headers:{},...extra},res);return res;}
 return{call,records,calls:()=>calls,secrets:()=>secrets,advance:ms=>time+=ms,hook:fn=>hook=fn};
}
const start=async(f,redirectUri='http://localhost:5005/')=>f.call('startDiscordMembershipVerification',{redirectUri});
const complete=(f,id,extra)=>f.call('verifyDiscordMembership',{verificationId:id,code:'authorization-code'},extra);
test('허용한 복귀 주소만 인증하고 localhost 저장 대상·동의 범위를 고정',async()=>{
 const f=fixture();const res=await start(f);assert.equal(res.statusCode,200);const url=new URL(res.body.authorizationUrl);
 assert.equal(url.searchParams.get('scope'),'identify guilds.members.read');assert.equal(url.searchParams.get('state'),res.body.verificationId);
 assert.equal(f.records.get('discord_membership_verifications/user-a').localOnly,true);
 for(const uri of ['http://127.0.0.1:5005/','http://localhost:5006/','https://evil.invalid/','http://localhost:5005/admin'])assert.equal((await start(f,uri)).statusCode,400);
 assert.equal(DISCORD_REDIRECTS.size,2);
});
test('로컬 복귀 인증은 운영 사용자 설정을 변경하지 않고 역할만 반환한다',async()=>{
 const f=fixture();const res=await complete(f,(await start(f)).body.verificationId);assert.equal(res.body.membership.status,'active');assert.equal(f.records.has('users/user-a'),false);
});
test('운영 복귀 인증은 본인 운영 설정에 검증 결과를 저장한다',async()=>{
 const f=fixture();const id=(await start(f,'https://ygo-synapse.web.app/')).body.verificationId;
 const res=await complete(f,id);assert.equal(res.statusCode,200);assert.equal(f.records.get('users/user-a').settings.membership.verificationProvider,'discord');
});
test('다른 계정·만료·동시 재사용과 이전 인증을 차단한다',async()=>{
 const f=fixture(),id=(await start(f)).body.verificationId;assert.equal((await complete(f,id,{uid:'user-b'})).statusCode,403);
 assert.deepEqual((await Promise.all([complete(f,id),complete(f,id)])).map(r=>r.statusCode).sort(),[200,403]);assert.equal(f.calls(),1);
 f.advance(3001);const expired=(await start(f)).body.verificationId;f.advance(300001);assert.equal((await complete(f,expired)).statusCode,403);
 const old=(await start(f)).body.verificationId;f.advance(3001);await start(f);assert.equal((await complete(f,old)).statusCode,403);
});
test('역할·Discord ID·완료 시 복귀 주소 제출과 App Check 누락을 거부한다',async()=>{
 const f=fixture();for(const body of [{roles:[role]},{discordId:memberId},{redirectUri:'https://evil.invalid/'}])assert.equal((await f.call('verifyDiscordMembership',body)).statusCode,400);
 assert.equal((await start(fixture({app:false}))).statusCode,401);assert.equal(f.calls(),0);
});
test('로컬은 운영 검증 결과만 저장하며 클라이언트 시크릿을 읽지 않는다',async()=>{
 const f=fixture({local:true});await complete(f,'a'.repeat(64));assert.equal(f.secrets(),0);assert.equal(f.calls(),0);assert.equal(f.records.get('users/user-a').settings.membership.status,'active');assert.equal(f.records.get('users/user-a').settings.membership.type,'discord');
});
test('검증 도중 새 인증 시작·제공자 오류는 저장 없이 종료한다',async()=>{
 const f=fixture(),id=(await start(f)).body.verificationId;f.hook(async()=>{f.advance(3001);await start(f);});assert.equal((await complete(f,id)).statusCode,403);
 const bad=fixture({failure:true});const res=await complete(bad,(await start(bad)).body.verificationId);assert.equal(res.statusCode,503);assert.ok(!JSON.stringify(res.body).includes('PRIVATE'));
});
test('과거 Discord 멤버십과 다른 제공자의 확인 표시는 재인증 대상이다',()=>{
 const old={membership:{type:'discord',status:'active',verificationVersion:1}};assert.equal(sanitizeDiscordMembership(old).membership.status,'none');assert.equal(old.membership.status,'active');
 const valid={membership:{type:'discord',status:'active',verificationVersion:2,verificationProvider:'discord',levelName:'회원'}};assert.deepEqual(sanitizeDiscordMembership(valid),valid);
});
function providerFixture({scope='identify guilds.members.read',missing=false,failAt=null}={}){
 const urls=[];const fetchImpl=async(url,options)=>{urls.push(url);assert.equal(options.redirect,'error');
 if(failAt===urls.length)throw Error('PRIVATE');
 if(url.endsWith('/oauth2/token')){assert.ok(options.body.includes('client_secret=private-secret'));return{ok:true,json:async()=>({access_token:'temporary-token',scope,token_type:'Bearer'})};}
 assert.equal(options.headers.Authorization,'Bearer temporary-token');assert.ok(!url.includes('/members/'));
 return missing&&url.endsWith('/member')?{ok:false,status:404,json:async()=>({code:10004})}:{ok:true,json:async()=>url.endsWith('/@me')?{id:memberId}:{roles:[role]}};};
 return{urls,run:()=>getDiscordMembershipWithCode({code:'c',redirectUri:'http://localhost:5005/',clientId:'app',clientSecret:'private-secret',guildId:'guild'},fetchImpl)};
}
test('제공자 계정·역할 조회에 사용자 토큰만 쓰고 토큰을 반환하지 않는다',async()=>{const f=providerFixture();const result=await f.run();assert.deepEqual(result,{discordId:memberId,roles:[role]});assert.ok(!JSON.stringify(result).includes('token'));assert.equal(f.urls[2],'https://discord.com/api/v10/users/@me/guilds/guild/member');});
test('동의 범위 누락과 외부 오류를 거부하고 비회원404는 빈 역할로 반환한다',async()=>{await assert.rejects(providerFixture({scope:'identify'}).run(),e=>e.code==='DISCORD_SCOPE_REQUIRED');for(const failAt of [1,2,3])await assert.rejects(providerFixture({failAt}).run(),e=>!e.message.includes('PRIVATE'));assert.deepEqual((await providerFixture({missing:true}).run()).roles,[]);});
test('로컬 전달은 고정 API·실제 로그인·App Check만 사용한다',async()=>{
 await assert.rejects(forwardDiscordMembership('other',{},{}));
 await forwardDiscordMembership('verifyDiscordMembership',{}, {authorization:'Bearer user','x-firebase-appcheck':'app'},async(url,opt)=>{assert.equal(url,'https://asia-northeast3-ygo-synapse.cloudfunctions.net/verifyDiscordMembership');assert.equal(opt.redirect,'error');return{ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,uid:'user-a'})};});
});

test('관리자 혜택과 실제 Discord 비회원 기록을 구분하여 저장한다',async()=>{
 const f=fixture({roles:[],accountRole:'admin'});const result=await complete(f,(await start(f,'https://ygo-synapse.web.app/')).body.verificationId);
 assert.equal(result.body.membership.levelName,'관리자');assert.equal(result.body.sourceMembership.status,'none');
 assert.equal(f.records.get('users/user-a').settings.membership.status,'none');
});
