const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end);
}

function createContext() {
  const context = vm.createContext({
    normalizeStr(value) { return String(value || '').replace(/\s+/g, '').toLowerCase(); },
  });
  vm.runInContext(
    `${extractFunction('compareCardNameSuggestion')}\n${extractFunction('sortCardNameSuggestions')}`,
    context,
  );
  return context;
}

test('카드명 추천은 완전 일치와 앞부분 일치를 우선한다', () => {
  const { sortCardNameSuggestions } = createContext();
  const items = [
    { original: '진 푸른 눈의 백룡', normalized: '진푸른눈의백룡' },
    { original: '푸른 눈', normalized: '푸른눈' },
    { original: '푸른 눈의 백룡', normalized: '푸른눈의백룡' },
    { original: '푸른 눈의 아백룡', normalized: '푸른눈의아백룡' },
  ];
  const result = sortCardNameSuggestions(items, '푸른 눈의 백룡', 8);
  assert.deepEqual(Array.from(result, item => item.original), [
    '푸른 눈의 백룡',
    '진 푸른 눈의 백룡',
    '푸른 눈',
    '푸른 눈의 아백룡',
  ]);
});

test('추천 개수 제한은 전체 후보를 정렬한 다음 적용한다', () => {
  const { sortCardNameSuggestions } = createContext();
  const items = Array.from({ length: 10 }, (_, index) => ({
    original: `가나다 카드 ${index}`,
    normalized: `가나다카드${index}`,
  }));
  items.push({ original: '가나다', normalized: '가나다' });
  const result = sortCardNameSuggestions(items, '가나다', 8);
  assert.equal(result.length, 8);
  assert.equal(result[0].original, '가나다');
});
