const test = require('node:test');
const assert = require('node:assert/strict');
const { toStoredInfo, toRuntimeInfo } = require('../utils/cardSchema');

test('언어/스탯을 의미 있는 키로 저장하며 직접 중첩 배열이 없다', () => {
  const original = {
    0: ['카드', [1, 9, 15], { 'NO-1': ['팩', 'N'] }, '효과', '펜듈럼 효과'],
    1: ['カード', [1, 18], {}, 'text', ''],
    10: 0, 11: [5, 6, 1], 12: 4, 13: 0, 14: 17, 15: -1, 16: 0, 17: 8,
  };
  const stored = toStoredInfo(original);
  assert.deepEqual(stored.ko, { name: '카드', ciid: [1, 9, 15], packs: { 'NO-1': ['팩', 'N'] }, text: '효과', text_pen: '펜듈럼 효과' });
  assert.equal(stored.card_type, 'Monster');
  assert.equal(stored.race, 'Spellcaster');
  assert.deepEqual(stored.properties, ['Xyz', 'Pendulum', 'Effect']);
  assert.equal(stored.lv, 4);
  assert.equal(stored.monster_types, undefined);
  assert.equal(stored.rank, undefined);
  assert.equal(stored.level, undefined);
  assert.equal(stored.atk, '?');
  function validate(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) assert.ok(value.every(item => !Array.isArray(item)), 'Firestore 직접 중첩 배열 금지');
    Object.values(value).forEach(validate);
  }
  validate(stored);
  assert.ok(Object.keys(stored).every(key => !/^\d+$/.test(key)));
  assert.deepEqual(toRuntimeInfo(stored), original);
  assert.deepEqual(toStoredInfo(stored), stored);
});

test('링크 수치와 마법/함정 분류 및 미확정 ciid를 구분한다', () => {
  const link = toStoredInfo({ 10: 0, 11: [13, 1], 12: 3 });
  assert.equal(link.lv, 3);
  assert.deepEqual(link.properties, ['Link', 'Effect']);
  assert.equal(link.link_rating, undefined);
  assert.equal(link.level, undefined);
  const spell = toStoredInfo({ 0: ['마법', 12, {}, '', ''], 10: 1, 11: [17] });
  assert.deepEqual(spell.properties, ['Quick-Play Spell']);
  assert.equal(spell.ko.ciid, null);
});
