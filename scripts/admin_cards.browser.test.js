'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {fulfillTestWebAsset} = require('../docker/offline-web-assets.cjs');
const origin = 'http://127.0.0.1:5019';
const endpoint = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net/getPublicCardData';
const sample = cid => ({cid, data:{names:['합성 검증 카드'], numbers:['TEST-001'], info:{card_type:'Monster', atk:0, properties:['Effect'], unknown:{retain:true}, ko:{name:'합성 검증 카드', text:'합성 텍스트', packs:{'TEST-001':['합성 팩']}, ciid:[1]}, en:{name:'Synthetic test card', text:'Synthetic text'}}}});
const html = fs.readFileSync('functions/templates/admin/cards.html', 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => /src="\/admin-cards\.js/.test(script) ? script : '')
    .replace(/(<div id="admin-content"[^>]*?) hidden>/, '$1>')
    .replace('id="admin-login" class="admin-login"', 'id="admin-login" class="admin-login" hidden')
    .replace('</head>', `<script>const check={activate(){},getToken:async()=>({token:'synthetic-app-check'})};const appCheck=()=>check;appCheck.ReCaptchaEnterpriseProvider=class{};window.firebase={appCheck};</script></head>`);
async function fixture(page, {failure=false, delayed=false, hidden=false, signedOut=false} = {}) {
    const calls = [], errors = [];
    let release;
    const pending = new Promise(resolve => release = resolve);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        if (await fulfillTestWebAsset(route)) return;
        const url = new URL(route.request().url());
        if (url.href === endpoint) {
            const headers = {'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Methods':'POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,X-Firebase-AppCheck'};
            if (route.request().method() === 'OPTIONS') return route.fulfill({status:204, headers});
            assert.equal(route.request().method(), 'POST');
            assert.equal(route.request().headers()['x-firebase-appcheck'], 'synthetic-app-check');
            calls.push(route.request().postDataJSON());
            if (delayed) await pending;
            return route.fulfill({status:failure ? 403 : 200, headers, json:failure ? {success:false} : {success:true, cards:[sample('100'),sample('200')]}}).catch(() => {});
        }
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/admin/cards') return route.fulfill({contentType:'text/html', body:signedOut ? html.replace(/<div id="admin-content"[\s\S]*<\/body>/,'</body>') : hidden ? html.replace('data-admin-title="카드 데이터 편집">','data-admin-title="카드 데이터 편집" hidden>') : html});
        if (!/^\/(styles\/|admin-cards\.js)/.test(url.pathname)) return route.fulfill({status:404});
        const file = path.join(process.cwd(), 'public', url.pathname);
        return route.fulfill({contentType:file.endsWith('.css') ? 'text/css' : 'text/javascript', body:fs.readFileSync(file)});
    });
    await page.goto(origin + '/admin/cards');
    if (!signedOut) await page.waitForFunction(() => document.getElementById('cards-locale').options.length === 10);
    return {calls, errors, release};
}
async function search(page) {
    await page.locator('#cards-query').fill('100');
    await page.getByRole('button', {name:'검색',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('cards-count').textContent === '2개');
    await page.locator('#cards-results button').first().click();
}
test('정확 조회·공통/언어 편집·변경 비교·취소·모바일 화면을 검증한다', async () => {
    const browser = await chromium.launch({headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1440,height:1100}});
        const f = await fixture(page);
        assert.equal(f.calls.length,0);
        await search(page);
        assert.deepEqual(f.calls,[{cids:['100']}]);
        assert.equal(await page.getByRole('button',{name:'운영 저장',exact:true}).isDisabled(),true);
        await page.locator('[data-field="atk"]').fill('?');
        await page.locator('[data-field="text"]').fill('<script>합성 변경</script>');
        await page.locator('#cards-locale').selectOption('en');
        await page.locator('[data-field="name"]').fill('Changed synthetic name');
        await page.locator('#cards-locale').selectOption('ko');
        assert.equal(await page.locator('[data-field="text"]').inputValue(),'<script>합성 변경</script>');
        assert.equal(await page.locator('#cards-change-count').textContent(),'3개');
        assert.equal(await page.locator('#cards-changes script').count(),0);
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#cards-results button').last().click();
        assert.match(await page.locator('#cards-identity').textContent(),/^CID 100/);
        const dir = process.env.TEST_ARTIFACT_DIR || '/tmp/admin-cards'; fs.mkdirSync(dir,{recursive:true});
        await page.evaluate(() => {document.activeElement.blur(); window.scrollTo(0,0);});
        await page.screenshot({path:path.join(dir,'카드편집_데스크톱.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(() => document.documentElement.classList.add('is-mobile-device','dark-mode'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
        await page.screenshot({path:path.join(dir,'카드편집_모바일다크.png'),fullPage:true});
        page.once('dialog', dialog => dialog.accept()); await page.locator('#cards-reset').click();
        assert.equal(await page.locator('[data-field="atk"]').inputValue(),'0');
        assert.equal(await page.locator('#cards-change-count').textContent(),'0개');
        await page.locator('#cards-kind').selectOption('names'); await page.locator('#cards-query').fill('정확한 이름');
        await page.getByRole('button',{name:'검색',exact:true}).click();
        await page.waitForFunction(() => document.getElementById('cards-count').textContent === '2개');
        assert.deepEqual(f.calls[1],{field:'names',value:'정확한 이름'});
        assert.equal(f.calls.length,2); assert.deepEqual(f.errors,[]);
    } finally {await browser.close();}
});
test('인증 실패를 안내하고 관리자 화면 숨김 시 지연 결과와 편집 정보를 폐기한다', async () => {
    const browser = await chromium.launch({headless:true});
    try {
        const page = await browser.newPage(); const f = await fixture(page,{failure:true});
        await page.locator('#cards-query').fill('100'); await page.getByRole('button',{name:'검색',exact:true}).click();
        await page.waitForFunction(() => document.getElementById('cards-status').textContent.includes('App Check 인증'));
        assert.equal(await page.locator('#cards-results button').count(),0); assert.deepEqual(f.errors,[]);
        const second = await browser.newPage(); const delayed = await fixture(second,{delayed:true});
        await second.locator('#cards-query').fill('100'); await second.getByRole('button',{name:'검색',exact:true}).click();
        await second.waitForFunction(() => document.getElementById('cards-results').getAttribute('aria-busy') === 'true');
        await second.evaluate(() => document.getElementById('admin-content').hidden = true); delayed.release();
        await second.waitForFunction(() => document.getElementById('cards-query').value === '');
        assert.equal(await second.locator('#cards-results button').count(),0);
        assert.equal(await second.locator('#cards-editor').isVisible(),false); assert.deepEqual(delayed.errors,[]);
        const third = await browser.newPage(); const hidden = await fixture(third,{hidden:true});
        assert.equal(hidden.calls.length,0); assert.equal(await third.locator('#cards-search-fields').evaluate(node => node.disabled),true);
        const fourth = await browser.newPage(); const signedOut = await fixture(fourth,{signedOut:true});
        assert.equal(signedOut.calls.length,0); assert.deepEqual(signedOut.errors,[]);
    } finally {await browser.close();}
});
