'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/script.js', 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const cls = section('class ClientCache {', '\nconst cardCacheInstance');
const chosung = section('const HANGUL_CHOSUNG_LIST', '// 디바운스');
const auth = section('function applyServiceAuthState(', '\nlet currentNoticeIndex');
const apply = section('function applyUserData(', '\nfunction rarityLangsToRows');
const provider = section('function updateProviderUI(', '\nfunction getProviderInstance');
const search = fs.readFileSync('public/catalog-search.js', 'utf8').split('\nfunction groupCatalogResults')[0];

test('Chromium의 실제 계정 적용·검색은 공개 색인을 유지하며 이전 계정 이름/CID/보유 표시를 지운다', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(`<!doctype html><meta charset="utf-8"><body>
            <button id="a">계정 A</button><button id="b">계정 B</button><button id="out">로그아웃</button>
            <div id="home-unauth-content"></div><div id="home-auth-content" hidden></div><div id="auth-modal"></div>
            <input id="query"><pre id="matches"></pre><span id="amount"></span><div class="target-inventory-section"></div>
            <script>
            const normalizeStr=value=>String(value).replace(/\\s+/g,'').toLowerCase();
            ${chosung}
            let normalized=0;const originalChosung=getChosung;getChosung=value=>{normalized++;return originalChosung(value);};
            function refreshLocalLookups(){}function scheduleInventoryMigration(){}function loadUserSettings(){}function updateRarityInputs(){}
            ${cls}
            const cardCacheInstance=new ClientCache();cardCacheInstance.setAllKnownNames(['청안의 백룡','공개 카드','다크 매지션']);
            const publicNames=cardCacheInstance.getAllNames(),publicEntries=cardCacheInstance.getAllNamesNormalized();normalized=0;
            const CardDataStore={allCardNamesNormalized:[],allCardNumbers:[]};
            const UserStore={user:null,settings:{},accountRevision:0,inventorySyncStatus:'idle'};
            const UIStore={mode:'home'};
            let userDataSyncSerial=0,userDataSyncTask=null,inventoryMigrationTimer=null;
            const AutoLogoutManager={start:()=>true,stop(){}};
            const M={Modal:{getInstance:()=>({close(){}})}};
            function loadUserTheme(){}function renderLinkedAccounts(){}function checkAndHideInitialLoading(){}
            function setInventorySyncStatus(value){UserStore.inventorySyncStatus=value;}
            function renderOwnedCardsToContainer(rows,node){node.textContent='';}
            function updateTotals(){document.getElementById('amount').textContent=cardCacheInstance.getAmount();}
            function refreshCurrentSearchResult(){document.getElementById('matches').textContent=JSON.stringify(collectCatalogMatches(document.getElementById('query').value));}
            ${search}
            ${apply}
            ${provider}
            function loadUserData(data){UserStore.inventorySyncStatus='ready';applyUserData(data);UserStore.isUserDataSyncDone=true;}
            ${auth}
            const full=(name,no,cid,extra)=>({success:true,allCards:[[name,no,'N',2,'상자','1',cid],[extra,no+'-X','N',1,'상자','1',cid+'1']],amount:3,locations:{},rarities:{}});
            document.getElementById('a').onclick=()=>applyServiceAuthState({uid:'synthetic-a'},full('청안의 백룡','A-000001','100','A 계정 별칭'));
            document.getElementById('b').onclick=()=>applyServiceAuthState({uid:'synthetic-b'},full('다크 매지션','B-000001','200','B 계정 별칭'));
            document.getElementById('out').onclick=()=>{applyServiceAuthState(null);refreshCurrentSearchResult();};
            document.getElementById('query').oninput=refreshCurrentSearchResult;
            window.inspect=()=>({normalized,publicRestored:cardCacheInstance.getAllNames()===publicNames&&cardCacheInstance.getAllNamesNormalized()===publicEntries,
                owned:[...cardCacheInstance.getOwnedNamesSet()],numbers:cardCacheInstance.getOwnedNumbers(),cidA:cardCacheInstance._inventoryNoToCid['A-000001']||null,
                names:cardCacheInstance.getAllNames(),amount:cardCacheInstance.getAmount()});
            </script>`);
        const matches = async () => JSON.parse(await page.locator('#matches').textContent());
        await page.getByRole('button', { name: '계정 A', exact: true }).click();
        await page.locator('#query').fill('ㅊㅇ'); assert.equal((await matches())[0].val, '청안의 백룡');
        assert.equal((await matches())[0].isOwned, true);
        await page.locator('#query').fill('a계정'); assert.equal((await matches())[0].val, 'A 계정 별칭');
        await page.locator('#query').fill('a-000001'); assert((await matches()).some(x => x.type === 'number' && x.isOwned));
        await page.getByRole('button', { name: '계정 B', exact: true }).click();
        await page.locator('#query').fill('a계정'); assert.deepEqual(await matches(), []);
        await page.locator('#query').fill('ㅊㅇ'); assert.equal((await matches())[0].isOwned, false);
        await page.locator('#query').fill('다크'); assert.equal((await matches())[0].isOwned, true);
        const b = await page.evaluate(() => inspect());
        assert.equal(b.cidA, null); assert(!b.owned.includes('A 계정 별칭')); assert.equal(b.normalized, 2);
        await page.getByRole('button', { name: '로그아웃', exact: true }).click();
        const out = await page.evaluate(() => inspect());
        assert.deepEqual(out.owned, []); assert.deepEqual(out.numbers, []); assert.equal(out.amount, 0);
        assert(out.publicRestored); assert.equal(out.normalized, 2); assert(!out.names.includes('B 계정 별칭'));
        await page.locator('#query').fill('ㅊㅇ'); assert.equal((await matches())[0].isOwned, false);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
