const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function fixture(api) {
  const nodes = new Map(), calls = [];
  for (const id of ['auth-modal', 'signup-modal', 'terms-agree-cb', 'privacy-agree-cb', 'signup-status', 'signup-complete-btn', 'google-login-btn', 'twitter-login-btn', 'login-guide-msg', 'login-sub-msg']) {
    nodes.set(id, { id, checked: false, disabled: true, hidden: true, options: { dismissible: true },
      setAttribute() {}, querySelectorAll: () => [nodes.get('terms-agree-cb'), nodes.get('privacy-agree-cb')],
    });
  }
  const auth = { currentUser: { uid: 'new' }, async signInWithPopup() { calls.push('popup'); }, async signOut() { calls.push('sign-out'); auth.currentUser = null; } };
  const c = vm.createContext({
    document: { getElementById: id => nodes.get(id) }, firebase: { auth: () => auth },
    UserStore: { user: null },
    applyServiceAuthState(user) { c.UserStore.user = user; calls.push(['service-user', user?.uid || null]); },
    getAppModal: node => ({ open() { calls.push(['open', node.id]); } }),
    M: { Modal: { getInstance: node => ({ options: node.options, close() {
      calls.push(['close', node.id]); if (node.id === 'signup-modal') c.cancelServiceRegistration();
    } }) } },
    callApi: (...args) => { calls.push(['api', ...args]); return api(...args); },
    showToast: message => calls.push(['toast', message]),
    getApiAppCheckToken: async force => { calls.push(['appcheck-refresh',force]); return 'fixture-app'; },
    getProviderInstance: name => ({ name }), IS_LOCAL_DEV: true,
    setTimeout: callback => { calls.push('retry-delay'); callback(); },
  });
  vm.runInContext('let authStateRevision = 0, pendingRegistrationUser = null, pendingConsentVersions = null, registrationSaving = false, loginInProgress = false, registrationCheckPending = false, pendingServiceAuthUser = null;', c);
  for (const name of ['getServiceRegistrationStatus', 'handleFirebaseAuthState', 'toggleAuthModal', 'toggleLoginBtn', 'signInWithProvider', 'toggleRegistrationButton', 'setRegistrationSaving', 'completeServiceRegistration', 'cancelServiceRegistration']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /);
    vm.runInContext(rest.slice(0, end + 1), c);
  }
  return { c, nodes, calls, auth };
}
const newStatus = { success: true, registered: false, consentVersions: { terms: 'terms-version', privacy: 'privacy-version' } };
function agree(f) {
  f.nodes.get('terms-agree-cb').checked = f.nodes.get('privacy-agree-cb').checked = true;
  f.c.toggleRegistrationButton();
}
test('기존 회원은 신규 동의창 없이 서비스 로그인 상태로 전환한다', async () => {
  const f = fixture(async () => ({ success: true, registered: true }));
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user.uid, 'new');
  assert.equal(f.calls.some(call => call[0] === 'open'), false);
});
test('신규 회원은 서비스 로그인 전 동의창을 열며 취소하면 가입 호출 없이 로그아웃한다', async () => {
  const f = fixture(async () => newStatus);
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user, null);
  assert.ok(f.calls.some(call => call[0] === 'open' && call[1] === 'signup-modal'));
  assert.equal(f.nodes.get('signup-complete-btn').disabled, true);
  f.c.cancelServiceRegistration(); await Promise.resolve();
  assert.ok(f.calls.includes('sign-out'));
  assert.equal(f.calls.filter(call => call[0] === 'api').length, 1);
});
test('가입 성공 이후에만 로그인 상태를 열고 동의·버전을 서버에 보낸다', async () => {
  const f = fixture(async name => name === 'getRegistrationStatus' ? newStatus : { success: true, registered: true });
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f);
  await f.c.completeServiceRegistration();
  assert.equal(f.c.UserStore.user.uid, 'new');
  const request = f.calls.find(call => call[1] === 'completeRegistration');
  assert.equal(request[3].agreements.terms, true); assert.equal(request[3].agreements.privacy, true);
  assert.equal(request[3].consentVersions.terms, 'terms-version');
  assert.equal(f.calls.includes('sign-out'), false);
});
test('저장 중 중복 가입·닫기를 차단하고 실패 후 재시도를 허용한다', async () => {
  let reject;
  const f = fixture(name => name === 'getRegistrationStatus' ? Promise.resolve(newStatus) : new Promise((_, no) => { reject = no; }));
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f);
  const saving = f.c.completeServiceRegistration();
  assert.equal(f.nodes.get('signup-modal').options.dismissible, false);
  await f.c.completeServiceRegistration(); f.c.cancelServiceRegistration();
  assert.equal(f.calls.filter(call => call[1] === 'completeRegistration').length, 1);
  assert.equal(f.calls.includes('sign-out'), false);
  reject(Error('fixture')); await saving;
  assert.equal(f.c.UserStore.user, null);
  assert.equal(f.nodes.get('signup-complete-btn').disabled, false);
  assert.equal(f.nodes.get('signup-modal').options.dismissible, true);
});
test('문서 버전이 변경되면 최신 버전을 조회하고 두 동의를 다시 요구한다', async () => {
  const f = fixture(async name => {
    if (name === 'getRegistrationStatus') return newStatus;
    throw Object.assign(Error('changed'), { code: 'CONSENT_VERSION_CHANGED' });
  });
  await f.c.handleFirebaseAuthState(f.auth.currentUser); agree(f); await f.c.completeServiceRegistration();
  assert.equal(f.nodes.get('terms-agree-cb').checked, false);
  assert.equal(f.nodes.get('privacy-agree-cb').checked, false);
  assert.equal(f.nodes.get('signup-complete-btn').disabled, true);
});
test('늦게 도착한 이전 계정 조회는 로그아웃 후 동의창을 다시 열지 않는다', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.auth.currentUser = null; await f.c.handleFirebaseAuthState(null);
  finish(newStatus); await pending;
  assert.equal(f.calls.some(call => call[0] === 'open'), false);
  assert.equal(f.c.UserStore.user, null);
});
test('가입 상태 조회 실패는 기존 회원으로 간주하거나 가입 데이터를 만들지 않는다', async () => {
  const f = fixture(async () => { throw Error('unavailable'); });
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user, null); assert.equal(f.calls.includes('sign-out'), false);
  assert.equal(f.calls.filter(call => call[0] === 'api').length, 3);
  assert.equal(f.auth.currentUser.uid, 'new');
});

