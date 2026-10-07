const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture: targetFixture } = require('./test_helpers/target_search_fixture');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');

function fixture() {
    const calls = [];
    const section = {};
    const pane = { querySelector: () => section };
    const context = vm.createContext({
        UIStore: { currentRegion: 'ko' }, UserStore: { user: { uid: 'test-user' } },
        rarityReverseMap: { SE: 0, 'Secret Rare': 0 },
        rarityColMap: { display: 0, ko: 1, ja: 2, en: 3 },
        rarityRows: [['SE', '시크릿 레어', 'シークレットレア', 'Secret Rare']],
        compareRarity: (a, b) => a.localeCompare(b),
        cidMetaMemoryCache: new Map(),
        cardCacheInstance: { _inventoryNoToCid: {} }, ClientCache: { _knownNumberToCid: {} },
        lastSearchState: null,
        IllustrationImages: { async preload(cid, illustration) {
            calls.push({ cid, illustration });
            return { status: 'loaded', url: '/sample-art.webp' };
        } },
        SearchNavigation: { currentPane: () => pane },
        document: { getElementById: () => pane },
        OwnedCards: { render(rows, container, options) { calls.push({ rows, container }); return options; } },
    });
    vm.runInContext(source.slice(source.indexOf('function renderOwnedCardsToContainer('),
        source.indexOf('async function loadUserData(')), context);
    return { context, calls, section, options: () => context.renderOwnedCardsToContainer([], section) };
}

const card = () => ({ cid: '100', name: 'English Card', number: 'TEST-EN001' });
const meta = () => ({ cid: '100', info: {
    0: ['한국 카드', [1], { 'TEST-KR001': ['팩', 'SE'] }],
    4: ['English Card', [1, 3], { 'TEST-EN001': ['Pack', 'SE'] }],
} });

test('레어도는 카드 언어와 무관하게 현재 설정 언어의 이름을 우선한다', () => {
    const f = fixture();
    f.context.cidMetaMemoryCache.set('100', meta());
    assert.equal(f.options().describeRarity('SE', card()).label, '시크릿 레어');
    f.context.UIStore.currentRegion = 'ja';
    assert.equal(f.options().describeRarity('SE', card()).label, 'シークレットレア');
    assert.equal(f.options().describeRarity('<unknown>', card()).label, '<unknown>');
});

test('번역 누락은 실제 번호가 수록된 카드 언어로만 대체하고 미확정은 원문을 유지한다', () => {
    const f = fixture();
    f.context.rarityRows[0][1] = '';
    f.context.cidMetaMemoryCache.set('100', meta());
    assert.equal(f.options().describeRarity('SE', card()).label, 'Secret Rare');
    assert.equal(f.options().describeRarity('SE', { ...card(), number: 'UNKNOWN' }).label, 'SE');
    f.context.cidMetaMemoryCache.clear();
    assert.equal(f.options().describeRarity('SE', card()).label, 'SE');
});

test('저장형 언어 메타데이터와 중복 번호의 이름 대조를 지원하며 언어를 임의 선택하지 않는다', () => {
    const f = fixture();
    f.context.rarityRows[0][1] = '';
    f.context.cidMetaMemoryCache.set('100', { cid: '100', info: {
        en: { name: 'English Card', packs: { 'TEST-EN001': ['Pack', 'SE'] } },
        ja: { name: '日本カード', packs: { 'TEST-EN001': ['パック', 'SE'] } },
    } });
    assert.equal(f.options().describeRarity('SE', card()).label, 'Secret Rare');
    assert.equal(f.options().describeRarity('SE', { ...card(), name: '알 수 없음' }).label, 'SE');
});

test('일러스트는 저장된 CID와 불연속 CIID를 기존 이미지 로더로 그대로 전달한다', async () => {
    const f = fixture();
    const input = card();
    const before = structuredClone(input);
    const result = await f.options().loadIllustration(input, '18');
    assert.equal(result.status, 'loaded');
    assert.deepEqual(f.calls.at(-1), { cid: '100', illustration: '18' });
    assert.deepEqual(input, before);
});

