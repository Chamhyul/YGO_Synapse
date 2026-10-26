// 실제 script.js와 브라우저 fetch로 로컬 포트 선택을 검사한다. 인증·API 응답은 합성이다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const yaml = require('../functions/node_modules/js-yaml');
const root = path.resolve(__dirname, '..');
const compose = yaml.load(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'));
function exposedPort(internal) {
    const bindings = compose.services.dev.ports.map(value => String(value).split(':'));
    const binding = bindings.find(parts => parts.at(-1) === String(internal));
    assert.ok(binding, `Docker의 ${internal} 포트 연결이 필요합니다.`);
    return Number(binding.at(-2));
}
const emulatorConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).emulators;
const hostingPort = exposedPort(emulatorConfig.hosting.port);
const functionsPort = exposedPort(emulatorConfig.functions.port);
// 관리 화면이 알리는 포트도 호스트에서 그대로 접근할 수 있어야 한다.
for (const name of ['hosting', 'functions', 'firestore', 'storage', 'ui']) {
    assert.equal(exposedPort(emulatorConfig[name].port), emulatorConfig[name].port);
}
assert.equal(exposedPort(9150), 9150);
const requests = [];
function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
    });
}
function api(port) {
    return http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Firebase-AppCheck');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const url = new URL(req.url, `http://127.0.0.1:${port}`);
            requests.push({ port, method: req.method, pathname: url.pathname,
                body: body ? JSON.parse(body) : null, authorization: req.headers.authorization,
                appCheck: req.headers['x-firebase-appcheck'] });
            res.setHeader('Content-Type', 'application/json');
            if (url.searchParams.has('unavailable')) {
                res.writeHead(503); res.end(JSON.stringify({ success: false, message: '합성 조회 장애' })); return;
            }
            res.end(JSON.stringify({ success: true, port }));
        });
    });
}
function hosting() {
    return http.createServer((req, res) => {
        const file = new URL(req.url, 'http://fixture').pathname;
        if (file === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<link\b[^>]*>/gi, '');
            res.end(html.replace('</body>', '<button id="request" style="position:fixed;top:0;left:0;z-index:999999">요청</button></body>'));
        } else if (['/script.js', '/auth-session.js'].includes(file)) {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.end(fs.readFileSync(path.join(root, 'public', file)));
        } else { res.writeHead(404); res.end(); }
    });
}
async function fixture(browser, origin) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname)
            && [hostingPort, functionsPort, 5005, 5001, 5105, 5101].includes(Number(url.port))
            ? route.continue() : route.abort();
    });
    await page.goto(origin);
    // DOM 초기화와 실계정 SDK는 이 검사 범위 밖이다. 준비된 문서에 제품 스크립트 전체를 로드한다.
    await page.addScriptTag({ url: origin + '/auth-session.js' });
    await page.addScriptTag({ url: origin + '/script.js' });
    assert.deepEqual(errors, [], '제품 스크립트 로드 오류');
    await page.evaluate(() => {
        const user = { getIdToken: async () => 'synthetic-user-token' };
        window.firebase = { auth: () => ({ currentUser: user }),
            appCheck: () => ({ getToken: async () => ({ token: 'synthetic-app-token' }) }) };
        UserStore.user = user;
        UserStore.inventorySyncStatus = 'ready';
        UserStore.isUserDataSyncDone = true;
        document.getElementById('request').onclick = async () => {
            window.requestResult = null;
            try { window.requestResult = await requestApi(window.action, window.params || {}, window.payload || null); }
            catch (error) { window.requestResult = { error: true, status: error.status }; }
        };
    });
    return { context, page, errors };
}
async function clickRequest(page, action, payload = null, params = {}) {
    await page.evaluate(input => Object.assign(window, input), { action, payload, params, requestResult: null });
    await page.locator('#request').click();
    await page.waitForFunction(() => window.requestResult !== null);
    return page.evaluate(() => window.requestResult);
}
test('브라우저는 기본 Docker 및 분리 개발 주소에 대응하는 서버로 요청한다', async t => {
    const servers = [];
    let browser;
    try {
        for (const port of new Set([functionsPort, 5001, 5101])) servers.push(await listen(api(port), port));
        for (const port of new Set([hostingPort, 5005, 5105])) servers.push(await listen(hosting(), port));
        browser = await chromium.launch({ headless: true });
        for (const [host, port, expected] of [
            ['127.0.0.1', hostingPort, functionsPort], ['localhost', hostingPort, functionsPort],
            ['127.0.0.1', 5105, 5101], ['localhost', 5105, 5101],
        ]) await t.test(`${host}:${port} → ${expected}`, async () => {
            const start = requests.length;
            const { context, page, errors } = await fixture(browser, `http://${host}:${port}`);
            try {
                assert.equal((await clickRequest(page, 'getRegistrationStatus')).port, expected);
                assert.equal((await clickRequest(page, 'addCards', { cards: [{ cid: '42' }] })).port, expected);
                const observed = requests.slice(start);
                assert.deepEqual(observed.map(req => [req.port, req.method, req.pathname]), [
                    [expected, 'GET', '/ygo-synapse/asia-northeast3/getRegistrationStatus'],
                    [expected, 'POST', '/ygo-synapse/asia-northeast3/addCards'],
                ]);
                assert.deepEqual(observed[1].body.cards, [{ cid: '42' }]);
                assert.ok(observed.every(req => req.authorization === 'Bearer synthetic-user-token'
                    && req.appCheck === 'synthetic-app-token'));
                const failed = await clickRequest(page, 'addCards', { cards: [] }, { unavailable: true });
                assert.deepEqual(failed, { error: true, status: 503 });
                assert.ok(requests.slice(start).every(req => req.port === expected));
                assert.equal(await page.evaluate(() => FIREBASE_CONFIG.ENDPOINTS.searchCard),
                    'https://asia-northeast3-ygo-synapse.cloudfunctions.net/searchCard');
                assert.deepEqual(errors, []);
            } finally { await context.close(); }
        });
    } finally {
        if (browser) await browser.close();
        await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    }
});