test('공통 Escape 처리는 가입 저장 중 dismissible=false를 존중하고 완료 후 닫기를 허용한다', () => {
  let dismissible = false, closed = 0;
  const top = { classList: { contains: name => ['modal', 'ui-overlay'].includes(name) } };
  const c = vm.createContext({
    modalStates: new Map([[top, { closing: false }]]), sheetAnimationStates: new Map(),
    document: { querySelector: () => null, addEventListener() {} },
    M: { Modal: { getInstance: () => ({ options: { dismissible }, close() { closed++; } }) } },
  });
  const start = source.indexOf('function handleManagedSheetKeydown(');
  const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(rest.slice(0, end + 1), c);
  const event = { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} };
  c.handleManagedSheetKeydown(event); assert.equal(closed, 0);
  dismissible = true; c.handleManagedSheetKeydown(event); assert.equal(closed, 1);
});

test('일시적인 가입 조회 장애 뒤 성공하면 팝업·로그아웃 없이 서비스 로그인이 완료된다', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts < 3) throw Object.assign(Error('unavailable'),{status:503}); return {success:true,registered:true}; });
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(attempts,3);assert.equal(f.c.UserStore.user.uid,'new');assert.equal(f.calls.includes('sign-out'),false);
});
test('App Check 거부는 토큰 준비를 다시 시도하며 사용자 인증을 지우지 않는다', async () => {
  let attempts=0;
  const f=fixture(async()=>{if(++attempts===1)throw Object.assign(Error('app'),{status:401,code:'APPCHECK_INVALID'});return{success:true,registered:true};});
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.calls.some(c=>c[0]==='appcheck-refresh' && c[1]===true),true);assert.equal(f.calls.includes('sign-out'),false);
});
test('실제 토큰 무효는 재시도하지 않고 로그아웃한다', async () => {
  const f=fixture(async()=>{throw Object.assign(Error('expired'),{status:401,code:'AUTH_INVALID'});});
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.calls.filter(c=>c[0]==='api').length,1);assert.equal(f.calls.includes('sign-out'),true);assert.equal(f.c.UserStore.user,null);
});
test('재시도 대기 중 로그아웃되면 추가 조회·다른 계정 적용을 중단한다', async () => {
  const f=fixture(async()=>{throw Error('network');});
  f.c.setTimeout=callback=>{f.auth.currentUser=null;f.c.handleFirebaseAuthState(null);callback();};
  await f.c.handleFirebaseAuthState({uid:'new'});
  assert.equal(f.calls.filter(c=>c[0]==='api').length,1);assert.equal(f.calls.some(c=>c[0]==='open'),false);
});
test('조회 실패 후 로그인 버튼은 OAuth 팝업을 다시 열지 않고 가입 확인만 재시도한다', async () => {
  let ready=false;
  const f=fixture(async()=>{if(!ready)throw Error('network');return{success:true,registered:true};});
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  ready=true;await f.c.signInWithProvider('google');
  assert.equal(f.c.UserStore.user.uid,'new');assert.equal(f.calls.includes('popup'),false);assert.equal(f.calls.includes('sign-out'),false);
});
test('가입 상태 확인 중에는 개인 기능과 로그인 버튼을 열지 않는다', async () => {
  let finish;
  const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user,null);assert.equal(f.nodes.get('google-login-btn').disabled,true);
  await f.c.signInWithProvider('google');assert.equal(f.calls.includes('popup'),false);
  finish({success:true,registered:true});await pending;assert.equal(f.nodes.get('google-login-btn').disabled,false);
});

