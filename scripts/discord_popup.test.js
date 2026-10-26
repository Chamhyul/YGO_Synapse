'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync('public/discord-popup.js', 'utf8');
const main = fs.readFileSync('public/script.js', 'utf8');
const rootRouter = fs.readFileSync('public/index.html', 'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const state = 'a'.repeat(64), origin = 'https://synthetic.invalid';
const url = () => 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ state, redirect_uri: origin + '/' });
function fixture({ mobile = false, blocked = false, marker, search = '', hash = '', path = '/', opener = true } = {}) {
    let now = 1000, tick, opened = 0, cleared = 0;
    const listeners = new Map(), storage = new Map(), childStorage = new Map(), cleaned = [], messages = [], navigations = [], openedUrls = [];
    if (marker) storage.set('ygo_discord_popup_callback', JSON.stringify(marker));
    const mainElement = { hidden: true };
    const status = { textContent: '', closest: () => mainElement };
    const popup = { closed: false, close() { this.closed = true; }, sessionStorage: { setItem: (k, v) => childStorage.set(k, v) }, location: { replace: value => navigations.push(value) } };
    const root = { location: { pathname: path, origin, search, hash }, navigator: { userAgent: mobile ? 'iPhone' : 'Desktop' },
        sessionStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k) },
        history: { replaceState: (_, __, value) => cleaned.push(value) },
        opener: opener ? { closed: false, postMessage: (...args) => messages.push(args) } : null,
        document: { readyState: 'complete', getElementById: () => status },
        open: value => { opened++; openedUrls.push(value); return blocked ? null : popup; },
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
        setInterval: fn => { tick = fn; return 1; }, clearInterval: () => cleared++ };
    root.location.replace = value => navigations.push(value);
    const env = { window: root, location: root.location, history: root.history, sessionStorage: root.sessionStorage, URL, URLSearchParams, Date: { now: () => now }, Promise, Error };
    if (path === '/') vm.runInNewContext(rootRouter, env);
    vm.runInNewContext(source, env);
    const send = changes => listeners.get('message')?.({ origin, source: popup, data: { type: 'ygo.discord.oauth.result', version: 1, state, code: 'synthetic-code' }, ...changes });
    return { root, popup, listeners, storage, childStorage, messages, navigations, cleaned, status, mainElement, openedUrls, send,
        advance(ms) { now += ms; tick?.(); }, opened: () => opened, cleared: () => cleared };
}
test('데스크톱 클릭은 즉시 작은 창을 만들고 모바일/차단은 기존 리다이렉트 선택을 반환한다', () => {
    const f = fixture(), popup = f.root.YgoDiscordPopup.open(); assert(popup); assert.equal(f.opened(), 1); assert.equal(f.openedUrls[0], origin + '/discord-popup.html?preparing=1'); popup.cancel();
    for (const opts of [{ mobile: true }, { blocked: true }]) { const f = fixture(opts); assert.equal(f.root.YgoDiscordPopup.open(), null); }
});
test('정확한 origin·source창·state·버전만 수락하고 일회 결과 뒤 리스너/타이머/창을 정리한다', async () => {
    const f = fixture(), p = f.root.YgoDiscordPopup.open(); p.authorize({ authorizationUrl: url(), state, deadline: 10000 });
    let done = false; p.result.then(() => { done = true; });
    for (const changes of [{ origin: 'https://evil.invalid' }, { source: {} }, { data: { type: 'ygo.discord.oauth.result', version: 1, state: 'b'.repeat(64), code: 'synthetic' } },
        { data: { type: 'ygo.discord.oauth.result', version: 2, state, code: 'synthetic' } }, { data: { type: 'ygo.discord.oauth.result', version: 1, state, code: '', error: 'failed' } }]) {
        f.send(changes); await Promise.resolve(); assert(!done); assert(!f.popup.closed);
    }
    f.send(); const result = await p.result; assert.equal(result.code, 'synthetic-code'); assert(f.popup.closed); assert.equal(f.listeners.size, 0); assert.equal(f.cleared(), 1);
});
test('팝업 표식은 자식 저장소에만 남고 URL·state 변조는 이동 전에 거부한다', () => {
    for (const authorizationUrl of ['https://evil.invalid/', url() + '&state=bad', url().replace(encodeURIComponent(origin + '/'), encodeURIComponent('https://evil.invalid/'))]) {
        const f = fixture(), p = f.root.YgoDiscordPopup.open(); assert.throws(() => p.authorize({ authorizationUrl, state, deadline: 10000 })); assert.equal(f.navigations.length, 0); p.cancel();
    }
    const f = fixture(), p = f.root.YgoDiscordPopup.open(); assert(p.authorize({ authorizationUrl: url(), state, deadline: 10000 })); assert.equal(f.storage.size, 0); assert.equal(f.childStorage.size, 1); p.cancel();
});
test('자식 저장소 접근 불가는 기존 리다이렉트로 대체할 수 있게 창을 정리한다', async () => {
    const f = fixture(), p = f.root.YgoDiscordPopup.open(); f.popup.sessionStorage.setItem = () => { throw Error('synthetic'); };
    assert.equal(p.authorize({ authorizationUrl: url(), state, deadline: 10000 }), false); await assert.rejects(p.result, e => e.code === 'DISCORD_POPUP_FAILED'); assert(f.popup.closed);
});
test('창 닫기·기한 만료·계정 변경 취소는 결과를 승인하지 않는다', async () => {
    for (const mode of ['close', 'expire', 'account']) {
        const f = fixture(), p = f.root.YgoDiscordPopup.open(); p.authorize({ authorizationUrl: url(), state, deadline: 10000 });
        if (mode === 'close') { f.popup.closed = true; f.advance(1); }
        else if (mode === 'expire') f.advance(10000); else f.root.YgoDiscordPopup.cancelActive();
        await assert.rejects(p.result, e => /^DISCORD_POPUP_/.test(e.code)); assert.equal(f.listeners.size, 0);
    }
});
test('인증 시작 준비 중 팝업 닫기는 전체 페이지 자동 이동으로 바뀌지 않는다', async () => {
    const f = fixture(), p = f.root.YgoDiscordPopup.open(); f.popup.closed = true; f.advance(1);
    await assert.rejects(p.result); assert.throws(() => p.authorize({ authorizationUrl: url(), state, deadline: 10000 }), e => e.code === 'DISCORD_POPUP_CANCELLED'); assert.equal(f.navigations.length, 0);
});
test('동의 취소는 취소 결과로 정리하고 메시지의 code/error 혼합을 받지 않는다', async () => {
    const f = fixture(), p = f.root.YgoDiscordPopup.open(); p.authorize({ authorizationUrl: url(), state, deadline: 10000 });
    f.send({ data: { type: 'ygo.discord.oauth.result', version: 1, state, error: 'cancelled' } });
    await assert.rejects(p.result, e => e.code === 'DISCORD_POPUP_CANCELLED');
});
test('root의 표식이 일치하는 복귀만 코드 주소를 지우고 작은 전달 문서로 보낸다', () => {
    const marker = { version: 1, state, expiresAt: 10000 };
    const f = fixture({ marker, search: '?code=synthetic-code&state=' + state + '&iss=ignored' });
    assert.equal(f.root.YgoDiscordPopup.isCallback, true); assert.deepEqual(f.cleaned, ['/']); assert(f.navigations[0].startsWith('/discord-popup.html#')); assert(!f.navigations[0].includes('iss='));
    for (const opts of [{ search: '?code=synthetic-code&state=' + state }, { marker, search: '?code=synthetic-code&state=bad' }, { marker, search: '?code=x&state=' + state + '&state=bad' }]) {
        const f = fixture(opts); assert.equal(f.root.YgoDiscordPopup.isCallback, false); assert.equal(f.navigations.length, 0);
    }
});
test('전달 문서는 코드를 저장/노출하지 않고 고정 origin의 부모에게만 전송한다', () => {
    const f = fixture({ path: '/discord-popup.html', marker: { version: 1, state, expiresAt: 10000 }, hash: '#code=synthetic-code&state=' + state });
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0][1], origin); assert.equal(f.messages[0][0].code, 'synthetic-code'); assert.deepEqual(f.cleaned, ['/discord-popup.html']); assert.equal(f.storage.size, 0); assert(!f.status.textContent.includes('synthetic-code'));
});
test('부모 연결 분리/만료/중복 코드/위조 state는 복귀 문서에서도 전송하지 않는다', () => {
    for (const extra of [{ opener: false }, { marker: { version: 1, state, expiresAt: 500 } }, { hash: '#code=x&code=y&state=' + state }, { hash: '#code=x&state=bad' }]) {
        const f = fixture({ path: '/discord-popup.html', marker: { version: 1, state, expiresAt: 10000 }, hash: '#code=synthetic&state=' + state, ...extra });
        assert.equal(f.messages.length, 0); assert(f.status.textContent.includes('다시 시도')); assert.equal(f.mainElement.hidden, false); assert.equal(f.storage.size, 0);
    }
});
test('팝업 root 복귀에서는 Auth/App Check와 일반 앱 초기화가 실행되지 않는다', async () => {
    let calls = 0; const root = { YgoDiscordPopup: { isCallback: true } };
    vm.runInNewContext(fs.readFileSync('public/auth-bootstrap.js', 'utf8'), { window: root, firebase: { auth() { calls++; }, appCheck() { calls++; } } });
    const a = main.indexOf('async function initApp()'), b = main.indexOf('// 애플리케이션 단일 초기화', a);
    const ctx = { window: root, initFirebaseAuth: () => calls++ }; vm.createContext(ctx); vm.runInContext(main.slice(a, b), ctx); await ctx.initApp(); assert.equal(calls, 0);
    const html = fs.readFileSync('public/index.html', 'utf8'); assert(html.indexOf('ygo_discord_popup_callback') < html.indexOf('googletagmanager')); assert(html.indexOf('ygo_discord_popup_callback') < html.indexOf('firebase-app-compat'));
    assert.match(html, /src="discord-popup\.js\?v=4" defer/);
});
test('시작 대기 화면은 문구 없이 기다리고 일회 표식을 먼저 지우지 않는다', () => {
    const f = fixture({ path: '/discord-popup.html', search: '?preparing=1', marker: { version: 1, state, expiresAt: 10000 } });
    assert.equal(f.status.textContent, ''); assert.equal(f.mainElement.hidden, true); assert.equal(f.storage.size, 1); assert.equal(f.messages.length, 0);
});

