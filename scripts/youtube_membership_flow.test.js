const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');
const start = source.indexOf('let youtubeMembershipVerificationPending = false;');
const end = source.indexOf('/**', start);
function fixture({ switchAt = null, cancelled = false, verified = null, inventoryStatus = 'ready' } = {}) {
  const calls = [], toasts = [], header = [], reloadOptions = []; let applied = 0, popupCount = 0, closed = 0, reloaded = 0, reset = 0;
  const user = {uid:'user-a'};
  const ctx = {requireInventoryReady:()=>true,UserStore:{user,settings:{},inventorySyncStatus:inventoryStatus},authStateRevision:1,
    firebase:{auth:()=>({currentUser:ctx.UserStore.user})},
    getYoutubeAccessTokenViaSecondaryApp:async()=>{popupCount++; if(cancelled)throw Object.assign(Error('PRIVATE'),{code:'auth/popup-closed-by-user'}); return 'temporary-token';},
    callApi:async(name, params, body)=>{if(body?.membershipPrepare)return {success:true,membershipPreparation:{version:1,target:name,ready:true}};calls.push({name,body});
      if (switchAt === name) {ctx.authStateRevision++;ctx.UserStore.user={uid:'user-b'};}
      return name === 'startYoutubeMembershipVerification' ? {success:true,uid:'user-a',verificationId:'challenge'}
        : verified || {success:true,uid:'user-a',membership:{status:'active'},isMemberActive:true};},
    refreshMembershipClaims:async()=>false,followMembershipClaims:()=>{},setInventorySyncStatus:status=>{ctx.UserStore.inventorySyncStatus=status;},setDiscordMembershipHeader:(phase)=>header.push(phase),showToast:(message)=>toasts.push(message),applyMembershipStatus:()=>applied++,
    M:{Modal:{getInstance:()=>({close(){closed++;}})}},document:{getElementById:()=>({})},resetMembershipVerifyModal(){reset++;},loadUserData(initial, options){reloaded++;reloadOptions.push({initial, ...options});}
  };
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  return {header,reloadOptions,run:()=>ctx.startYoutubeMembershipVerify(),calls,toasts,applied:()=>applied,popups:()=>popupCount,lifecycle:()=>({closed,reloaded,reset}),ctx};
}
test('팝업 임시 토큰을 서버로 전달하고 채널 ID·토큰을 로컬 저장소에 저장하지 않는다',async()=>{
  const f=fixture();await f.run();assert.equal(f.applied(),1);
  assert.equal(f.calls[1].name,'verifyYoutubeMembership');assert.equal(f.calls[1].body.accessToken,'temporary-token');
  assert.equal('userChannelId' in f.calls[1].body,false);
});
test('인증 시작 후 서비스 계정이 바뀌면 완료 요청과 화면 갱신을 중단한다',async()=>{
  const f=fixture({switchAt:'startYoutubeMembershipVerification'});await f.run();assert.equal(f.calls.length,1);assert.equal(f.applied(),0);
});
test('인증 응답 중 서비스 계정이 바뀌면 새 사용자 화면을 갱신하지 않는다',async()=>{
  const f=fixture({switchAt:'verifyYoutubeMembership'});await f.run();assert.equal(f.applied(),0);
});
test('중복 클릭은 팝업을 하나만 열고 팝업 취소에 원문 오류를 표시하지 않는다',async()=>{
  const f=fixture();await Promise.all([f.run(),f.run()]);assert.equal(f.popups(),1);
  const cancelled=fixture({cancelled:true});await cancelled.run();assert.equal(cancelled.calls.length,1);assert.equal(cancelled.applied(),0);
  assert.ok(cancelled.toasts.every(v=>!v.includes('PRIVATE')));
});

test('소유자 혜택과 외부 YouTube 회원 결과를 구분해 안내한다',async()=>{for(const status of ['none','active']){const f=fixture({verified:{success:true,uid:'user-a',membership:{status:'active',type:'account'},sourceMembership:{status,type:'csv'},isMemberActive:true}});await f.run();assert.equal(f.applied(),1);assert.equal(f.toasts.length,status==='active'?0:1);if(status==='none')assert.match(f.toasts[0],/등록되어 있지 않습니다/);assert.deepEqual(f.header,['pending','complete']);}});

// 실제 페이지에 없는 전역 함수를 더미로 제공하지 않고 최종 완료까지 검사한다.
test('YouTube 완료는 준비된 인벤토리를 재조회하지 않고 창을 닫는다',async()=>{
  for(const status of ['none','active']){
    const membership={status:'active',type:'account'},sourceMembership={status,type:'csv'};
    const f=fixture({verified:{success:true,uid:'user-a',membership,sourceMembership,isMemberActive:true}});
    await f.run();
    assert.deepEqual(f.lifecycle(),{closed:1,reloaded:0,reset:1});
    assert.deepEqual(f.reloadOptions,[]);
    assert.equal(f.ctx.UserStore.settings.membership,membership);
    assert.equal(f.ctx.UserStore.sourceMembership,sourceMembership);
    assert.equal(f.toasts.length,status==='active'?0:1);assert.deepEqual(f.header,['pending','complete']);
    assert(!f.toasts.some(t=>t.includes('완료하지 못했습니다')));
  }
});
test('YouTube 팝업 취소·계정 변경은 완료 창 닫기와 재조회를 실행하지 않는다',async()=>{
  for(const options of [{cancelled:true},{switchAt:'verifyYoutubeMembership'}]){
    const f=fixture(options);await f.run();assert.deepEqual(f.lifecycle(),{closed:0,reloaded:0,reset:0});
  }
});

test('인증 결과 전에 인벤토리가 오류/미준비 상태가 되면 기존 전체 동기화 옵션을 유지한다',async()=>{
 for(const inventoryStatus of ['error','idle','loading']) {
  const f=fixture({inventoryStatus});await f.run();assert.equal(f.lifecycle().reloaded,1);
  assert.deepEqual(f.reloadOptions,[{initial:undefined,membershipClaimsReadOnly:true}]);
 }
});

test('claims 토큰 확인 실패는 인벤토리를 재조회하거나 권한 완료로 간주하지 않고 후속 확인한다',async()=>{
 const f=fixture({verified:{success:true,uid:'user-a',membership:{status:'active'},sourceMembership:{status:'active'},membershipClaims:{status:'synced',version:'synthetic'}}});
 let followed=0;f.ctx.followMembershipClaims=()=>followed++;
 await f.run();assert.equal(f.ctx.UserStore.claimsSyncStatus,'pending');assert.equal(followed,1);
 assert.equal(f.lifecycle().reloaded,0);assert.deepEqual(f.header,['pending','complete']);
});
