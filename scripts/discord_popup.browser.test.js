'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('playwright');
const main = fs.readFileSync('public/script.js', 'utf8'), transport = fs.readFileSync('public/discord-popup.js', 'utf8');
const start = main.indexOf('let discordMembershipStarting = false;'), end = main.indexOf('/**\n * 멤버십 인증 메시지', start);
const init = main.slice(main.indexOf('async function initApp()'), main.indexOf('// 애플리케이션 단일 초기화'));
const bootstrap = fs.readFileSync('public/auth-bootstrap.js', 'utf8');
const rootRouter = fs.readFileSync('public/index.html', 'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const origin = 'https://synthetic.invalid';
const state = 'a'.repeat(64);
function parentHtml(blocked = false, delayed = false) {
    return `<!doctype html><script src="/discord-popup.js"></script><button id="go">Discord</button><p id="phase">idle</p><div id="loading" hidden>내 인벤토리 로딩 중...</div><script>
    ${blocked ? 'window.open = () => null;' : ''}
    let authStateRevision=1,registrationCheckPending=false,youtubeMembershipVerificationPending=false;
    const user={uid:'synthetic'},UserStore={user,settings:{},inventorySyncStatus:'ready'},firebase={auth:()=>({currentUser:user})};
    let verifyCalls=0,fullSyncCalls=0,accountObject=user;const inventoryObject={synthetic:true};let inventory=inventoryObject;
    const requireInventoryReady=()=>true,beginMembershipPreparation=()=>{},showToast=()=>{};
    const refreshMembershipClaims=async()=>true,followMembershipClaims=()=>{},applyMembershipStatus=()=>{};const setInventorySyncStatus=status=>{UserStore.inventorySyncStatus=status;};
    let finishSync;const loadUserData=async(_,options)=>{fullSyncCalls++;if(!options.membershipClaimsReadOnly)throw Error('read-only contract');document.querySelector('#loading').hidden=false;await new Promise(r=>finishSync=r);document.querySelector('#loading').hidden=true;return true;};
    async function callApi(name,params,body){if(name==='startDiscordMembershipVerification'){${delayed ? 'await new Promise(r=>window.releaseStart=r);' : ''}return{success:true,uid:user.uid,verificationId:'${state}',authorizationUrl:'https://discord.com/oauth2/authorize?'+new URLSearchParams({state:'${state}',redirect_uri:location.origin+'/'})};}
    verifyCalls++;return{success:true,uid:user.uid,membership:{status:'active'},membershipClaims:{status:'synced'}};}
    ${main.slice(start, end)}
    setDiscordMembershipHeader=phase=>{document.querySelector('#phase').textContent=phase;};
    document.querySelector('#go').onclick=()=>startDiscordMembershipVerify();prepareDiscordMembershipStart();
    </script>`;
}
async function setup(browser, { mobile = false, blocked = false, delayed = false } = {}) {
    const context = await browser.newContext(mobile ? { userAgent: 'iPhone', isMobile: true } : {});
    let authRestores = 0, rootReturns = 0, preparationPages = 0;
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://discord.com') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><button id="approve">승인</button><script>document.querySelector('#approve').onclick=()=>location.href=${JSON.stringify(origin + '/?code=synthetic-code&state=' + state)};</script>` });
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/discord-popup.js') return route.fulfill({ contentType: 'text/javascript', body: transport });
        if (url.pathname === '/discord-popup.html') { if(url.searchParams.get('preparing')==='1')preparationPages++;return route.fulfill({ contentType: 'text/html', body: fs.readFileSync('public/discord-popup.html') }); }
        if (url.pathname === '/synthetic-auth-restore') { authRestores++; return route.fulfill({ body: '{}' }); }
        if (url.searchParams.has('code')) {
            rootReturns++;
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${rootRouter}</script><script src="/discord-popup.js" defer></script><script>const firebase={app(){fetch('/synthetic-auth-restore');throw Error('unexpected auth');}};${bootstrap}\n${init}\ninitApp();</script>` });
        }
        return route.fulfill({ contentType: 'text/html', body: parentHtml(blocked, delayed) });
    });
    const page = await context.newPage(); await page.goto(origin + '/#settings');
    if (delayed) await page.waitForFunction(() => typeof releaseStart === 'function');
    else await page.waitForFunction(() => discordMembershipStartPreparation?.result);
    return { context, page, counts: () => ({ authRestores, rootReturns, preparationPages }) };
}
for (const needsSync of [false,true]) test(`Chromium: popup 복귀는 인벤토리 ${needsSync?'오류시 전체 로딩':'준비시 재조회 생략'}과 계정 보존을 유지한다`, async () => {
    const browser = await chromium.launch();
    try {
        const f = await setup(browser), { page, context } = f;
        const popupEvent = context.waitForEvent('page'); await page.click('#go'); const popup = await popupEvent; await popup.waitForURL('https://discord.com/**');
        // 같은 origin이어도 원래 창에서 보낸 메시지는 source가 달라 거부한다.
        await page.evaluate(state => window.postMessage({ type: 'ygo.discord.oauth.result', version: 1, state, code: 'forged' }, location.origin), state);
        assert.equal(await page.evaluate(() => verifyCalls), 0);
        if(needsSync)await page.evaluate(()=>UserStore.inventorySyncStatus='error');
        await popup.click('#approve');
        if(needsSync)await page.waitForFunction(() => fullSyncCalls === 1);else await page.waitForFunction(() => document.querySelector('#phase').textContent === 'complete');
        assert.equal(page.url(), origin + '/#settings'); assert.equal(await page.locator('#loading').isVisible(), needsSync);
        assert.equal(await page.locator('#phase').textContent(), 'complete');
        assert.deepEqual(f.counts(), { authRestores: 0, rootReturns: 1, preparationPages: 0 });
        assert.equal(await page.evaluate(() => UserStore.user === accountObject && inventory === inventoryObject), true);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('discord_membership_verification')), null);
        if(needsSync)await page.evaluate(() => finishSync());
        assert.equal(await page.evaluate(() => fullSyncCalls),needsSync?1:0);await page.waitForFunction(() => document.querySelector('#phase').textContent === 'complete');
        assert.equal(await page.locator('#loading').isVisible(), false); assert.equal(await page.evaluate(() => verifyCalls), 1);
        await context.close();
    } finally { await browser.close(); }
});
test('Chromium: 시작 API가 느리면 팝업은 문구 없이 기다린 뒤 Discord로 이동한다', async () => {
    const browser = await chromium.launch();
    try {
        const f = await setup(browser, { delayed: true }), popupEvent = f.context.waitForEvent('page');
        await f.page.click('#go'); const popup = await popupEvent;
        await popup.waitForURL(origin + '/discord-popup.html?preparing=1');
        await popup.waitForLoadState('domcontentloaded');
        assert.equal(await popup.locator('body').innerText(), '');
        assert.equal(await popup.locator('main').isVisible(), false);
        assert.equal(await f.page.evaluate(() => verifyCalls), 0); assert.equal(f.page.url(), origin + '/#settings');
        await f.page.evaluate(() => releaseStart()); await popup.waitForURL('https://discord.com/**');
        await f.context.close();
    } finally { await browser.close(); }
});
test('Chromium: 모바일과 팝업 차단은 새 창 없이 기존 페이지 리다이렉트·nonce 계약을 유지한다', async () => {
    const browser = await chromium.launch();
    try {
        for (const options of [{ mobile: true }, { blocked: true }]) {
            const f = await setup(browser, options); await f.page.click('#go'); await f.page.waitForURL('https://discord.com/**');
            assert.equal(f.context.pages().length, 1);
            await f.page.goto(origin + '/#settings');
            const pending = await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('discord_membership_verification')));
            assert.equal(pending.state, state); assert.equal(pending.uid, 'synthetic'); await f.context.close();
        }
    } finally { await browser.close(); }
});
