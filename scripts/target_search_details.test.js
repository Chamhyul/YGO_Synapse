const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { fixture, source } = require('./test_helpers/target_search_fixture');

function metadata(overrides = {}) {
    return { cid: '100', info: { ko: ['카드 이름', [], {}, '카드 본문', '펜듈럼 본문'],
        10: 0, 11: [0], 12: 4, 13: 0, 14: 0, 15: 1800, 16: 1000, 17: null, ...overrides } };
}

test('펜듈럼 스케일 0과 공격력 미정값을 보존하고 두 설명을 순서대로 렌더링한다', async () => {
    const f = fixture();
    await f.render(metadata({ 11: [6], 15: -1, 17: 0 }));
    assert.deepEqual(f.stats(), ['공격력', '?', '수비력', '1000', '펜듈럼 스케일', '0']);
    assert.equal(f.area.querySelector('.search-card__title').tagName, 'H2');
    const descriptions = f.area.querySelector('.search-card__text').children;
    assert.deepEqual(descriptions.map(section => section.children.map(child => child.textContent)),
        [['[펜듈럼 효과]', '펜듈럼 본문'], ['[카드 텍스트]', '카드 본문']]);
    assert.ok(descriptions.every(section => section.children[0].tagName === 'H3'));
    const rows = f.area.querySelector('.search-card__table--monster').querySelectorAll('tr');
    assert.equal(rows[0].children.length, 6);
    assert.equal(rows[1].children.length, 6);
    assert.equal(rows.length, 3);
    assert.ok(rows[1].children.every(cell => !cell.colSpan || cell.colSpan === 1));
    const classes = f.area.querySelector('.search-card__classifications');
    assert.equal(rows[2].children.length, 1);
    assert.equal(classes.colSpan, 6);
    assert.equal(classes.querySelector('.visually-hidden').textContent, '분류: ');
    assert.deepEqual(classes.querySelectorAll('.ui-chip').map(chip => chip.textContent), ['펜듈럼']);
    assert.equal(rows[1].children[4].querySelector('.search-card__label-mobile').textContent, '펜듈럼');
    assert.equal(f.area.querySelectorAll('table').length, 1);
});

test('링크 수비력은 데이터 값보다 대시 규칙을 우선하고 비펜듈럼 스케일을 숨긴다', async () => {
    const f = fixture();
    await f.render(metadata({ 11: [13], 12: 3, 16: -1, 17: 8 }));
    assert.deepEqual(f.stats(), ['공격력', '1800', '수비력', '-', '펜듈럼 스케일', '-']);
    const firstRow = f.area.querySelector('.search-card__table--monster').querySelectorAll('tr')[0];
    assert.deepEqual(firstRow.children.slice(4).map(cell => cell.textContent), ['LINK', 'LINK-3']);
    assert.deepEqual(f.area.querySelectorAll('.search-card__text-heading').map(heading => heading.textContent), ['[카드 텍스트]']);
});

test('일반 몬스터 결측 능력치와 펜듈럼 결측 스케일을 대시로 표시한다', async () => {
    const f = fixture();
    await f.render(metadata({ 15: null, 16: undefined, 17: 8 }));
    assert.deepEqual(f.stats(), ['공격력', '-', '수비력', '-', '펜듈럼 스케일', '-']);
    for (const scale of [null, undefined, '']) {
        await f.render(metadata({ 11: [6], 17: scale, ko: ['카드', [], {}, '', ''] }));
        assert.equal(f.stats()[5], '-');
        assert.deepEqual(f.area.querySelectorAll('.search-card__text-body').map(body => body.textContent),
            ['-', '카드 텍스트 정보가 없습니다.']);
    }
});

