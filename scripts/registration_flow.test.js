const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/script.js'), 'utf8');
function fixture(api) {
  const nodes = new Map(), calls = [];
  for (const id of ['auth-modal', 'signup-modal', 'terms-agree-cb', 'privacy-agree-cb', 'signup-status', 'signup-complete-btn', 'google-login-btn', 'twitter-login-btn', 'service-login-retry-btn', 'login-guide-msg', 'login-sub-msg', 'loading-overlay', 'loading-text']) {
    nodes.set(id, { id, checked: false, disabled: true, hidden: true, options: { dismissible: true },
      style: { display: 'none' }, setAttribute() {}, querySelectorAll: () => [nodes.get('terms-agree-cb'), nodes.get('privacy-agree-cb')],
    });
  }
  const auth = { currentUser: { uid: 'new' }, async signInWithPopup() { calls.push('popup'); }, async signOut() { calls.push('sign-out'); auth.currentUser = null; } };
  const c = vm.createContext({
    document: { getElementById: id => nodes.get(id), body: { classList: { add() {}, remove() {} } } },
    window: { isAuthInitialized: true }, firebase: { auth: () => auth }, AbortSignal,
    UserStore: { user: null, isInitialSyncDone: true },
    applyServiceAuthState(user) { c.UserStore.user = user; calls.push(['service-user', user?.uid || null]); if (!user) c.showLoading(false); },
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
  vm.runInContext('let authStateRevision = 0, pendingRegistrationUser = null, pendingConsentVersions = null, registrationSaving = false, loginInProgress = false, registrationCheckPending = false, pendingServiceAuthUser = null, serviceLoginPending = false;', c);
  for (const name of ['showLoading', 'setServiceLoginPending', 'checkAndHideInitialLoading', 'awaitApiPreparation', 'getServiceRegistrationStatus', 'handleFirebaseAuthState', 'toggleAuthModal', 'toggleLoginBtn', 'retryServiceLoginConfirmation', 'signInWithProvider', 'toggleRegistrationButton', 'setRegistrationSaving', 'completeServiceRegistration', 'cancelServiceRegistration']) {
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
  vm.runInContext('let _cachedAuthToken=null;',c);
  for(const name of ['getApiAppCheckToken','awaitApiPreparation','requestApi']) {
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
test('각 API 요청은 SDK가 반환하는 현재 App Check 토큰을 사용한다',async()=>{
  const f=requestFixture();
  let calls=0;
  f.c.firebase.appCheck=()=>({getToken:async()=>({token:++calls===1?'first-fixture-token':'refreshed-fixture-token'})});
  await f.c.requestApi('getRegistrationStatus');
  await f.c.requestApi('getRegistrationStatus');
  const requests=f.calls.filter(c=>c[0]==='request');
  assert.equal(requests[0][1].headers['X-Firebase-AppCheck'],'first-fixture-token');
  assert.equal(requests[1][1].headers['X-Firebase-AppCheck'],'refreshed-fixture-token');
  assert.equal(calls,2);
});
test('App Check 강제 갱신 여부는 SDK에 전달한다',async()=>{
  const f=requestFixture();const flags=[];
  f.c.firebase.appCheck=()=>({getToken:async force=>{flags.push(force);return{token:'fixture-token'};}});
  await f.c.getApiAppCheckToken();await f.c.getApiAppCheckToken(true);
  assert.deepEqual(flags,[false,true]);
});
test('가입 확인 제한 시간이 지나면 App Check 준비 대기를 끝내고 늦은 토큰으로 요청하지 않는다',async()=>{
  const f=requestFixture();const deadline=new AbortController();let finish,started;
  const preparing=new Promise(resolve=>{started=resolve;});
  f.c.AbortSignal={timeout:()=>deadline.signal};
  f.c.firebase.appCheck=()=>({getToken:()=>new Promise(resolve=>{finish=resolve;started();})});
  const pending=f.c.requestApi('getRegistrationStatus');
  await preparing;deadline.abort();
  await assert.rejects(pending,e=>e.code==='SERVICE_CHECK_TIMEOUT');
  finish({token:'late-fixture-token'});await Promise.resolve();
  assert.equal(f.calls.some(c=>c[0]==='request'),false);
});
test('가입 확인 제한 시간은 사용자 토큰 준비 대기에도 적용한다',async()=>{
  const f=requestFixture();const deadline=new AbortController();let finish;
  f.c.AbortSignal={timeout:()=>deadline.signal};
  f.c.firebase.auth=()=>({currentUser:{getIdToken:()=>new Promise(resolve=>{finish=resolve;})}});
  const pending=f.c.requestApi('getRegistrationStatus');deadline.abort();
  await assert.rejects(pending,e=>e.code==='SERVICE_CHECK_TIMEOUT');
  finish('late-fixture-auth');await Promise.resolve();
  assert.equal(f.calls.length,0);
});
test('서비스 확인 실패는 계정 인증을 유지하고 전용 재확인 버튼을 표시한다',async()=>{
  let ready=false;let finish;
  const f=fixture(()=>ready?new Promise(resolve=>{finish=resolve;}):Promise.reject(Object.assign(Error('app'),{code:'APPCHECK_INVALID',status:401})));
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.c.UserStore.user,null);assert.equal(f.auth.currentUser.uid,'new');
  assert.equal(f.nodes.get('service-login-retry-btn').hidden,false);
  assert.equal(f.nodes.get('service-login-retry-btn').disabled,false);
  assert.equal(f.nodes.get('google-login-btn').hidden,true);
  assert.equal(f.nodes.get('twitter-login-btn').hidden,true);
  assert.equal(f.nodes.get('login-guide-msg').textContent,'로그인을 완료하지 못했습니다. 다시 시도해 주세요.');
  ready=true;const retry=f.c.retryServiceLoginConfirmation();
  assert.equal(f.nodes.get('loading-overlay').style.display,'flex');
  await f.c.retryServiceLoginConfirmation();
  finish({success:true,registered:true});await retry;
  assert.equal(f.calls.filter(c=>c[0]==='api').length,4);
  assert.equal(f.calls.includes('popup'),false);assert.equal(f.calls.includes('sign-out'),false);
  assert.equal(f.c.UserStore.user.uid,'new');assert.equal(f.nodes.get('service-login-retry-btn').hidden,true);
});
test('서비스 확인 실패 뒤 실제 로그아웃되면 Google·X 로그인 버튼으로 복귀한다',async()=>{
  const f=fixture(async()=>{throw Error('network');});
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.auth.currentUser=null;await f.c.handleFirebaseAuthState(null);
  f.c.toggleAuthModal();
  assert.equal(f.nodes.get('service-login-retry-btn').hidden,true);
  assert.equal(f.nodes.get('google-login-btn').hidden,false);
  assert.equal(f.nodes.get('twitter-login-btn').hidden,false);
  assert.doesNotMatch(f.nodes.get('login-guide-msg').textContent,/계정 인증은 완료/);
});


test('팝업 결과 반환 후 가입 확인이 끝나기 전에는 공통 로딩 종료 요청도 로그인 로딩을 닫지 않는다', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.nodes.get('google-login-btn').disabled = false;
  await f.c.signInWithProvider('google');
  assert.equal(f.nodes.get('loading-overlay').style.display, 'flex');
  assert.equal(f.c.UserStore.user, null);
  const checking = f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.c.showLoading(false);
  f.c.checkAndHideInitialLoading();
  assert.equal(f.nodes.get('loading-overlay').style.display, 'flex');
  assert.equal(f.nodes.get('loading-text').innerHTML, '로그인 중...');
  finish({success:true,registered:true});await checking;
  assert.equal(f.c.UserStore.user.uid, 'new');
  assert.equal(f.nodes.get('loading-overlay').style.display, 'none');
});
test('가입 조회 재시도 중에는 로딩을 유지하고 최종 실패 때만 해제한다',async()=>{
  let attempt=0;let f;
  f=fixture(async()=>{
    attempt++;
    assert.equal(f.nodes.get('loading-overlay').style.display,'flex');
    throw Object.assign(Error('조회 장애'),{status:503});
  });
  await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(attempt,3);assert.equal(f.nodes.get('loading-overlay').style.display,'none');
  assert.equal(f.c.UserStore.user,null);assert.ok(f.calls.some(call=>call[0]==='toast'));
});
test('인증 팝업 취소는 최종 실패로 로딩을 해제하고 초기 비로그인 알림은 팝업을 중단하지 않는다',async()=>{
  let cancel;
  const f=fixture(async()=>({success:true,registered:true}));
  f.nodes.get('google-login-btn').disabled=false;
  f.auth.signInWithPopup=()=>new Promise((_,reject)=>{cancel=reject;});
  const popup=f.c.signInWithProvider('google');
  await f.c.handleFirebaseAuthState(null);
  assert.equal(f.nodes.get('loading-overlay').style.display,'flex');
  cancel(Error('팝업 취소'));await popup;
  assert.equal(f.nodes.get('loading-overlay').style.display,'none');
});
test('신규 가입 화면 전환이 확정되면 로그인 로딩을 해제하여 동의 화면을 조작할 수 있다',async()=>{
  const f=fixture(async()=>newStatus);await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.nodes.get('loading-overlay').style.display,'none');
  assert.ok(f.calls.some(call=>call[0]==='open'&&call[1]==='signup-modal'));
});
test('계정 변경 뒤 도착한 이전 가입 확인은 새 계정의 로그인 로딩을 닫지 않는다',async()=>{
  const finish=[];
  const f=fixture(()=>new Promise(resolve=>finish.push(resolve)));
  const first=f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.auth.currentUser={uid:'other'};
  const second=f.c.handleFirebaseAuthState(f.auth.currentUser);
  finish[0]({success:true,registered:true});await first;
  assert.equal(f.nodes.get('loading-overlay').style.display,'flex');
  assert.equal(f.c.UserStore.user,null);
  finish[1]({success:true,registered:true});await second;
  assert.equal(f.nodes.get('loading-overlay').style.display,'none');assert.equal(f.c.UserStore.user.uid,'other');
});

test('가입 확인 중 로그아웃이 확정되면 로딩을 해제하고 늦은 응답을 적용하지 않는다',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));
  const checking=f.c.handleFirebaseAuthState(f.auth.currentUser);
  f.auth.currentUser=null;await f.c.handleFirebaseAuthState(null);
  assert.equal(f.nodes.get('loading-overlay').style.display,'none');
  finish({success:true,registered:true});await checking;
  assert.equal(f.c.UserStore.user,null);assert.equal(f.nodes.get('loading-overlay').style.display,'none');
});
test('로그인 확정 뒤 시작한 인벤토리 로딩을 인증 처리 finally가 닫지 않는다',async()=>{
  const f=fixture(async()=>({success:true,registered:true}));
  const apply=f.c.applyServiceAuthState;
  f.c.applyServiceAuthState=user=>{apply(user);if(user)f.c.showLoading(true,'내 인벤토리 로딩 중...');};
  f.nodes.get('google-login-btn').disabled=false;
  await f.c.signInWithProvider('google');await f.c.handleFirebaseAuthState(f.auth.currentUser);
  assert.equal(f.nodes.get('loading-overlay').style.display,'flex');
  assert.equal(f.nodes.get('loading-text').innerHTML,'내 인벤토리 로딩 중...');
});


test('로그인 수단과 재시도 버튼은 hidden으로만 표시 상태를 전환한다', () => {
  const f = fixture(async () => ({ success: true, registered: true }));
  for (const id of ['google-login-btn', 'twitter-login-btn', 'service-login-retry-btn']) {
    Object.defineProperty(f.nodes.get(id).style, 'display', {
      get: () => '', set: () => { throw new Error('display 인라인 쓰기 금지'); },
    });
  }
  vm.runInContext('pendingServiceAuthUser = { uid: "new" }; toggleLoginBtn();', f.c);
  assert.equal(f.nodes.get('google-login-btn').hidden, true);
  assert.equal(f.nodes.get('service-login-retry-btn').hidden, false);
  vm.runInContext('pendingServiceAuthUser = null; toggleLoginBtn();', f.c);
  assert.equal(f.nodes.get('google-login-btn').hidden, false);
  assert.equal(f.nodes.get('twitter-login-btn').hidden, false);
  assert.equal(f.nodes.get('service-login-retry-btn').hidden, true);
});
