const test = require('node:test');
const assert = require('node:assert/strict');
const filters = require('../public/catalog-filters.js');
const card = { nameMatch: true, numberMatch: false };
const monster = extra => filters.normalize({ info: { 10: 0, 11: [0], 12: 4, 13: 0, 14: 0, 15: 1800, 16: 1000, ...extra } });
const spell = extra => filters.normalize({ info: { 10: 1, 11: [17], ...extra } });
const trap = extra => filters.normalize({ info: { 10: 2, 11: [23], ...extra } });
const result = (state, meta) => filters.evaluate(card, state, meta);

test('종류별 분기는 실제 종류를 따르고 몬스터 전용 조건이 마법을 제거하지 않는다', () => {
    const state = filters.create();
    state.kind = ['monster', 'spell']; state.attribute = ['dark'];
    state.monster.values = ['normal']; state.spell.values = ['quick'];
    assert.equal(result(state, monster()), 'match');
    assert.equal(result(state, monster({ 13: 1 })), 'miss');
    assert.equal(result(state, spell()), 'match');
    assert.equal(result(state, spell({ 11: [15] })), 'miss');
    assert.equal(result(state, trap()), 'miss');
    state.kind = [];
    assert.equal(result(state, monster({ 13: 1 })), 'miss', '비어 있는 다른 종류 분기로 몬스터를 통과시키면 안 된다');
    assert.equal(result(state, trap()), 'match');
});

test('특성 AND/OR 및 전체 선택을 유지하며 AND 0건은 다른 종류 결과를 없애지 않는다', () => {
    const state = filters.create();
    state.monster = { values: ['fusion', 'effect'], operator: 'or' };
    assert.equal(result(state, monster({ 11: [3] })), 'match');
    state.monster.operator = 'and';
    assert.equal(result(state, monster({ 11: [3] })), 'miss');
    assert.equal(result(state, monster({ 11: [3, 1] })), 'match');
    state.monster.values = filters.definitions.monster.options.map(item => item.value);
    assert.equal(result(state, monster({ 11: [0] })), 'miss');
    assert.equal(result(state, spell()), 'match');
    assert.equal(filters.summarize(state, 'monster'), 'AND: 전체');
    state.monster.operator = 'or';
    assert.equal(result(state, monster({ 11: [] })), 'miss');
    assert.equal(result(state, monster({ 11: [0] })), 'match');
    state.monster.values = [];
    assert.equal(result(state, monster({ 11: [] })), 'match');
});

test('종류를 제외해도 보존된 값·연산자가 돌아오며 실제 편집 가능 여부만 바뀐다', () => {
    const state = filters.create();
    state.monster = { values: ['effect', 'fusion'], operator: 'and' };
    state.attack = { from: 2500, to: null }; state.kind = ['spell'];
    assert.equal(filters.isEnabled(state, 'attack'), false);
    assert.equal(filters.isEnabled(state, 'monster'), false);
    assert.equal(result(state, spell()), 'match');
    state.kind = ['monster', 'spell'];
    assert.equal(filters.isEnabled(state, 'attack'), true);
    assert.deepEqual(state.monster, { values: ['effect', 'fusion'], operator: 'and' });
    assert.equal(result(state, monster({ 11: [3, 1], 15: 2400 })), 'miss');
    assert.equal(result(state, monster({ 11: [3, 1], 15: 2500 })), 'match');
});

test('0과13은 정확값이며 물음표만 비교에서 0, 링크 수비력·누락은 별개다', () => {
    const state = filters.create(); state.level = 0; state.pendulum = 13;
    assert.equal(result(state, monster({ 11: [6], 12: 0, 17: 13 })), 'match');
    assert.equal(result(state, monster({ 12: 0, 17: null })), 'miss');
    state.level = null; state.pendulum = null; state.attack = { from: 0, to: 0 };
    for (const value of [0, '?', -1, '-1']) assert.equal(result(state, monster({ 15: value })), 'match');
    for (const value of [null, undefined, '', '-']) assert.equal(result(state, monster({ 15: value })), 'miss');
    state.attack = { from: null, to: null }; state.defense = { from: 0, to: 0 };
    assert.equal(result(state, monster({ 11: [13], 16: -1 })), 'miss');
    assert.equal(result(state, monster({ 16: -1 })), 'match');
    assert.equal(result(state, spell()), 'match');
});

