const test = require('node:test');
const assert = require('node:assert/strict');
const { entries } = require('../public/search-illustrations');

test('DB 지역 목록 전체를 합치고 불연속 CIID 및 지역을 보존한다', () => {
    const result = entries({0: ['한국 이름', [1, 3]], 1: ['일본 이름', [1, 2, 3]]}, {files: {'123_7': {}, '1234_8': {}}}, '123');
    assert.deepEqual(result.map(([id, regions]) => [id, [...regions]]), [[1, ['한국', '일본']], [2, ['일본']], [3, ['한국', '일본']], [7, []]]);
});
test('DB 저장 형식을 지원하고 count로 발매 여부를 추측하지 않는다', () => {
    assert.deepEqual(entries({ko: {ciid: [3]}, ja: {ciid: [3, 7]}, 4: ['English', 8]}, null, '123').map(([id, regions]) => [id, [...regions]]), [[3, ['한국', '일본']], [7, ['일본']]]);
});
test('인덱스 실패 시에도 DB 일러스트 목록을 유지한다', () => {
    assert.deepEqual(entries({0: ['카드', [1]]}, null, '123').map(([id]) => id), [1]);
    assert.deepEqual(entries(null, null, '123'), []);
});