test('마법·함정은 능력치 표 없이 카드 텍스트 제목을 항상 표시한다', async () => {
    const f = fixture();
    for (const [kind, classification, label] of [[1, 15, '일반 마법'], [2, 21, '일반 함정']]) {
        await f.render(metadata({ 10: kind, 11: [classification], ko: ['카드', [], {}, '', ''] }));
        assert.equal(f.area.querySelector('.search-card__table--monster'), null);
        assert.equal(f.area.querySelector('.search-card__kind').textContent, label);
        assert.deepEqual(f.area.querySelectorAll('.search-card__text-heading').map(heading => heading.textContent), ['[카드 텍스트]']);
        assert.equal(f.area.querySelector('.search-card__text-body').textContent, '카드 텍스트 정보가 없습니다.');
    }
});

test('지역 변경의 속성·종족 갱신과 새 본문 렌더링은 능력치·줄바꿈·문자 안전성을 보존한다', async () => {
    const f = fixture();
    const meta = metadata({ 11: [6], 17: '0', ko: ['한국 카드', [], {}, '<img src=x>\n둘째<br>셋째', '효과<br/>다음'],
        en: ['English card', [], {}, 'Text<br />next', 'Pendulum\nnext'] });
    await f.render(meta);
    const koBodies = f.area.querySelectorAll('.search-card__text-body');
    assert.equal(koBodies[0].textContent, '효과\n다음');
    assert.equal(koBodies[1].textContent, '<img src=x>\n둘째\n셋째');
    assert.equal(koBodies[1].children.length, 0);
    f.context.lastSearchState = { targetMeta: meta };
    f.context.region = 'en';
    f.context.updateMemoryDecodedElements();
    const cells = f.area.querySelector('.search-card__table--monster').querySelectorAll('td');
    assert.deepEqual(cells.slice(0, 2).map(cell => cell.textContent), ['LIGHT', 'Dragon']);
    assert.deepEqual(f.stats(), ['공격력', '1800', '수비력', '1000', '펜듈럼 스케일', '0']);
    await f.render(meta);
    assert.equal(f.area.querySelector('.search-card__title').textContent, 'English card');
    assert.deepEqual(f.area.querySelectorAll('.search-card__text-body').map(body => body.textContent), ['Pendulum\nnext', 'Text\nnext']);
});

test('메타데이터 응답 전에 기본 설명을 표시하고 늦은 응답은 새 검색을 덮지 않는다', async () => {
    const f = fixture();
    let finish;
    const pending = f.context.renderTargetSearchResult('임시 카드', [], null, f.area, '100',
        new Promise(resolve => { finish = resolve; }));
    assert.equal(f.area.querySelector('.search-card__title').textContent, '임시 카드');
    assert.equal(f.area.querySelector('.search-card__text-heading').textContent, '[카드 텍스트]');
    await f.render(metadata({ ko: ['새 카드', [], {}, '새 본문', ''] }));
    finish(metadata({ ko: ['이전 카드', [], {}, '이전 본문', ''] }));
    await pending;
    assert.equal(f.area.querySelector('.search-card__title').textContent, '새 카드');
    assert.equal(f.area.querySelector('.search-card__text-body').textContent, '새 본문');
});

test('각 정보 값은 같은 행의 다른 제목과 섞이지 않고 자신의 머리글에 연결된다', async () => {
    const f = fixture();
    await f.render(metadata());
    const card = f.area.querySelector('.search-card');
    const title = card.querySelector('h2');
    assert.equal(card.tagName, 'ARTICLE');
    assert.equal(card.attributes['aria-labelledby'], title.id);
    assert.equal(card.querySelector('.search-card__name').tagName, 'HEADER');
    const table = card.querySelector('table');
    const labels = table.querySelectorAll('th');
    const values = table.querySelectorAll('td');
    assert.equal(labels.length, 6);
    assert.equal(new Set(labels.map(label => label.id)).size, labels.length);
    values.slice(0, 6).forEach((value, index) => assert.equal(value.attributes.headers, labels[index].id));
    assert.equal(values[6].attributes.headers, undefined);
    const previousIds = labels.map(label => label.id);
    await f.render(metadata({ 11: [6] }));
    assert.ok(f.area.querySelectorAll('th').every(label => !previousIds.includes(label.id)));
});