function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function mainFixture(inventoryStatus = 'ready') {
    const received = gate(), sync = gate(), events = [], calls = [], user = { uid: 'synthetic' };
    const popup = { result: received.promise, authorize: () => { events.push('navigate-popup'); return true; }, cancel: () => events.push('close') };
    const location = { origin, href: origin + '/#settings' };
    const ctx = { window: { location }, location, URL, URLSearchParams, Date, performance: { now: () => 0 }, authStateRevision: 1, registrationCheckPending: false,
        UserStore: { user, settings: {}, inventorySyncStatus: inventoryStatus }, firebase: { auth: () => ({ currentUser: ctx.authUser }) }, authUser: user,
        YgoDiscordPopup: { open: () => { events.push('open'); return popup; } }, requireInventoryReady: () => true,
        beginMembershipPreparation: () => {}, sessionStorage: { setItem() { throw Error('parent storage should not be used'); }, getItem: () => null, removeItem() {} },
        document: { getElementById: () => null }, showToast: msg => events.push('error:' + msg),
        applyMembershipStatus: () => events.push('applied'), refreshMembershipClaims: async () => true, followMembershipClaims() {}, setInventorySyncStatus(status) { ctx.UserStore.inventorySyncStatus = status; },
        loadUserData: async (_, options) => { assert.equal(options.membershipClaimsReadOnly, true); events.push('sync'); return sync.promise; },
        callApi: async (name, params, body) => { calls.push({ name, params, body }); return name === 'startDiscordMembershipVerification'
            ? { success: true, uid: user.uid, verificationId: state, authorizationUrl: url() }
            : { success: true, uid: user.uid, membership: { status: 'active' }, membershipClaims: { status: 'synced' } }; } };
    vm.createContext(ctx); vm.runInContext(main.slice(main.indexOf('let discordMembershipStarting = false;'), main.indexOf('/**\n * 멤버십 인증 메시지', main.indexOf('let discordMembershipStarting = false;'))), ctx);
    ctx.setDiscordMembershipHeader = phase => events.push(phase);
    return { ctx, events, calls, received, sync, popup };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
test('팝업 부모는 서버 검증 결과를 먼저 표시하고 재로그인 없이 필요한 전체 동기화를 이어간다', async () => {
    const f = mainFixture('error'), work = f.ctx.startDiscordMembershipVerify(); assert.equal(f.events[1], 'open'); await flush(); assert(f.events.includes('navigate-popup'));
    f.received.resolve({ code: 'synthetic-code', state }); await flush(); assert.equal(f.calls[1].name, 'verifyDiscordMembership'); assert.equal(f.calls[1].params.discordFlow, 'popup');
    assert(f.events.includes('sync')); assert(f.events.includes('complete')); assert(f.events.includes('applied'));
    assert(f.events.indexOf('applied') < f.events.indexOf('sync'));
    f.sync.resolve(true); await work; assert(f.events.includes('complete')); assert(f.events.includes('applied')); assert.equal(f.ctx.location.href, origin + '/#settings');
});
test('팝업 대기 중 계정 변경은 결과 적용을 막고 인증 뒤 동기화 실패는 별도 안내한다', async () => {
    for (const changed of [true, false]) {
        const f = mainFixture('error'), work = f.ctx.startDiscordMembershipVerify(); await flush();
        if (changed) { f.ctx.authStateRevision++; f.ctx.UserStore.user = f.ctx.authUser = { uid: 'other' }; }
        f.received.resolve({ code: 'synthetic-code', state }); await flush(); f.sync.resolve(false); await work;
        if (changed) { assert(!f.events.includes('complete')); assert(!f.events.includes('applied')); assert.equal(f.calls.length, 1); }
        else { assert(f.events.includes('complete')); assert(f.events.includes('applied')); assert(f.events.some(value=>value.startsWith('error:'))); }
    }
});

test('팝업 부모는 준비된 인벤토리 재조회 없이 서버 검증과 claims를 반영한다', async () => {
 const f = mainFixture(), work = f.ctx.startDiscordMembershipVerify();await flush();
 f.received.resolve({code:'synthetic-code',state});await work;
 assert(!f.events.includes('sync'));assert(f.events.includes('complete'));assert(f.events.includes('applied'));
 assert.equal(f.ctx.UserStore.claimsSyncStatus,'ready');
});

test('팝업 claims 토큰 미확정은 pending 후속 확인으로 남기며 인벤토리와 섞지 않는다', async () => {
 const f=mainFixture();let followed=0;f.ctx.refreshMembershipClaims=async()=>false;
 f.ctx.followMembershipClaims=()=>followed++;const work=f.ctx.startDiscordMembershipVerify();await flush();
 f.received.resolve({code:'synthetic-code',state});await work;
 assert.equal(f.ctx.UserStore.claimsSyncStatus,'pending');assert.equal(followed,1);
 assert(!f.events.includes('sync'));assert(f.events.includes('complete'));
});

test('준비된 클릭은 안내 문서 없이 같은 클릭 안에서 표식을 저장하고 OAuth로 이동한다', () => {
 const f=fixture(),p=f.root.YgoDiscordPopup.open({prepared:true});assert.equal(f.openedUrls[0],'about:blank');
 f.popup.location.replace=value=>{assert.equal(f.childStorage.size,1);f.navigations.push(value);};
 p.authorize({authorizationUrl:url(),state,deadline:10000});assert.deepEqual(f.navigations,[url()]);p.cancel();
});
test('부모의 준비 완료 클릭은 추가 시작 요청이나 비동기 대기 없이 팝업 이동을 요청한다',async()=>{
 const f=mainFixture();await f.ctx.prepareDiscordMembershipStart().promise;let option;
 f.ctx.YgoDiscordPopup.open=opts=>{option=opts;return f.popup;};const work=f.ctx.startDiscordMembershipVerify();
 assert.equal(option.prepared,true);assert(f.events.includes('navigate-popup'));assert.equal(f.calls.length,1);
 f.received.resolve({code:'synthetic-code',state});await work;assert(f.events.includes('complete'));
});
