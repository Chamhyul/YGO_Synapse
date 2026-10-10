// 실제 Tiptap 엔진을 사용하되 모든 API는 합성 데이터로 격리한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { sanitizeNoticeHtml } = require('../functions/services/noticeContent');
const origin = 'http://127.0.0.1:5019';
const fixture = fs.readFileSync('functions/templates/admin/notices.html','utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => /src="\/(?:vendor\/notice-editor|admin-notices)\.js/.test(script) ? script : '')
    .replace('id="admin-content" data-admin-title="공지 편집" hidden','id="admin-content" data-admin-title="공지 편집"')
    .replace('id="admin-login" class="admin-login"','id="admin-login" class="admin-login" hidden')
    .replace('</body>','<script>window.confirm=()=>true;</script></body>');

test('서식·링크·실행 취소·기존 공지·표시 확인·저장·모바일을 실제 편집 엔진으로 확인', async () => {
    const browser = await chromium.launch({headless:true,...(process.env.NOTICE_TEST_CHROME ? {channel:'chrome'} : {})});
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    const errors=[], calls=[];
    let notices=[{id:'2026.10.08T12:00',date:'2026.10.08',title:'합성 공지',content:'<h2>편집 예시</h2><p><strong>굵은 글자</strong>와 <u>밑줄</u></p><ul><li><p>첫 항목</p></li></ul>',isPinned:0}];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(['fonts.googleapis.com','fonts.gstatic.com','cdn.jsdelivr.net'].includes(url.hostname))return route.continue();
        if(url.origin!==origin)return route.abort();
        if(url.pathname.startsWith('/admin/api/notices')) {
            const body=route.request().postDataJSON();calls.push({path:url.pathname,body});
            let data;
            if(url.pathname.endsWith('/preview'))data={success:true,title:body.title,content:sanitizeNoticeHtml(body.content)};
            else if(body){notices=[{...notices[0],title:body.title,content:sanitizeNoticeHtml(body.content),isPinned:body.isPinned}];data={success:true,notice:notices[0]};}
            else data={success:true,revision:'1',environment:'local',notices};
            return route.fulfill({json:data});
        }
        if(url.pathname==='/admin/notices')return route.fulfill({contentType:'text/html',body:fixture});
        if(!/^\/(styles\/|vendor\/|admin-notices\.js)/.test(url.pathname))return route.fulfill({status:404});
        const file=path.join(process.cwd(),'public',url.pathname);
        return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
    });
    try {
        await page.goto(origin+'/admin/notices');
        await page.waitForFunction(()=>!document.getElementById('notice-fields').disabled);
        assert.deepEqual(errors,[]);
        await page.evaluate(()=>document.fonts.ready);
        await page.getByRole('button',{name:/합성 공지/}).click();
        assert.equal(await page.locator('.tiptap strong').textContent(),'굵은 글자');
        assert.equal(await page.locator('.tiptap ul li').count(),1);
        await page.getByRole('button',{name:'새 공지',exact:true}).click();
        assert.equal(await page.locator('[data-command="undo"]').isDisabled(),true);
        await page.locator('#notice-title').fill('합성 편집 검증');
        await page.locator('.tiptap').fill('한글 서식 편집');
        await page.locator('.tiptap').press('ControlOrMeta+A');
        await page.locator('[data-command="bold"]').click();
        assert.equal(await page.locator('.tiptap strong').textContent(),'한글 서식 편집');
        await page.locator('.notice-more summary').click();
        await page.locator('[data-command="undo"]').click();
        await page.locator('.notice-more summary').click();
        await page.locator('[data-command="redo"]').click();
        assert.equal(await page.locator('.tiptap strong').textContent(),'한글 서식 편집');
        await page.locator('[data-command="link"]').click();
        await page.locator('#notice-link-url').fill('javascript:alert(1)');
        await page.getByRole('button',{name:'적용',exact:true}).click();
        assert.equal(await page.locator('#notice-link-dialog').evaluate(el=>el.open),true);
        await page.locator('#notice-link-url').fill('https://example.com/notice');
        await page.getByRole('button',{name:'적용',exact:true}).click();
        assert.equal(await page.locator('.tiptap a').getAttribute('href'),'https://example.com/notice');
        await page.locator('#notice-format').selectOption('2');
        assert.equal(await page.locator('.tiptap h2').count(),1);
        await page.getByRole('button',{name:'실제 표시 확인',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('notice-preview-dialog').open);
        assert.equal(calls.filter(call=>call.body?.action).length,0);
        assert.equal(await page.locator('#notice-preview-body h2').textContent(),'한글 서식 편집');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#notice-preview-dialog').evaluate(el=>el.open),false);
        await page.waitForFunction(()=>document.getElementById('notice-preview-button')===document.activeElement);
        await page.getByRole('button',{name:'저장',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('notice-status').textContent==='로컬 테스트 공지를 저장했습니다.');
        assert.match(calls.find(call=>call.body?.action).body.content,/<h2>.*<strong>/);
        await page.locator('.notice-more summary').click();
        assert.equal(await page.locator('[data-command="undo"]').isDisabled(),true);
        await page.locator('.notice-more summary').click();
        fs.mkdirSync('private/2026.10.10/증거',{recursive:true});
        await page.screenshot({path:'private/2026.10.10/증거/공지편집기_데스크톱.png',fullPage:true});
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(()=>document.documentElement.classList.add('is-mobile-device','dark-mode'));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.locator('.notice-more summary').click();
        assert.equal(await page.locator('.notice-mobile-command[data-command="italic"]').isVisible(),true);
        await page.locator('.notice-more summary').click();
        await page.screenshot({path:'private/2026.10.10/증거/공지편집기_모바일다크.png',fullPage:true});
        await page.evaluate(()=>document.getElementById('admin-content').hidden=true);
        await page.waitForFunction(()=>document.querySelector('.tiptap').getAttribute('contenteditable')==='false');
        assert.deepEqual(errors,[]);
    } finally {await browser.close();}
});
