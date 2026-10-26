'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('playwright');
const origin = 'http://127.0.0.1:5019';

test('실제 문서 이동·같은 출처 새 탭에서도 활동 전송 제한이 이어진다', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(), sent = [], errors = [];
    const html = `<html><head><meta charset="UTF-8"><script>
      window.syntheticTime=Number(new URL(location.href).searchParams.get('time'));
      localStorage.setItem('ygo_admin_server_session','active');
      const auth={currentUser:{uid:'synthetic-owner'},onAuthStateChanged(){}};
      window.firebase={app:()=>({options:{}}),auth:()=>auth};
      </script><script src="/admin-session.js"></script></head>
      <body><button onclick="adminSession.activity()">활동</button></body></html>`;
    await context.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/admin/session/activity') { sent.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 204 }); }
      if (path === '/admin-session.js') return route.fulfill({ contentType: 'text/javascript',
        body: '(function(Date){' + fs.readFileSync('public/admin-session.js', 'utf8') + '\n})({now:()=>window.syntheticTime});' });
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/admin/cards?time=100000');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/admin/session/activity')), page.getByRole('button', { name: '활동' }).click()]);
    await page.goto(origin + '/admin/notices?time=102000'); await page.getByRole('button', { name: '활동' }).click();
    const key = 'ygo_admin_activity_sent:synthetic-owner';
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), '100000');
    const tab = await context.newPage(); tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(origin + '/admin/settings?time=104000'); await tab.getByRole('button', { name: '활동' }).click();
    assert.equal(await tab.evaluate(key => localStorage.getItem(key), key), '100000');
    assert.equal(sent.length, 1);
    await page.goto(origin + '/admin/cards?time=110000');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/admin/session/activity')), page.getByRole('button', { name: '활동' }).click()]);
    assert.equal(sent.length, 2); assert.ok(sent.every(body => body.uid === 'synthetic-owner')); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
