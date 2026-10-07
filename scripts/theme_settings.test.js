const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const keys = source.slice(source.indexOf('const THEME_KEY ='), source.indexOf('const REGION_KEY ='));
const themeCode = source.slice(source.indexOf('function getLocalTheme('), source.indexOf('const regionMap ='));
// GTM 등 다른 인라인 스크립트의 위치와 무관하게 초기 테마 코드만 실행한다.
const initialThemeScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(code => code.includes("localStorage.getItem('yugioh_theme_mode')")
        && code.includes('prefers-color-scheme: dark'));
assert.equal(initialThemeScripts.length, 1, 'HTML의 초기 테마 스크립트는 정확히 하나여야 한다');
const initialCode = initialThemeScripts[0];

function fixture({ stored = {}, dark = false, blocked = false } = {}) {
    const records = new Map(Object.entries(stored));
    const classes = new Set();
    const checkbox = { checked: false };
    const apiCalls = [];
    let metaColor;
    const context = vm.createContext({
        localStorage: {
            getItem(key) { if (blocked) throw new Error('blocked'); return records.get(key) ?? null; },
            setItem(key, value) { if (blocked) throw new Error('blocked'); records.set(key, value); },
        },
        window: { matchMedia: () => ({ matches: dark }) },
        document: {
            documentElement: { classList: {
                add: value => classes.add(value),
                toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
            } },
            getElementById: id => id === 'checkbox-theme' ? checkbox : null,
            write(markup) { metaColor = markup.match(/content="([^"]+)"/)[1]; },
        },
        UserStore: { user: null, settings: {} },
        IS_DETAIL_MODE_KEY: 'yugioh_modal_detail_mode',
        updateMetaThemeColor(mode) { metaColor = mode === 'dark' ? '#1e1e1e' : '#f0f0f0'; },
        callApi: async (...args) => { apiCalls.push(args); return { success: true }; },
        console,
    });
    vm.runInContext(keys + themeCode, context);
    return { context, records, checkbox, apiCalls, classes, meta: () => metaColor };
}

test('첫 HTML과 앱 초기화는 기기보다 마지막 테마를 우선하며 비로그인 기록을 건드리지 않는다', () => {
    for (const mode of ['light', 'dark']) {
        const f = fixture({ dark: mode === 'light', stored: {
            yugioh_theme_mode: mode,
            yugioh_theme_mode_guest: mode === 'dark' ? 'light' : 'dark',
        } });
        vm.runInContext(initialCode, f.context);
        assert.equal(f.classes.has('dark-mode'), mode === 'dark');
        const before = [...f.records];
        f.context.loadTheme();
        assert.equal(f.checkbox.checked, mode === 'dark');
        assert.equal(f.meta(), mode === 'dark' ? '#1e1e1e' : '#f0f0f0');
        assert.deepEqual([...f.records], before);
    }
});

test('마지막 기록 누락·잘못된 값·저장소 차단에서도 기기 테마로 초기 표시한다', () => {
    for (const dark of [false, true]) {
        for (const options of [{}, { stored: { yugioh_theme_mode: 'invalid' } }, { blocked: true }]) {
            const f = fixture({ dark, ...options });
            vm.runInContext(initialCode, f.context);
            f.context.loadTheme();
            assert.equal(f.classes.has('dark-mode'), dark);
            assert.equal(f.checkbox.checked, dark);
            f.context.loadUserTheme();
            assert.equal(f.checkbox.checked, dark);
        }
    }
});

test('계정 로컬 기록은 서버보다 우선하고 비로그인 기록과 독립적이다', () => {
    const f = fixture({ stored: {
        yugioh_theme_mode_guest: 'light',
        'yugioh_theme_mode_user:account-a': 'dark',
    } });
    f.context.UserStore.user = { uid: 'account-a' };
    f.context.loadUserTheme(undefined, true);
    f.context.loadUserSettings({ theme: 'light' });
    assert.equal(f.checkbox.checked, true);
    assert.equal(f.records.get('yugioh_theme_mode'), 'dark');
    assert.equal(f.records.get('yugioh_theme_mode_guest'), 'light');
    f.context.UserStore.user = null;
    f.context.loadUserTheme(undefined, true);
    assert.equal(f.checkbox.checked, false);
    assert.equal(f.records.get('yugioh_theme_mode_user:account-a'), 'dark');
});

