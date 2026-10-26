'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const { chromium } = require('playwright');
const protocol = require('../functions/services/authenticationResult');
const main = fs.readFileSync('public/script.js', 'utf8');
const ytStart = main.indexOf('let youtubeMembershipVerificationPending = false;');
const youtube = main.slice(ytStart, main.indexOf('/**', ytStart));
const dcStart = main.indexOf('let discordMembershipStarting = false;');
const discord = main.slice(dcStart, main.indexOf('/**\n * 멤버십 인증 메시지', dcStart));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const state = 'a'.repeat(64);
function membershipHtml(provider) {
  return `<!doctype html><button id="run">인증</button><p id="phase">idle</p><p id="result"></p><div id="membership-auth-modal">선택창</div>
  <script src="/authentication-result.js"></script><script>
  const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'};
  let authStateRevision=1,registrationCheckPending=false;
  const firebase={auth:()=>({currentUser:UserStore.user})};window.isAuthInitialized=true;
  const requireInventoryReady=()=>true,followMembershipClaims=()=>{},setInventorySyncStatus=()=>{};
  const M={Modal:{getInstance:()=>({close(){document.querySelector('#membership-auth-modal').hidden=true;}})}};
  function resetMembershipVerifyModal(){}function showToast(){}
  function applyMembershipStatus(value){document.querySelector('#result').textContent=value.status;}
  async function getYoutubeAccessTokenViaSecondaryApp(){return 'synthetic';}
  async function refreshMembershipClaims(){await new Promise(r=>window.releaseClaims=r);return true;}
  async function callApi(name,params,body){
    if(body?.membershipPrepare)return new Promise(()=>{});
    if(name.startsWith('start'))return{success:true,uid:user.uid,verificationId:'${state}'};
    return YgoAuthenticationResult.read(await fetch('/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
  }
  ${youtube}\n${discord}
  setDiscordMembershipHeader=phase=>{document.querySelector('#phase').textContent=phase;};
  ${provider === 'discord' ? `sessionStorage.setItem('discord_membership_verification',JSON.stringify({uid:user.uid,state:'${state}',expiresAt:Date.now()+300000}));` : ''}
  document.querySelector('#run').onclick=()=>${provider === 'youtube' ? 'startYoutubeMembershipVerify()' : 'handleDiscordOAuthCallback()'};
  </script>`;
}
function adminHtml() {
  return `<!doctype html><body data-admin-page="/admin"><section id="admin-login"><p id="admin-status"></p><div id="admin-providers"></div>
  <button id="admin-retry"></button><button id="admin-switch"></button><button id="admin-google"></button><button id="admin-twitter"></button></section>
  <script>const user={uid:'synthetic',getIdToken:async()=> 'synthetic'},firebase={app:()=>({options:{}}),auth:()=>({currentUser:user,onAuthStateChanged(fn){fn(user);},getRedirectResult:async()=>({user})})};
  window.createAuthSession=()=>({start:()=>true,stop(){}});</script>
  <script src="/authentication-result.js"></script><script src="/admin-session.js"></script><script src="/admin.js"></script>`;
}
async function harness({ provider, status = 'active', admin = false }) {
  const recording = gate(), finished = gate(), providerReady = gate(); let sessionStored = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (['/authentication-result.js', '/admin-session.js', '/admin.js'].includes(url.pathname)) {
        res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('public' + url.pathname));
      }
      if (url.pathname === '/verify' || url.pathname === '/admin/session') {
        res.status = n => { res.statusCode = n; return res; };
        res.set = (key, value) => { res.setHeader(key, value); return res; };
        res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
        req.body = { authenticationResultStream: true };
        return await protocol.withAuthenticationResult(req, res, admin ? 'admin' : 'membership', async output => {
          providerReady.resolve();
          const result = admin ? { success: true, role: 'owner' } : { success: true, uid: 'synthetic',
            membership: { status }, sourceMembership: { status }, membershipClaims: { status: 'pending' } };
          sessionStored = true;
          protocol.prepareAuthenticationResult(result, admin ? () => res.setHeader('Set-Cookie', '__session=synthetic; Path=/admin; HttpOnly; SameSite=Strict') : undefined);
          protocol.publishAuthenticationResult();
          await recording.promise;
          output.json(result); finished.resolve();
        });
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (admin && url.pathname === '/admin') return res.end(sessionStored && req.headers.cookie?.includes('__session=synthetic')
        ? '<!doctype html><p id="authorized">관리자 본문</p>' : '<!doctype html>접근 거부');
      res.end(admin ? adminHtml() : membershipHtml(provider));
    } catch (_) { if (!res.writableEnded) res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { page, recording, finished, providerReady, errors,
    async open() { await page.goto(origin + '/login' + (provider === 'discord' ? '?code=synthetic&state=' + state : '')); },
    async close() { recording.resolve(); await context.close(); await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
for (const provider of ['youtube', 'discord']) for (const status of ['active', 'none']) test(`Chromium ${provider}/${status}: 기록·claims 대기 중에도 결과와 완료 화면이 표시된다`, async () => {
  const f = await harness({ provider, status });
  try {
    await f.open(); await f.page.click('#run');
    await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'complete');
    assert.equal(await f.page.locator('#result').textContent(), status);
    assert.equal(await f.page.locator('#membership-auth-modal').isVisible(), false);
    assert.deepEqual(f.errors, []);
    f.recording.resolve(); await f.finished.promise;
    await f.page.evaluate(() => window.releaseClaims?.());
  } finally { await f.close(); }
});
test('Chromium 관리자: keepalive 결과 수신 후 기록 종료 전에 세션 쿠키로 본문에 진입한다', async () => {
  const f = await harness({ admin: true });
  try {
    await f.open(); await f.page.waitForSelector('#authorized');
    assert.equal(await f.page.locator('#authorized').textContent(), '관리자 본문');
    assert.deepEqual(f.errors, []);
    f.recording.resolve(); await f.finished.promise;
  } finally { await f.close(); }
});
