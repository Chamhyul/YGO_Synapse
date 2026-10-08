const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/script.js'), 'utf8');
const start = source.indexOf('let youtubeMembershipVerificationPending = false;');
const end = source.indexOf('/**', start);
function fixture({ switchAt = null, cancelled = false } = {}) {
  const calls = [], toasts = []; let applied = 0, popupCount = 0;
  const user = {uid:'user-a'};
  const ctx = {UserStore:{user,settings:{}},authStateRevision:1,
    firebase:{auth:()=>({currentUser:ctx.UserStore.user})},
    getYoutubeAccessTokenViaSecondaryApp:async()=>{popupCount++; if(cancelled)throw Object.assign(Error('PRIVATE'),{code:'auth/popup-closed-by-user'}); return 'temporary-token';},
    callApi:async(name, params, body)=>{calls.push({name,body});
      if (switchAt === name) {ctx.authStateRevision++;ctx.UserStore.user={uid:'user-b'};}
      return name === 'startYoutubeMembershipVerification' ? {success:true,uid:'user-a',verificationId:'challenge'}
        : {success:true,uid:'user-a',membership:{status:'active'},isMemberActive:true};},
    showToast:(message)=>toasts.push(message),applyMembershipStatus:()=>applied++,updateAuthUI(){},
    M:{Modal:{getInstance:()=>({close(){}})}},document:{getElementById:()=>({})},resetMembershipVerifyModal(){},loadUserData(){}
  };
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  return {run:()=>ctx.startYoutubeMembershipVerify(),calls,toasts,applied:()=>applied,popups:()=>popupCount};
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
