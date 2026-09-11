const test = require('node:test');
const assert = require('node:assert/strict');

const search = require('../services/cardImageSearchService');
const indexer = require('../../scripts/build_card_illustration_phash');

test('동기화 스크립트와 같은 64비트 pHash를 계산한다', () => {
  const pixels = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
  assert.equal(search.phashFromPixels(pixels), indexer.phashFromPixels(pixels));
});

test('base64 및 data URL 이미지를 디코딩하고 크기를 제한한다', () => {
  assert.deepEqual(search.decodeImage(Buffer.from('test').toString('base64')), Buffer.from('test'));
  assert.deepEqual(search.decodeImage('data:image/webp;base64,dGVzdA=='), Buffer.from('test'));
  assert.throws(() => search.decodeImage('not base64!'), /base64/);
});

test('해밍 거리가 가까운 결과를 제한 수만큼 정렬한다', () => {
  const index = { files: {
    '2_1': { cid: '2', ciid: 1, phash: '0000000000000003' },
    '1_2': { cid: '1', ciid: 2, phash: '0000000000000001' },
    '3_1': { cid: '3', ciid: 1, phash: 'ffffffffffffffff' },
  } };
  assert.deepEqual(search.findNearest(index, '0000000000000000', 2, 4).map(item => item.key), ['1_2', '2_1']);
  assert.equal(search.findNearest(index, '0000000000000000', 5, 0).length, 0);
});

test('알고리즘 버전이 다른 인덱스를 거부한다', () => {
  assert.throws(() => search.validateIndex({ algorithmVersion: 'old', files: {} }), /지원하지 않는/);
});

test('배치 검색은 빈 목록과 최대 영역 수를 검증한다', async () => {
  await assert.rejects(() => search.searchImages([]), /분석할 이미지/);
  await assert.rejects(() => search.searchImages(Array(21).fill('dGVzdA==')), /최대 20개/);
});
