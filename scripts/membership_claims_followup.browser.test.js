'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/script.js', 'utf8'), polling = fs.readFileSync('public/membership-claims-sync.js', 'utf8');
function fn(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert(start >= 0, name); const tail = source.slice(start), end = tail.slice(1).search(/\n(?:async )?function |\n(?:let|const) /);
    return tail.slice(0, end + 1);
}
test('실제 화면 상태 연결은 claims만 재확인하고 완료 안내·수동 재시도를 정확히 표시한다', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.clock.install();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
        <section id="user-sync-status"><span data-sync-message></span><button onclick="retryUserDataSync()">재시도</button></section>
        <script>
        let authStateRevision=1, calls=[], refreshes=0, synced=false;
        const user={uid:'synthetic',getIdTokenResult:async()=>({claims:{ygoMembership:{version:'synthetic'}}}),getIdToken:async()=>{refreshes++;}};
        const UserStore={user,inventorySyncStatus:'ready',claimsSyncStatus:'pending'},firebase={auth:()=>({currentUser:user})};
        function loadUserData(){throw Error('전체 인벤토리 재조회 금지');}
        async function callApi(name,query,body){calls.push({name,body});return {success:true,membershipClaims:synced?{status:'synced',version:'synthetic'}:{status:'pending'}};}
        ${polling}
        ${['refreshMembershipClaims','followMembershipClaims','setInventorySyncStatus','retryUserDataSync'].map(fn).join('\n')}
        followMembershipClaims(user);
        </script>` }));
        await page.goto('https://synthetic.web.app');
        assert.equal(await page.locator('#user-sync-status').isVisible(), false);
        // 실제 장애일 때만 제한 횟수 뒤 수동 재시도를 남긴다.
        for (const ms of [1, 250, 750, 1000, 2000, 2000, 6000, 12000]) { await page.clock.fastForward(ms); await page.waitForTimeout(20); }
        assert.equal(await page.locator('#user-sync-status').isVisible(), true);
        assert.match(await page.locator('[data-sync-message]').textContent(), /멤버십 권한 동기화/);
        await page.evaluate(() => { synced = true; });
        await page.locator('button').click(); await page.clock.fastForward(1); await page.waitForTimeout(20);
        assert.equal(await page.locator('#user-sync-status').isVisible(), false);
        const rows = await page.evaluate(() => calls);
        assert.equal(rows.length, 9); assert(rows.every(r => r.name === 'getUserData' && r.body.membershipClaimsOnly === true));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('worker가 850ms 뒤 완료되면 경과 1초에 회수하고 필수 전체 로딩을 유지한다', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage(); await page.clock.install();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <section id="user-sync-status"><span data-sync-message></span><button>재시도</button></section>
        <script>
        let authStateRevision=1,calls=[],synced=false,refreshes=0;
        const user={uid:'synthetic',getIdTokenResult:async()=>({claims:{}}),getIdToken:async()=>{refreshes++;}};
        const UserStore={user,inventorySyncStatus:'loading',claimsSyncStatus:'pending'},firebase={auth:()=>({currentUser:user})};
        function loadUserData(){throw Error('전체 인벤토리 재조회 금지');}
        async function callApi(name,query,body){
            calls.push({name,body}); if(calls.length===1)setTimeout(()=>{synced=true;},850);
            return {success:true,membershipClaims:synced?{status:'synced',version:'synthetic'}:{status:'pending'}};
        }
        ${polling}
        ${['refreshMembershipClaims','followMembershipClaims','setInventorySyncStatus'].map(fn).join('\n')}
        followMembershipClaims(user);
        </script>` }));
        await page.goto('https://synthetic.web.app');
        await page.clock.fastForward(1); await page.waitForTimeout(20);
        assert.equal(await page.evaluate(()=>calls.length),1);
        await page.clock.fastForward(250); await page.waitForTimeout(20);
        assert.equal(await page.evaluate(()=>calls.length),2);
        assert.equal(await page.evaluate(()=>refreshes),0);
        assert.equal(await page.evaluate(()=>UserStore.claimsSyncStatus),'checking');
        await page.clock.fastForward(750); await page.waitForTimeout(20);
        const result=await page.evaluate(()=>({calls,refreshes,claims:UserStore.claimsSyncStatus,inventory:UserStore.inventorySyncStatus}));
        assert.equal(result.calls.length,3); assert.equal(result.refreshes,1);
        assert.equal(result.claims,'ready'); assert.equal(result.inventory,'loading');
        assert(result.calls.every(c=>c.name==='getUserData'&&c.body.membershipClaimsOnly===true));
    } finally { await browser.close(); }
});

test('첫 worker 5.5초·조회 620ms에서도 마지막 완료를 회수하고 전체 로딩을 해제하지 않는다', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage(); await page.clock.install();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <section id="user-sync-status"><span data-sync-message></span><button>재시도</button></section>
        <script>
        let authStateRevision=1,calls=[],synced=false,refreshes=0;
        const user={uid:'synthetic',getIdTokenResult:async()=>({claims:{}}),getIdToken:async()=>{refreshes++;}};
        const UserStore={user,inventorySyncStatus:'loading',claimsSyncStatus:'pending'},firebase={auth:()=>({currentUser:user})};
        function loadUserData(){throw Error('전체 인벤토리 재조회 금지');}
        async function callApi(name,query,body){
            calls.push({name,body,at:performance.now()});
            const completed=synced;
            await new Promise(resolve=>setTimeout(resolve,620));
            return {success:true,membershipClaims:completed?{status:'synced',version:'synthetic'}:{status:'pending'}};
        }
        ${polling}
        ${['refreshMembershipClaims','followMembershipClaims','setInventorySyncStatus'].map(fn).join('\n')}
        setTimeout(()=>{synced=true;},5500);
        followMembershipClaims(user);
        </script>` }));
        await page.goto('https://synthetic.web.app');
        for (let i=0; i<70; i++) { await page.clock.runFor(100); }
        const result=await page.evaluate(()=>({calls,refreshes,claims:UserStore.claimsSyncStatus,inventory:UserStore.inventorySyncStatus}));
        assert.equal(result.calls.length,5); assert.equal(result.refreshes,1);
        assert(result.calls[4].at-result.calls[0].at<6100);
        assert.equal(result.claims,'ready'); assert.equal(result.inventory,'loading');
        assert(result.calls.every(c=>c.name==='getUserData'&&c.body.membershipClaimsOnly===true));
    } finally { await browser.close(); }
});
