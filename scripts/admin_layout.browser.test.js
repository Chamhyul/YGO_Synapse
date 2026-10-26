'use strict';
// 합성 자료로 외형만 검증한다. 인증·운영 API는 실행하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {fulfillTestWebAsset} = require('../docker/offline-web-assets.cjs');
const origin = 'http://admin-layout.test';
const pages = ['home','notices','cards','settings','server-logs','admin-logs'];
const output = process.env.TEST_ARTIFACT_DIR || '/tmp/admin-layout';
const baseline = process.env.ADMIN_LAYOUT_BASELINE === '1';
async function fixture(page, name) {
    const html = fs.readFileSync(`functions/templates/admin/${name}.html`,'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
        .replace(/(<div id="admin-content"[^>]*?) hidden>/,'$1>')
        .replace('id="admin-login" class="admin-login"','id="admin-login" class="admin-login" hidden');
    await page.route('**/*',async route => {
        if (await fulfillTestWebAsset(route)) return;
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/admin') return route.fulfill({contentType:'text/html',body:html});
        if (!url.pathname.startsWith('/styles/')) return route.fulfill({status:404});
        return route.fulfill({contentType:'text/css',body:fs.readFileSync(path.join('public',url.pathname))});
    });
    await page.goto(origin + '/admin');
    await page.evaluate(name => {
        document.querySelector('#admin-settings').hidden = false;
        document.querySelector('#admin-account').textContent = '합성 관리자 · 소유자';
        document.querySelectorAll('fieldset,input').forEach(el => el.disabled = false);
        const text = (id,value) => {const el=document.getElementById(id);if(el)el.textContent=value;};
        text('notice-environment','운영 공지를 조회하고 편집합니다.');
        text('notice-status','공지 3개를 불러왔습니다.');
        if(name==='home') {
            ['admin-traffic-activeUsers','admin-traffic-sessions','admin-traffic-screenPageViews'].forEach((key,i) => text(key,[128,194,326][i]));
            text('admin-error-count','2'); text('admin-error-groups','1');
            text('admin-traffic-status','합성 검증 자료입니다.');
            text('membership-csv-current','현재 회원 42명 · 합성 검증 자료');
            text('admin-errors-status','최근 24시간 오류 2건 · 합성 검증 자료');
            document.querySelector('#admin-traffic-chart').innerHTML='<title>합성 방문 추이</title><path class="admin-home-chart-grid" d="M30 40H680M30 100H680M30 160H680"/><polyline class="admin-home-chart-line" points="30,150 138,120 246,134 354,68 462,90 570,44 680,58"/>';
        }
        if(name==='notices') {
            document.querySelector('#notice-list').innerHTML = ['서비스 업데이트 안내','카드 데이터 갱신 안내','정기 점검 안내'].map((s,i)=>`<li><button class="ui-button ${i===0?'color-tint-theme':'color-type004'} shape-rounded003 admin-home-record-link" aria-pressed="${i===0}"><span>${i+1}</span><span><span>${s}</span><span>2026.10.18 · ${i===0?'상단 고정':'일반 공지'}</span></span></button></li>`).join('');
            document.querySelector('#notice-new').disabled=false;
            document.querySelector('#notice-title').value='서비스 업데이트 안내';
            document.querySelector('#notice-body').innerHTML='<div class="tiptap" contenteditable="true"><h2>서비스 업데이트</h2><p>더 편리한 서비스를 위해 화면을 정리했습니다.</p><ul><li>공지 목록과 편집 영역을 개선했습니다.</li><li>기존 기능은 동일하게 사용할 수 있습니다.</li></ul><p>이 내용은 외형 확인용 합성 공지입니다.</p></div>';
        }
        if(name==='settings') {
            document.querySelector('#admin-accounts-list').innerHTML=['합성 소유자','합성 운영 계정'].map((s,i)=>`<li><button class="ui-button color-type004 shape-rounded003 admin-account-row"><span>${s}</span><span>sample-${i}@example.invalid</span><span>${i===0?'소유자':'관리자'}</span></button></li>`).join('');
            text('admin-accounts-status','관리자 계정 2개 · 합성 검증 자료');
        }
        if(name==='cards') {
            document.querySelector('#cards-results').innerHTML='<li><button class="ui-button color-navi shape-rounded003 admin-cards-result" aria-pressed="true"><span>합성 검증 카드</span><small>CID 100 · TEST-001</small></button></li>';
            document.querySelector('#cards-editor').hidden=false;
            document.querySelector('#cards-common').innerHTML='<label>카드 종류<input class="ui-input--filled color-surface-000 shape-rounded003" value="Monster"></label><label>공격력<input class="ui-input--filled color-surface-000 shape-rounded003" value="2500"></label>';
            document.querySelector('#cards-localized').innerHTML='<label class="admin-cards-field--wide">카드명<input class="ui-input--filled color-surface-000 shape-rounded003" value="합성 검증 카드"></label><label class="admin-cards-field--wide">텍스트<textarea class="color-surface-000 shape-rounded003" rows="5">이 내용은 외형 확인용 합성 카드입니다.</textarea></label>';
            document.querySelector('#cards-locale').innerHTML='<option>한국어</option>';
            text('cards-select-help','');text('cards-identity','CID 100 · 합성 검증 자료');text('cards-count','1개');text('cards-dirty','변경 없음');text('cards-empty','');text('cards-status','카드 1개를 조회했습니다.');
        }
    },name);
    await page.evaluate(() => document.fonts.ready);
}
test('관리자 6개 문서의 테마·화면 폭·정렬·세그먼트·확대 글꼴을 검증한다',async()=>{
    fs.mkdirSync(output,{recursive:true});
    const browser=await chromium.launch({headless:true});
    try {
        for(const name of pages) {
            const page=await browser.newPage({viewport:{width:1440,height:1000}});
            await fixture(page,name);
            for(const theme of ['light','dark']) {
                await page.evaluate(dark=>document.documentElement.classList.toggle('dark-mode',dark),theme==='dark');
                for(const width of [1440,1024,768,390,320]) {
                    await page.setViewportSize({width,height:width<500?844:1000});
                    await page.evaluate(mobile=>document.documentElement.classList.toggle('is-mobile-device',mobile),width<500);
                    if(!baseline) {
                        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name}/${theme}/${width}: 가로 넘침`);
                        const overflowing=await page.locator('main :is(input,select,textarea,button,a), .admin-header :is(button,a), .admin-bottom-nav a').evaluateAll(nodes=>nodes.filter(el=>{
                            const rect=el.getBoundingClientRect();return rect.width && rect.height && (rect.left<-.5 || rect.right>innerWidth+.5);
                        }).map(el=>el.id || el.className));
                        assert.deepEqual(overflowing,[],`${name}/${theme}/${width}: 가려진 조작 요소`);
                        const layout=await page.evaluate(()=>{
                            const rect=el=>el.getBoundingClientRect();
                            const main=rect(document.querySelector('main')), header=rect(document.querySelector('.admin-header'));
                            return {main:main.x,header:header.x};
                        });
                        assert.ok(Math.abs(layout.main-layout.header)<1,`${name}: 헤더와 본문 외곽 정렬`);
                    }
                    if(!baseline && width===1440 && ['notices','settings','cards'].includes(name)) {
                        const tops=await page.locator(name==='notices'?'.admin-notices-layout .admin-home-section-heading h2':name==='settings'?'.admin-settings-grid .admin-home-section-heading h2':'.admin-cards-layout .admin-home-section-heading h2').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().top));
                        assert.ok(Math.max(...tops)-Math.min(...tops)<1,`${name}: 나란한 패널 제목 기준선`);
                    }
                    if(width===1440||width===390)await page.screenshot({path:path.join(output,`${name}-${theme}-${width}.png`),fullPage:true});
                }
            }
            if(!baseline) {
                for(const size of ['150%','200%']) {
                    await page.evaluate(size=>document.documentElement.style.fontSize=size,size);
                    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name}: 글꼴 ${size}`);
                    assert.deepEqual(await page.locator('main :is(input,select,textarea,button), .admin-header :is(button,a)').evaluateAll(nodes=>nodes.filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&(r.left<-.5||r.right>innerWidth+.5);}).map(el=>el.id||el.className)),[],`${name}: 글꼴 ${size} 조작 요소 경계`);
                }
                if(name==='home') {
                    await page.evaluate(()=>document.documentElement.style.fontSize='');
                    const options=page.locator('[data-trend-days]');
                    const first=await options.nth(0).boundingBox(),second=await options.nth(1).boundingBox();
                    assert.ok(first.height>=44 && Math.abs(first.width-second.width)<1 && Math.abs(first.y-second.y)<1,'기간 선택의 크기와 기준선');
                    await options.nth(1).evaluate(el=>{el.setAttribute('aria-pressed','true');el.previousElementSibling.setAttribute('aria-pressed','false');});
                    assert.equal(await page.locator('.ui-segment__indicator').evaluate(el=>getComputedStyle(el).transform),'matrix(1, 0, 0, 1, 64, 0)');
                }
            }
            await page.close();
        }
    } finally {await browser.close();}
});