test('비동기 카드 정보는 실제 마운트 영역과 함께 탐색 상태에 전달된다', async () => {
    const f = fixture();
    const states = [];
    f.context.SearchNavigation = { currentPane: () => f.area, updateTarget: (state, pane) => states.push({ state, pane }) };
    await f.context.renderTargetSearchResult('카드', [], null, null, '100', Promise.resolve(metadata()));
    assert.equal(states.length, 1);
    assert.equal(states[0].pane, f.area);
    assert.equal(states[0].state.type, 'target');
    assert.equal(states[0].state.targetCid, '100');
    assert.equal(states[0].state.targetMeta.info[15], 1800);
});

test('상세 정보 대기 중 보유 정보가 갱신되어도 진행 중인 메타데이터 응답은 유효하다', async () => {
    const f = fixture();
    f.context.lastSearchState = { type: 'target', targetCardName: '임시 카드', targetCid: '100', targetRows: [], targetMeta: null };
    const updates = [];
    f.context.SearchNavigation = { currentPane: () => f.area,
        updateTarget(state) { updates.push(state); f.context.lastSearchState = state; } };
    let finish;
    const pending = f.context.renderTargetSearchResult('임시 카드', [], null, f.area, '100',
        new Promise(resolve => { finish = resolve; }));
    const originalCard = f.area.querySelector('.search-card');
    const requestSequence = f.context.searchSequence;
    await f.context.renderTargetSearchResult('임시 카드', [], null, null, '100');
    assert.equal(f.context.searchSequence, requestSequence);
    assert.equal(f.area.querySelector('.search-card'), originalCard);
    assert.equal(updates.length, 1);
    finish(metadata({ ko: ['응답 카드', [], {}, '완료된 카드 본문', ''] }));
    await pending;
    assert.equal(f.area.querySelector('.search-card__title').textContent, '응답 카드');
    assert.equal(f.area.querySelector('.search-card__text-body').textContent, '완료된 카드 본문');
    assert.equal(f.context.lastSearchState.targetMeta.info.ko[0], '응답 카드');
    assert.equal(updates.length, 2);
});

test('느린 메타데이터 응답으로 제목을 다시 그려도 카드 제목의 초점을 보존한다', async () => {
    const f = fixture();
    let finish;
    const pending = f.context.renderTargetSearchResult('임시 카드', [], null, f.area, '100',
        new Promise(resolve => { finish = resolve; }));
    const initialTitle = f.area.querySelector('.search-card__title');
    initialTitle.focus({ preventScroll: true });
    finish(metadata());
    await pending;
    const updatedTitle = f.area.querySelector('.search-card__title');
    assert.notEqual(updatedTitle, initialTitle);
    assert.equal(f.document.activeElement, updatedTitle);
    assert.equal(updatedTitle.focusOptions.preventScroll, true);
    assert.equal(updatedTitle.classList.contains('search-results__focus-target'), true);
});

test('메타데이터 갱신 후에도 이름 영역의 복귀 링크와 8px 형태 클래스를 유지한다', async () => {
    const f = fixture();
    let finish;
    const pending = f.context.renderTargetSearchResult('임시 카드', [], null, f.area, '100',
        new Promise(resolve => { finish = resolve; }));
    const card = f.area.querySelector('.search-card');
    const back = f.document.createElement('a');
    back.className = 'search-results__back';
    back.textContent = '< 뒤로 가기';
    card.querySelector('.search-card__name').prepend(back);
    finish(metadata());
    await pending;
    assert.equal(card.querySelector('.search-card__name').children[0], back);
    assert.equal(card.querySelectorAll('.search-results__back').length, 1);
    assert.equal(card.classList.contains('shape-rounded002'), true);
    assert.equal(card.querySelector('.search-card__text').classList.contains('shape-rounded002'), true);
});

test('메타데이터 응답을 기다리며 다른 컨트롤로 옮긴 초점은 가져오지 않는다', async () => {
    const f = fixture();
    let finish;
    const pending = f.context.renderTargetSearchResult('임시 카드', [], null, f.area, '100',
        new Promise(resolve => { finish = resolve; }));
    const other = f.document.createElement('button');
    other.focus();
    finish(metadata());
    await pending;
    assert.equal(f.document.activeElement, other);
});

