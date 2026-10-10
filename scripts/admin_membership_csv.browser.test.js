// 운영 인증·회원 데이터 없이 실제 브라우저에서 업로드 흐름을 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fulfillTestWebAsset } = require('../docker/offline-web-assets.cjs');
const browserOptions = { headless: true, ...(process.env.MEMBERSHIP_TEST_BROWSER === 'chromium' ? {} : { channel: 'chrome' }) };
const artifactDir = process.env.TEST_ARTIFACT_DIR || 'private/2026.10.10/증거';
const { membershipCsvParseMembers } = require('../functions/services/membershipCsvService');
const origin = 'http://127.0.0.1:5019';
const csv = '회원,프로필에 연결,현재 등급,가격\n합성 회원,https://www.youtube.com/channel/UC'+'a'.repeat(22)+',합성 등급,"1,000"';
const html = fs.readFileSync('functions/templates/admin/home.html','utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => /src="\/admin-membership-csv\.js/.test(script) ? script : '')
    .replace('id="admin-content" data-admin-title="홈" hidden','id="admin-content" data-admin-title="홈" data-admin-uid="synthetic-admin"')
    .replace('id="admin-login" class="admin-login"','id="admin-login" class="admin-login" hidden');
async function fixture(page, {lost=false,deny=false}={}) {
    const calls=[], errors=[];let applied=false, operationId;
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
        if(await fulfillTestWebAsset(route))return;
        const url=new URL(route.request().url());
        if(url.origin!==origin)return route.abort();
        if(url.pathname.startsWith('/admin/api/membership-csv')) {
            const body=route.request().postDataJSON();calls.push({path:url.pathname,body});
            if(deny)return route.fulfill({status:401,json:{success:false}});
            let data={count:applied?1:3,updatedAt:applied?123456:null};
            if(url.pathname.endsWith('/preview')) {
                try { membershipCsvParseMembers(body.csvText); }
                catch(error) {return route.fulfill({status:400,json:{success:false,message:error.message}});}
                data={previousCount:3,count:1,added:1,removed:3,changed:0,tiers:[{levelName:'합성 등급',count:1}],revision:'initial',fingerprint:'synthetic'};
            } else if(url.pathname.endsWith('/status')) data={status:'completed',result:{count:1,updatedAt:123456}};
            else if(body){applied=true;operationId=body.operationId;data={count:1,updatedAt:123456};if(lost)return route.fulfill({status:503,json:{success:false}});}
            return route.fulfill({json:{success:true,...data}});
        }
        if(url.pathname==='/admin')return route.fulfill({contentType:'text/html',body:html});
        if(!/^\/(styles\/|admin-membership-csv\.js)/.test(url.pathname))return route.fulfill({status:404});
        const file=path.join(process.cwd(),'public',url.pathname);
        return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
    });
    await page.goto(origin+'/admin');
    await page.waitForFunction(()=>document.getElementById('membership-csv-current').textContent.includes('현재 3명'));
    return {calls,errors,get operationId(){return operationId;}};
}
const upload=page=>page.locator('#membership-csv-file').setInputFiles({name:'합성 회원.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
test('실제 브라우저에서 선택·미리보기·취소·적용·반응형·다크·로그아웃을 확인한다',async()=>{
    const browser=await chromium.launch(browserOptions);
    try {
        const page=await browser.newPage({viewport:{width:1440,height:1100}}),f=await fixture(page);
        await upload(page);await page.getByRole('button',{name:'파일 내용 확인',exact:true}).click();
        await page.waitForFunction(()=>!document.getElementById('membership-csv-apply').disabled);
        assert.equal(f.calls.filter(call=>call.body?.operationId).length,0);
        assert.match(await page.locator('#membership-csv-changes').textContent(),/3명 → 1명/);
        fs.mkdirSync(artifactDir,{recursive:true});
        await page.locator('#membership-csv-panel').screenshot({path:path.join(artifactDir,'회원CSV_미리보기.png')});
        page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'운영 목록 교체',exact:true}).click();
        assert.equal(f.calls.filter(call=>call.body?.operationId).length,0);
        page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'운영 목록 교체',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('membership-csv-status').textContent.includes('교체했습니다'));
        assert.match(f.operationId,/^[a-f0-9]{32}$/);assert.equal(f.calls.filter(call=>call.path==='/admin/api/membership-csv'&&call.body).length,1);
        assert.match(await page.locator('#membership-csv-current').textContent(),/현재 1명/);
        fs.mkdirSync(artifactDir,{recursive:true});
        await page.locator('#membership-csv-panel').screenshot({path:path.join(artifactDir,'회원CSV_데스크톱.png')});
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(()=>document.documentElement.classList.add('is-mobile-device','dark-mode'));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.locator('#membership-csv-panel').screenshot({path:path.join(artifactDir,'회원CSV_모바일다크.png')});
        await page.evaluate(()=>document.getElementById('admin-content').hidden=true);
        await page.waitForFunction(()=>document.getElementById('membership-csv-file').disabled);
        assert.deepEqual(f.errors,[]);
    } finally {await browser.close();}
});
test('응답 유실은 중복 업로드를 차단하고 새로고침 뒤에도 같은 작업 결과를 확인한다',async()=>{
    const browser=await chromium.launch(browserOptions);
    try {
        const page=await browser.newPage(),f=await fixture(page,{lost:true});
        await upload(page);await page.getByRole('button',{name:'파일 내용 확인',exact:true}).click();
        await page.waitForFunction(()=>!document.getElementById('membership-csv-apply').disabled);
        page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'운영 목록 교체',exact:true}).click();
        await page.waitForFunction(()=>!document.getElementById('membership-csv-result').hidden&&!document.getElementById('membership-csv-result').disabled);
        assert.equal(await page.locator('#membership-csv-file').isDisabled(),true);
        await page.reload();
        await page.waitForFunction(()=>!document.getElementById('membership-csv-result').disabled);
        await page.getByRole('button',{name:'적용 결과 확인',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('membership-csv-status').textContent.includes('교체했습니다'));
        assert.equal(f.calls.filter(call=>call.path==='/admin/api/membership-csv'&&call.body).length,1);
        assert.equal(f.calls.find(call=>call.path.endsWith('/status')).body.operationId,f.operationId);
        assert.deepEqual(f.errors,[]);
    } finally {await browser.close();}
});
test('잘못된 UTF-8와 빈 CSV는 적용을 차단한다',async()=>{
    const browser=await chromium.launch(browserOptions);
    try {
        const page=await browser.newPage(),f=await fixture(page);
        await page.locator('#membership-csv-file').setInputFiles({name:'합성.csv',mimeType:'text/csv',buffer:Buffer.from([255])});
        await page.waitForFunction(()=>document.getElementById('membership-csv-status').textContent.includes('UTF-8'));
        assert.equal(await page.locator('#membership-csv-preview-button').isDisabled(),true);
        await page.locator('#membership-csv-file').setInputFiles({name:'빈.csv',mimeType:'text/csv',buffer:Buffer.from('회원,프로필에 연결,현재 등급')});
        await page.getByRole('button',{name:'파일 내용 확인',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('membership-csv-status').textContent.includes('1명 이상'));
        assert.equal(await page.locator('#membership-csv-apply').isDisabled(),true);
        assert.equal(f.calls.filter(call=>call.body?.operationId).length,0);assert.deepEqual(f.errors,[]);
    } finally {await browser.close();}
});
