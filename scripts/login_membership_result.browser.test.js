'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/script.js', 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert(start >= 0, name);
  const tail = source.slice(start), end = tail.slice(1).search(/\n(?:async )?function /);
  return tail.slice(0, end + 1);
}
const requestSource = source.slice(source.indexOf('function awaitApiPreparation('), source.indexOf('// 검색 시 최신 공통 목록', source.indexOf('function awaitApiPreparation(')));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function pageHtml(origin) {
  return `<!doctype html><meta charset="utf-8"><button id="start" onclick="beginFixture()">로그인</button>
  <div id="loading-overlay" style="display:none"><span id="loading-text"></span></div>
  <div id="home-unauth-content">로그인 필요</div><div id="home-auth-content" hidden>계정 화면</div>
  <div id="auth-modal"></div><div id="signup-modal"></div><div id="membership">미확인</div>
  <div id="user-sync-status" hidden><span data-sync-message></span><button hidden>다시 시도</button></div>
  <button data-requires-inventory>등록</button><div id="inventory">미확인</div><script src="/authentication-result.js"></script><script>
  const UIStore={},UserStore={user:null,settings:{},accountRevision:0,inventorySyncStatus:'idle'};
  let authStateRevision=0,serviceAuthStarted=false,serviceLoginPending=false,registrationCheckPending=false,loginInProgress=false,
  pendingRegistrationUser=null,pendingServiceAuthUser=null,pendingConsentVersions=null,serviceLoginFailureCode=null,
  userDataSyncTask=null,userDataSyncSerial=0,inventoryMigrationTimer,_cachedAuthToken;
  const serviceUiReady=Promise.resolve(),STORAGE_KEY='synthetic',FIREBASE_CONFIG={ENDPOINTS:{getRegistrationStatus:'${origin}/registration',getUserData:'${origin}/user'}};
  const account={uid:'synthetic',getIdToken:async()=> 'synthetic',getIdTokenResult:async()=>{
    if(window.holdToken)await new Promise(r=>window.releaseToken=r);
    return{claims:{ygoMembership:{version:'synthetic'}}};}};
  const auth={currentUser:account};window.firebase={auth:()=>auth};const M={Modal:{getInstance:()=>({close(){}})}};
  const AutoLogoutManager={start:()=>true,stop(){}},cardCacheInstance={clearAll(){},getInventory:()=>[]};
  window.followCount=0;window.toastCount=0;
  function followMembershipClaims(){followCount++;}function showToast(){toastCount++;}
  function loadUserTheme(){}function loadUserSettings(x){UserStore.settings={...UserStore.settings,...x};}
  function applyMembershipStatus(x){document.getElementById('membership').textContent=x?.status||'none';}
  function updateUserInfoCard(){}function updateProviderUI(){}function renderLinkedAccounts(){}function toggleLoginBtn(){}
  function checkAndHideInitialLoading(){if(UserStore.isUserDataSyncDone)showLoading(false);}
  function applyUserData(x){document.getElementById('inventory').textContent=x.allCards.length?'보유 카드':'빈 보유 목록';}
  const getApiAppCheckToken=async()=> 'synthetic';const callApi=(...args)=>requestApi(...args);
  ${requestSource}
  ${['showLoading','setServiceLoginPending','getServiceRegistrationStatus','handleFirebaseAuthState','applyServiceAuthState','setInventorySyncStatus','requireInventoryReady','applyAccountData','loadUserData','performUserDataSync','refreshMembershipClaims'].map(fn).join('\n')}
  window.beginFixture=()=>handleFirebaseAuthState(account);
  window.signOutFixture=()=>{authStateRevision++;auth.currentUser=null;applyServiceAuthState(null);};
  window.fixtureState=()=>({signedIn:!!UserStore.user,status:UserStore.inventorySyncStatus,claims:UserStore.claimsSyncStatus,membership:UserStore.settings.membership?.status});
  </script>`;
}
async function harness({ fallback = false, membership = 'active', large = false, recordedFailure = false, synced = false } = {}) {
  const recording = gate(), finished = gate(), calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/authentication-result.js') {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('public/authentication-result.js'));
    }
    if (url.pathname === '/registration' || url.pathname === '/user') {
      let body = ''; for await (const chunk of req) body += chunk;
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : {} });
      if (fallback && url.pathname === '/registration') {
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ success: true, registered: true }));
      }
      const data = { success: true, allCards: [[large ? 'x'.repeat(1100000) : 'synthetic']],
        settings: { membership: { status: membership } }, membershipClaims: synced
          ? { status: 'synced', version: 'synthetic' } : { status: 'pending' } };
      const result = url.pathname === '/registration' ? { success: true, registered: true, initialData: data } : data;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.write(JSON.stringify({ v: 1, type: 'result', result }) + '\n');
      await recording.promise;
      res.end(JSON.stringify({ v: 1, type: 'recorded', success: !recordedFailure,
        ...(!recordedFailure ? { result: { success: true, membershipClaims: { status: 'synced', version: 'synthetic' },
          settings: { membership: { status: 'stale' } } } } : {}) }) + '\n');
      finished.resolve(); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pageHtml(`http://127.0.0.1:${server.address().port}`));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return { page, recording, finished, calls, errors,
    async close() { recording.resolve(); await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
for (const membership of ['active', 'none']) test(`Chromium ${membership}: 기록 완료 전 회원 여부·보유 정보를 표시하고 전체 로딩을 해제한다`, async () => {
  const f = await harness({ membership, large: membership === 'active' });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => fixtureState().status === 'ready');
    assert.equal(await f.page.locator('#loading-overlay').isVisible(), false);
    assert.equal(await f.page.locator('#membership').textContent(), membership);
    assert.equal(await f.page.locator('#inventory').textContent(), '보유 카드');
    assert.equal(await f.page.locator('[data-requires-inventory]').isDisabled(), false);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].query.loginMembershipResult, 'true');
    assert.equal(await f.page.evaluate(() => fixtureState().claims), 'pending');
    const follow = await f.page.evaluate(() => followCount);
    f.recording.resolve(); await f.finished.promise; await f.page.waitForTimeout(30);
    assert.equal(await f.page.locator('#membership').textContent(), membership);
    assert.equal(await f.page.evaluate(() => followCount), follow); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('Chromium 구형 가입 응답의 getUserData 호환 조회도 첫 결과를 사용한다', async () => {
  const f = await harness({ fallback: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => fixtureState().status === 'ready');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].body.loginMembershipResult, true);
    assert.equal(await f.page.locator('#loading-overlay').isVisible(), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('Chromium 로그아웃 뒤 늦은 기록 실패가 계정·회원 표시·재시도를 되살리지 않는다', async () => {
  const f = await harness({ recordedFailure: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => fixtureState().status === 'ready');
    await f.page.evaluate(() => signOutFixture());
    const before = await f.page.evaluate(() => ({ follow: followCount, toast: toastCount }));
    f.recording.resolve(); await f.finished.promise; await f.page.waitForTimeout(30);
    assert.equal(await f.page.evaluate(() => fixtureState().signedIn), false);
    assert.equal(await f.page.locator('#home-auth-content').isVisible(), false);
    assert.deepEqual(await f.page.evaluate(() => ({ follow: followCount, toast: toastCount })), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('Chromium 정상 권한도 토큰 복사본 확인을 기다리지 않고 확정 회원 결과를 표시한다', async () => {
  const f = await harness({ synced: true });
  try {
    await f.page.evaluate(() => { window.holdToken = true; });
    await f.page.click('#start'); await f.page.waitForFunction(() => fixtureState().status === 'ready' && typeof releaseToken === 'function');
    assert.equal(await f.page.locator('#loading-overlay').isVisible(), false);
    assert.equal(await f.page.locator('#membership').textContent(), 'active');
    assert.equal(await f.page.evaluate(() => fixtureState().claims), 'checking');
    await f.page.evaluate(() => releaseToken()); await f.page.waitForFunction(() => fixtureState().claims === 'ready');
    assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
