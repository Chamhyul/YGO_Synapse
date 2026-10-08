const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/script.js'),'utf8');
function extract(name,next) {return source.slice(source.indexOf(name),source.indexOf(next,source.indexOf(name)));}
function fixture({fail=false,switchUser=false,errorCode='ACCOUNT_ROLE_UNAVAILABLE'}={}) {
 const applied=[],toasts=[],elements=new Map();
 const ctx={UserStore:{user:{uid:'user-a'},settings:{membership:{status:'active',type:'account',levelName:'관리자'}}},UIStore:{},
  callApi:async()=>{if(switchUser)ctx.UserStore.user={uid:'user-b'};if(fail)throw Object.assign(Error('현재 권한 확인 실패'),{code:errorCode});return{success:true,settings:{membership:{status:'active',type:'account',levelName:'소유자'}},sourceMembership:{status:'none',type:'discord'}};},
  applyMembershipStatus:mem=>applied.push(mem),showToast:msg=>toasts.push(msg),
  showLoading(){},updateAuthUI(){},updateUserInfoCard(){},applyUserData(){},loadUserTheme(){},checkAndHideInitialLoading(){},
  console:{error(){}},resetMembershipVerifyModal(){},
  document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}},getAppModal:()=>({open(){}})
 };
 vm.createContext(ctx);vm.runInContext(extract('async function loadUserData()','function applyMembershipStatus('),ctx);
 vm.runInContext(extract('function openMembershipAuthModal(','let discordMembershipStarting'),ctx);
 return{ctx,applied,toasts,elements};
}
test('로그인 조회에서 추가 인증 없이 소유자 혜택을 적용하고 연동 배지는 외부 회원만 인정한다',async()=>{
 const f=fixture();await f.ctx.loadUserData();assert.equal(f.applied[0].levelName,'소유자');
 f.ctx.openMembershipAuthModal('settings');assert.equal(f.elements.get('badge-discord-linked').hidden,true);assert.equal(f.elements.get('badge-youtube-linked').hidden,true);
 f.ctx.UserStore.sourceMembership={status:'active',type:'discord'};f.ctx.openMembershipAuthModal();assert.equal(f.elements.get('badge-discord-linked').hidden,false);
});
test('역할 조회 실패는 이전 관리자 표시를 해제하며 로그인 계정은 유지한다',async()=>{
 const f=fixture({fail:true});await f.ctx.loadUserData();assert.equal(f.applied[0].status,'unknown');assert.equal(f.ctx.UserStore.user.uid,'user-a');assert.equal(f.ctx.UserStore.sourceMembership,null);assert.equal(f.toasts.length,1);
});
test('사용자가 바뀐 뒤 도착한 이전 역할 응답은 새 사용자 표시를 변경하지 않는다',async()=>{
 const f=fixture({switchUser:true});await f.ctx.loadUserData();assert.equal(f.applied.length,0);
});

test('앱 인증·네트워크 장애로 역할 응답을 받지 못해도 과거 관리자 혜택을 인정하지 않는다',async()=>{
 for(const errorCode of ['APPCHECK_UNAVAILABLE',undefined]) {
  const f=fixture({fail:true,errorCode});await f.ctx.loadUserData();assert.equal(f.applied[0].status,'unknown');assert.equal(f.ctx.UserStore.user.uid,'user-a');
 }
});