test('메타데이터 최종 툴팁 초기화는 현재 카드 정보에 한정하고 보유 표나 나가는 화면을 재초기화하지 않는다', async () => {
    const f = fixture();
    const leaving = f.document.createElement('th');
    leaving.className = 'sp-col tooltipped';
    let infoTooltip, ownedTooltip;
    const initialized = [];
    f.context.M.Tooltip.init = nodes => initialized.push([...nodes]);
    f.context.SearchIllustrations.mount = container => {
        infoTooltip = f.document.createElement('button');
        infoTooltip.className = 'tooltipped';
        container.appendChild(infoTooltip);
    };
    f.context.renderOwnedCardsToContainer = (_, container) => {
        ownedTooltip = f.document.createElement('th');
        ownedTooltip.className = 'sp-col tooltipped';
        container.innerHTML = '';
        container.appendChild(ownedTooltip);
    };
    f.document.querySelectorAll = () => [leaving, ...f.area.querySelectorAll('.tooltipped')];
    await f.render(metadata());
    assert.deepEqual(initialized, [[infoTooltip]]);
    assert.equal(f.area.querySelector('.search-card').contains(infoTooltip), true);
    assert.equal(f.area.querySelector('.target-inventory-section').contains(ownedTooltip), true);
    assert.ok(initialized.every(nodes => !nodes.includes(leaving) && !nodes.includes(ownedTooltip)));
});

test('언어별 레어도 툴팁은 현재 pane만 갱신하고 HTML을 이스케이프하며 pane이 없으면 결과 영역으로 제한한다', () => {
    for (const hasPane of [true, false]) {
        const f = fixture();
        const pane = hasPane ? f.document.createElement('div') : f.area;
        if (hasPane) f.area.appendChild(pane);
        const makeHeader = (parent, key, index) => {
            const th = f.document.createElement('th');
            th.className = 'sp-col tooltipped';
            th.dataset = { key, index };
            th.setAttribute('data-tooltip', '기존 설명');
            parent.appendChild(th);
            return th;
        };
        const outside = hasPane ? f.area : f.document.body;
        const oldHeader = makeHeader(outside, '이전 카드', '0');
        const currentHeader = makeHeader(pane, 'UR', '0');
        const fallbackHeader = makeHeader(pane, '<img src=x> & unknown', '');
        const unrelated = f.document.createElement('button');
        unrelated.className = 'tooltipped';
        pane.appendChild(unrelated);
        const initialized = [];
        f.context.M.Tooltip.init = (nodes, options) => initialized.push({ nodes: [...nodes], options });
        f.context.SearchNavigation = { currentPane: () => hasPane ? pane : null };
        f.context.UIStore = { currentRegion: 'en' };
        f.context.rarityColMap = { en: 1 };
        f.context.rarityRows = [['UR', 'Ultra <b>Rare</b> (Foil)']];
        f.document.querySelectorAll = () => [oldHeader, currentHeader, fallbackHeader, unrelated];
        vm.runInContext(source.slice(source.indexOf('function escapeHTML('), source.indexOf('\nfunction ', source.indexOf('function escapeHTML(') + 1)), f.context);
        vm.runInContext(source.slice(source.indexOf('function updateTooltipsOnly('), source.indexOf('function updateRarityInputs(')), f.context);
        f.context.updateTooltipsOnly();
        assert.equal(initialized.length, 1);
        assert.deepEqual(initialized[0].nodes, [currentHeader, fallbackHeader]);
        assert.equal(initialized[0].options.html, true);
        assert.equal(initialized[0].options.margin, 3);
        assert.equal(currentHeader.attributes['data-tooltip'], 'Ultra &lt;b&gt;Rare&lt;/b&gt; <br>(Foil)');
        assert.equal(fallbackHeader.attributes['data-tooltip'], '&lt;img src=x&gt; &amp; unknown');
        assert.equal(oldHeader.attributes['data-tooltip'], '기존 설명');
    }
});