test('새 계정은 초기 표시를 유지하다 서버 테마를 저장하고 이후 서버 변경을 무시한다', () => {
    const f = fixture({ stored: { yugioh_theme_mode: 'light' } });
    f.context.loadTheme();
    f.context.UserStore.user = { uid: 'new-account' };
    f.context.loadUserTheme(undefined, true);
    assert.equal(f.checkbox.checked, false);
    assert.equal(f.records.has('yugioh_theme_mode_user:new-account'), false);
    f.context.loadUserSettings({ theme: 'dark' });
    assert.equal(f.checkbox.checked, true);
    assert.equal(f.records.get('yugioh_theme_mode_user:new-account'), 'dark');
    f.context.loadUserSettings({ theme: 'light' });
    assert.equal(f.checkbox.checked, true);
});

test('서버 기록 누락·유효하지 않은 값은 기기 설정으로 확정한다', () => {
    for (const settings of [undefined, {}, { theme: 'invalid' }]) {
        const f = fixture({ dark: true, stored: { yugioh_theme_mode: 'light' } });
        f.context.UserStore.user = { uid: 'new-account' };
        f.context.loadUserTheme(settings);
        assert.equal(f.checkbox.checked, true);
        assert.equal(f.records.get('yugioh_theme_mode_user:new-account'), 'dark');
    }
});

test('스위치 변경은 현재 사용자 기록만 갱신하며 로그인 때만 서버에 저장한다', async () => {
    const f = fixture();
    f.checkbox.checked = true;
    f.context.toggleTheme();
    assert.equal(f.records.get('yugioh_theme_mode_guest'), 'dark');
    assert.equal(f.apiCalls.length, 0);
    f.context.UserStore.user = { uid: 'account-a' };
    f.checkbox.checked = false;
    f.context.toggleTheme();
    await Promise.resolve();
    assert.equal(f.records.get('yugioh_theme_mode_user:account-a'), 'light');
    assert.equal(f.records.get('yugioh_theme_mode_guest'), 'dark');
    assert.equal(f.records.get('yugioh_theme_mode'), 'light');
    assert.equal(f.apiCalls[0][0], 'updateUserSettings');
    assert.equal(f.apiCalls[0][2].settings.theme, 'light');
    // 저장보다 늦게 도착한 초기 서버 응답이 수동 선택을 덮어쓰지 않는다.
    f.context.loadUserSettings({ theme: 'dark' });
    assert.equal(f.checkbox.checked, false);
});

test('계정 변경 뒤 도착한 이전 사용자 응답은 테마와 화면을 갱신하지 않는다', async () => {
    const f = fixture();
    let resolveResponse;
    f.context.callApi = () => new Promise(resolve => { resolveResponse = resolve; });
    f.context.showLoading = () => {};
    f.context.UserStore.user = { uid: 'account-a' };
    vm.runInContext(source.slice(source.indexOf('async function loadUserData()'), source.indexOf('/**\n * 유튜브 멤버십 상태 적용')), f.context);
    const pending = f.context.loadUserData();
    f.context.UserStore.user = { uid: 'account-b' };
    f.context.loadUserSettings({ theme: 'light' });
    resolveResponse({ success: true, settings: { theme: 'dark' } });
    await pending;
    assert.equal(f.checkbox.checked, false);
    assert.equal(f.records.has('yugioh_theme_mode_user:account-a'), false);
    assert.equal(f.records.get('yugioh_theme_mode_user:account-b'), 'light');
});

test('서버 조회 실패는 초기 표시를 유지하고 계정 기록을 만들지 않아 다음 조회를 막지 않는다', async () => {
    const f = fixture({ stored: { yugioh_theme_mode: 'dark' } });
    f.context.loadTheme();
    Object.assign(f.context, {
        callApi: async () => { throw new Error('test network failure'); },
        showLoading: () => {},
        checkAndHideInitialLoading: () => {},
        UIStore: { mode: 'home' },
        console: { error() {} },
    });
    f.context.UserStore.user = { uid: 'new-account' };
    vm.runInContext(source.slice(source.indexOf('async function loadUserData()'), source.indexOf('/**\n * 유튜브 멤버십 상태 적용')), f.context);
    await f.context.loadUserData();
    assert.equal(f.checkbox.checked, true);
    assert.equal(f.records.has('yugioh_theme_mode_user:new-account'), false);
    f.context.loadUserSettings({ theme: 'light' });
    assert.equal(f.checkbox.checked, false);
    assert.equal(f.records.get('yugioh_theme_mode_user:new-account'), 'light');
});
