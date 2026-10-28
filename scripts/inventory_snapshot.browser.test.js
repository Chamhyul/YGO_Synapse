'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/script.js', 'utf8');
const cls = source.slice(source.indexOf('class ClientCache {'), source.indexOf('\nconst cardCacheInstance'));
const begin = source.indexOf('function applyUserData('), tail = source.slice(begin), apply = tail.slice(0, tail.slice(1).search(/\n(?:async )?function /) + 1);
test('Chromium 전체 응답은 실제 캐시·CID/위치 인덱스·집계를 한 번 구성한 뒤 동일한 보유 화면을 만든다', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<!doctype html><div id="amount"></div><div id="location"></div><div id="owned"></div><script>
    const normalizeStr=x=>String(x).replace(/\\s+/g,'').toLowerCase(),getChosung=x=>x;let lookups=0,searches=0;
    function refreshLocalLookups(){lookups++;}function scheduleInventoryMigration(){}function loadUserSettings(){}function updateRarityInputs(){}
    ${cls}
    const cardCacheInstance=new ClientCache();let indexes=0,summaries=0;
    const index=cardCacheInstance.refreshIndexes.bind(cardCacheInstance),summary=cardCacheInstance.rebuildSummaryFromInventory.bind(cardCacheInstance);
    cardCacheInstance.refreshIndexes=()=>{indexes++;return index();};cardCacheInstance.rebuildSummaryFromInventory=()=>{summaries++;return summary();};
    function updateTotals(){document.getElementById('amount').textContent=cardCacheInstance.getAmount();document.getElementById('location').textContent=cardCacheInstance.getAllLocations().join(',');}
    function refreshCurrentSearchResult(){searches++;document.getElementById('owned').textContent=cardCacheInstance.getOwnedNumbers().join(',');}
    ${apply}
    window.receive=value=>applyUserData(value);window.inspect=()=>({indexes,summaries,lookups,searches,revision:cardCacheInstance._inventoryRevision,rows:cardCacheInstance.getInventory()});
    </script>`);
    const response = { success: true, amount: 5, locations: { 상자: ['A', 'B'] }, rarities: { N: 5 },
      allCards: [['한글 카드', 'A', 'N', 2, '상자', '1', '100'], ['다른 카드', 'B', 'N', 3, '상자', '2', '200']] };
    await page.evaluate(value => receive(value), response);
    assert.equal(await page.locator('#amount').textContent(), '5'); assert.equal(await page.locator('#location').textContent(), '상자');
    assert.equal(await page.locator('#owned').textContent(), 'A,B');
    const first = await page.evaluate(() => inspect());
    assert.deepEqual([first.indexes, first.summaries, first.lookups, first.searches, first.revision], [1, 1, 1, 1, 1]);
    assert.deepEqual(first.rows, response.allCards);
    await page.evaluate(() => receive({ success: true, inventorySync: { status: 'unchanged' } }));
    const same = await page.evaluate(() => inspect()); assert.equal(same.indexes, 1); assert.equal(same.summaries, 1);
    await page.evaluate(() => receive({ success: true, amount: 0, locations: {}, rarities: {}, allCards: [] }));
    assert.equal(await page.locator('#amount').textContent(), '0'); assert.equal(await page.locator('#owned').textContent(), '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