test('필터용 정규화가 원본 물음표·스케일0을 덮어쓰지 않는다', () => {
    const meta = { info: { 10: 0, 11: [6], 15: -1, 16: '?', 17: 0 } };
    const copy = JSON.stringify(meta);
    const normalized = filters.normalize(meta);
    assert.equal(normalized.attack, 0); assert.equal(normalized.defense, 0); assert.equal(normalized.pendulum, 0);
    assert.equal(JSON.stringify(meta), copy);
});

test('메타데이터 미조회는 몬스터로 간주하지 않고 조건이 있으면 대기한다', () => {
    const state = filters.create();
    assert.equal(filters.normalize({ info: {} }), null);
    assert.equal(result(state, null), 'match');
    state.kind = ['monster'];
    assert.equal(result(state, null), 'pending');
    state.target = ['number'];
    assert.equal(result(state, null), 'miss', '검색 대상 불일치는 메타데이터를 기다리지 않는다');
});

test('범위는 양 끝 포함, 한쪽 빈 값은 무한, 역전·소수·음수·범위 밖은 거부한다', () => {
    for (const invalid of ['1.2', '-1', '1e3', 'Infinity', 'abc', '14']) assert.ok(filters.validate('level', invalid).error);
    for (const valid of ['', '0', '13']) assert.equal(filters.validate('level', valid).error, undefined);
    assert.deepEqual(filters.validate('attack', { from: '', to: '3000' }).value, { from: null, to: 3000 });
    assert.ok(filters.validate('attack', { from: '3000', to: '2000' }).error);
    assert.ok(filters.validate('attack', { from: '0.1', to: '' }).error);
    const state = filters.create(); state.attack = { from: 1000, to: 1800 };
    assert.equal(result(state, monster({ 15: 1000 })), 'match');
    assert.equal(result(state, monster({ 15: 1800 })), 'match');
    assert.equal(result(state, monster({ 15: 999 })), 'miss');
    state.attack = { from: 10000000, to: null };
    assert.equal(result(state, monster({ 15: 10000000 })), 'match');
});

test('표시 순서·종족26개·특성 저장 코드가 독립적으로 연결된다', () => {
    assert.deepEqual(filters.definitions.race.options.slice(-2).map(item => item.label), ['환신야수족', '창조신족']);
    assert.equal(filters.definitions.race.options.length, 26);
    assert.deepEqual(filters.definitions.monster.options.map(item => item.label), ['일반', '효과', '의식', '융합', '싱크로', '엑시즈', '펜듈럼', '링크', '툰', '스피릿', '유니온', '듀얼', '튜너', '리버스', '특수 소환']);
    assert.deepEqual(monster({ 11: [7, 8, 9], 14: 20 }).properties, ['toon', 'spirit', 'tuner']);
    assert.equal(monster({ 14: 20 }).race, 'creator-god');
    const stored = filters.normalize({ card_type: 'Spell', properties: ['Quick-Play Spell'], attribute: 'DARK' });
    assert.equal(stored.kind, 'spell'); assert.deepEqual(stored.properties, ['quick']);
});

test('모든 종류별 선택지를 각각 필터링할 수 있다', () => {
    for (const kind of filters.kinds) {
        for (const option of filters.definitions[kind.value].options) {
            const state = filters.create(); state.kind = [kind.value]; state[kind.value].values = [option.value];
            const matching = filters.normalize({ 10: kind.code, 11: [option.code] });
            assert.equal(result(state, matching), 'match', `${kind.label} ${option.label}`);
            assert.equal(result(state, filters.normalize({ 10: kind.code, 11: [] })), 'miss');
        }
    }
    for (const key of ['attribute', 'race']) for (const option of filters.definitions[key].options) {
        const state = filters.create(); state[key] = [option.value];
        assert.equal(result(state, monster({ [key === 'attribute' ? 13 : 14]: option.code })), 'match');
    }
});

test('부분 메타데이터의 미조회 필드와 완료 응답의 실제 값 없음은 구분한다', () => {
    const state = filters.create(); state.attack = { from: 0, to: 1000 };
    assert.equal(result(state, filters.normalize({ info: { 10: 0 } }, { complete: false })), 'pending');
    assert.equal(result(state, filters.normalize({ info: { 10: 0 } }, { complete: true })), 'miss');
    assert.equal(result(state, filters.normalize({ info: { 10: 0, 15: null } }, { complete: false })), 'miss');
    state.attack = { from: null, to: null }; state.monster.values = ['normal'];
    assert.equal(result(state, filters.normalize({ info: { 10: 0 } }, { complete: false })), 'pending');
    assert.equal(result(state, filters.normalize({ info: { 10: 0, 11: [] } }, { complete: false })), 'miss');
});