function requestFixture({authError, appError}={}) {
  const calls=[];
  const c=vm.createContext({URL,AbortSignal,console:{error(){},warn(){}},
    localStorage:{getItem:()=>null},STORAGE_KEY:'fixture',UserStore:{user:null},
    FIREBASE_CONFIG:{ENDPOINTS:{getRegistrationStatus:'http://127.0.0.1:5001/getRegistrationStatus'}},
    firebase:{auth:()=>({currentUser:{getIdToken:async()=>{if(authError)throw authError;return 'fixture-auth';}}}),
      appCheck:()=>({getToken:async()=>{calls.push('appcheck');if(appError)throw appError;return{token:'fixture-app'};}})},
    fetch:async(_url,options)=>{calls.push(['request',options]);return{ok:true,json:async()=>({success:true,registered:true})};},
  });
  vm.runInContext('let _cachedAuthToken=null,_cachedAppCheckToken=null,_appCheckTokenPromise=null;',c);
  for(const name of ['getApiAppCheckToken','requestApi']) {
    const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
    const rest=source.slice(start),end=rest.slice(1).search(/\n(?:async )?function /);
    vm.runInContext(rest.slice(0,end+1),c);
  }
  return{c,calls};
}
test('앱 인증 준비 실패 시 가입 요청을 인증 헤더 없이 보내지 않는다',async()=>{
  const f=requestFixture({appError:Error('fixture-network')});
  await assert.rejects(f.c.requestApi('getRegistrationStatus'),e=>e.code==='APPCHECK_UNAVAILABLE');
  assert.equal(f.calls.some(c=>c[0]==='request'),false);
});
test('브라우저 토큰 발급의 실제 무효 오류는 서버 요청 없이 AUTH_INVALID로 구분한다',async()=>{
  const f=requestFixture({authError:{code:'auth/user-token-expired'}});
  await assert.rejects(f.c.requestApi('getRegistrationStatus'),e=>e.code==='AUTH_INVALID');
  assert.equal(f.calls.length,0);
});
test('브라우저 토큰 발급의 통신 장애는 로그인 무효로 바꾸지 않는다',async()=>{
  const f=requestFixture({authError:{code:'auth/network-request-failed'}});
  await assert.rejects(f.c.requestApi('getRegistrationStatus'),e=>e.code==='AUTH_VERIFICATION_UNAVAILABLE');
  assert.equal(f.calls.length,0);
});
test('동시 App Check 준비 요청은 하나의 발급을 공유한다',async()=>{
  const f=requestFixture();
  await Promise.all([f.c.getApiAppCheckToken(),f.c.getApiAppCheckToken()]);
  assert.equal(f.calls.filter(c=>c==='appcheck').length,1);
});
