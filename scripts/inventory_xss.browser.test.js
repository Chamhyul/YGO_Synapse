'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), { chromium } = require('playwright');
const source = fs.readFileSync(process.env.YGO_SECURITY_SCRIPT || 'public/script.js', 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm')); assert(start >= 0, name);
  const rest = source.slice(start), end = rest.slice(1).search(/\n(?:async )?function /); return end < 0 ? rest : rest.slice(0, end + 1);
}
const inputs = ['<img src="x" onerror="window.__securitySignal++">', '\"><svg onload="window.__securitySignal++">',
  "' autofocus onfocus='window.__securitySignal++", '보관함 A & B <한정판> "큰칸"', '&lt;literal&gt;'];
test('가져오기/저장 문자열은 통계·자동완성·모바일 카드에서 실행되지 않고 원문·입력값을 보존한다', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const value of inputs) {
      const page = await browser.newPage(); await page.route('**/*', route => route.abort());
      await page.setContent('<datalist id="loc-datalist"></datalist><div id="inv-location-stats"></div><div id="inv-rarity-stats"></div><div id="cards"></div>');
      const result = await page.evaluate(({ code, value }) => {
        window.__securitySignal = 0; window.UserStore = { user: { uid: 'synthetic-security-user' }, inventorySyncStatus: 'ready' }; window.UIStore = { mode: 'move' };
        window.IllustrationImages = { label: () => value }; window.getLocalizedRarity = v => v; window.compareRarity = () => 0;
        window.cardCacheInstance = { getAllLocations: () => [value], getAmount: () => 1, getOwnedNumbers: () => ['TEST'],
          getLocationsMap: () => ({ [value]: ['TEST'] }), getRaritiesMap: () => ({ [value]: 1 }) };
        window.eval(code); refreshLocalLookups(); updateDashboardStats();
        const data = { name: value, cardNo: value, rarity: value, loc: value, to: value, illustration: value, qty: 1 };
        document.getElementById('cards').innerHTML = getMobileCardHtml(0, 1, data);
        return { option: document.querySelector('option').value, location: document.querySelector('#inv-location-stats .stat-name').textContent,
          rarity: document.querySelector('#inv-rarity-stats .stat-name').textContent, name: document.querySelector('.card-title-text').textContent,
          fields: ['name', 'no', 'illust', 'rare', 'loc', 'to'].map(key => document.querySelector(`[data-field="${key}"]`).value),
          unexpectedElements: document.querySelectorAll('img, svg, script').length };
      }, { value, code: ['escapeHTML', 'refreshLocalLookups', 'updateDashboardStats', 'getMobileCardHtml'].map(functionSource).join('\n') });
      await page.waitForTimeout(30); assert.equal(await page.evaluate(() => window.__securitySignal), 0);
      assert.equal(result.unexpectedElements, 0); assert.equal(result.option, value); assert.equal(result.location, value);
      assert.equal(result.rarity, value); assert.equal(result.name, value); assert.deepEqual(result.fields, Array(6).fill(value));
      await page.close();
    }
  } finally { await browser.close(); }
});