test('CID 없는 보유 행은 번호로 검증된 캐시만 사용하며 충돌 null을 우회하지 않는다', async () => {
    const f = fixture();
    const input = { ...card(), cid: '' };
    f.context.ClientCache._knownNumberToCid['TEST-EN001'] = '100';
    await f.options().loadIllustration(input, '3');
    assert.deepEqual(f.calls.at(-1), { cid: '100', illustration: '3' });
    f.context.cardCacheInstance._inventoryNoToCid['TEST-EN001'] = null;
    f.context.cidMetaMemoryCache.set('100', meta());
    assert.equal((await f.options().loadIllustration(input, '3')).status, 'error');
    assert.equal(f.calls.filter(call => call.illustration).length, 1);
});

test('번호 매핑이 없는 경우 현재 메타의 실제 번호 연결을 사용하고 다른 카드나 충돌은 제외한다', () => {
    const f = fixture();
    f.context.lastSearchState = { targetMeta: meta() };
    const input = { ...card(), cid: '' };
    assert.equal(f.context.getOwnedCardDisplayContext(input).cid, '100');
    assert.equal(f.context.getOwnedCardDisplayContext({ ...input, number: 'UNKNOWN' }).cid, '');
    f.context.cidMetaMemoryCache.set('200', { ...meta(), cid: '200' });
    assert.equal(f.context.getOwnedCardDisplayContext(input).cid, '');
});

test('이미지 로더 실패와 CID 미확정은 잘못된 이미지 대체 없이 오류 상태를 반환한다', async () => {
    const f = fixture();
    f.context.IllustrationImages.preload = async () => { throw new Error('sample load failure'); };
    assert.equal((await f.options().loadIllustration(card(), '3')).status, 'error');
    assert.equal((await f.options().loadIllustration({ ...card(), cid: 'LOCAL_CID' }, '3')).url, null);
});

test('기존 렌더 옵션도 변경된 현재 언어를 사용한다', () => {
    const f = fixture();
    const options = f.options();
    assert.equal(options.describeRarity('SE', card()).label, '시크릿 레어');
    f.context.UIStore.currentRegion = 'en';
    assert.equal(options.describeRarity('SE', card()).label, 'Secret Rare');
    assert.equal(f.calls.length, 1);
});

test('같은 카드의 언어 재렌더링은 기존 보유 영역과 그 내부 펼침 노드를 재사용한다', async () => {
    const f = targetFixture();
    const metadata = { cid: '100', info: { ko: ['한국 카드', [], {}, '본문', ''],
        en: ['English Card', [], {}, 'Text', ''], 10: 0, 11: [0] } };
    await f.render(metadata);
    const section = f.area.querySelector('.target-inventory-section');
    const expanded = f.document.createElement('div');
    expanded.className = 'is-expanded';
    section.appendChild(expanded);
    f.context.lastSearchState = { type: 'target', targetCardName: '한국 카드', targetCid: '100' };
    f.context.region = 'en';
    await f.render(metadata);
    assert.equal(f.area.querySelector('.target-inventory-section'), section);
    assert.equal(section.children[0], expanded);
    assert.equal(f.area.querySelector('.search-card__title').textContent, 'English Card');
});

test('이름이 같아도 CID가 다르면 기존 보유 영역과 펼침 노드를 재사용하지 않는다', async () => {
    for (const useMount of [true, false]) {
        const f = targetFixture();
        const metadata = cid => ({ cid, info: { ko: ['동명 카드', [], {}, `본문 ${cid}`, ''], 10: 0, 11: [0] } });
        await f.context.renderTargetSearchResult('동명 카드', [], null, f.area, '100', Promise.resolve(metadata('100')));
        const previousSection = f.area.querySelector('.target-inventory-section');
        previousSection.appendChild(f.document.createElement('div'));
        f.context.lastSearchState = { type: 'target', targetCardName: '동명 카드', targetCid: '100' };
        await f.context.renderTargetSearchResult('동명 카드', [], null, useMount ? f.area : null, '200', Promise.resolve(metadata('200')));
        const nextSection = f.area.querySelector('.target-inventory-section');
        assert.notEqual(nextSection, previousSection, `명시적 마운트: ${useMount}`);
        assert.equal(nextSection.children.length, 0);
        assert.equal(f.area.querySelector('.search-card__text-body').textContent, '본문 200');
    }
});
