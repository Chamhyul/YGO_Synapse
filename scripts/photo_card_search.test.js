const test = require('node:test');
const assert = require('node:assert/strict');
const photo = require('../public/photo-card-search');

test('겹치는 검출 영역은 점수가 높은 영역 하나로 병합한다', () => {
  const result = photo.normalizeRegions([
    { x: .1, y: .1, width: .4, height: .6, score: 2 },
    { x: .11, y: .11, width: .39, height: .59, score: 1 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].score, 2);
});

test('카드 외곽선 안에 포함된 내부 테두리는 별도 카드로 세지 않는다', () => {
  const result = photo.normalizeRegions([
    { x: .2, y: .1, width: .3, height: .55, score: 2 },
    { x: .24, y: .2, width: .2, height: .32, score: 1 },
  ]);
  assert.equal(result.length, 1);
});

test('사진 대부분을 차지하는 보호판이나 배경 사각형은 제외한다', () => {
  const result = photo.normalizeRegions([
    { x: .02, y: .02, width: .9, height: .9, score: 3 },
    { x: .18, y: .1, width: .58, height: .82, score: 2 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].width, .58);
});

test('사진의 두 가장자리에 붙은 프레임 윤곽은 카드로 선택하지 않는다', () => {
  const result = photo.normalizeRegions([
    { x: 0, y: 0, width: .72, height: .9, score: 3 },
    { x: .16, y: .14, width: .55, height: .78, score: 2 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].x, .16);
});

test('복수 카드 사진에서 중앙 면적보다 지나치게 큰 묶음 후보를 제외한다', () => {
  const cards = [
    { x: .05, y: .05, width: .2, height: .32, score: 2 },
    { x: .3, y: .05, width: .2, height: .32, score: 2 },
    { x: .05, y: .5, width: .2, height: .32, score: 2 },
    { x: .3, y: .5, width: .2, height: .32, score: 2 },
  ];
  const result = photo.normalizeRegions([
    { x: .02, y: .03, width: .46, height: .38, score: 4 },
    ...cards,
  ]);
  assert.equal(result.length, 4);
  assert.ok(result.every(region => region.width === .2));
});

test('분석 영역은 최대 100개로 제한한다', () => {
  const regions = Array.from({ length: 110 }, (_, index) => ({
    x: (index % 11) * .09, y: Math.floor(index / 11) * .095,
    width: .07, height: .07, score: index,
  }));
  assert.equal(photo.MAX_REGIONS, 100);
  assert.equal(photo.ANALYSIS_BATCH_SIZE, 10);
  assert.equal(photo.normalizeRegions(regions).length, 100);
});

test('검출 영역을 위에서 아래로, 같은 행에서는 왼쪽에서 오른쪽으로 정렬한다', () => {
  const regions = [
    { id: 'bottom', x: .45, y: .75, width: .1, height: .15 },
    { id: 'top-right', x: .7, y: .05, width: .1, height: .15 },
    { id: 'middle-left', x: .25, y: .4, width: .1, height: .15 },
    { id: 'top-left', x: .1, y: .04, width: .1, height: .15 },
    { id: 'middle-right', x: .6, y: .41, width: .1, height: .15 },
  ];
  assert.deepEqual(photo.sortRegionsReadingOrder(regions).map(region => region.id), [
    'top-left', 'top-right', 'middle-left', 'middle-right', 'bottom',
  ]);
});

test('Draw2 분류에는 검출한 카드 전체를 정사각형으로 원근 보정해 사용한다', () => {
  assert.equal(photo.CARD_ART_CROPS.length, 1);
  photo.CARD_ART_CROPS.forEach(crop => {
    assert.deepEqual(crop, { x: 0, y: 0, width: 1, height: 1 });
  });
});

test('한 장의 사진에서 떨어진 복수 카드 외곽선을 각각 검출한다', () => {
  const width = 180, height = 120, data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) data[index * 4 + 3] = 255;
  const rectangle = (left, top, right, bottom) => {
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      if (x !== left && x !== right && y !== top && y !== bottom) continue;
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
    }
  };
  rectangle(12, 12, 48, 72);
  rectangle(105, 24, 141, 84);
  const regions = photo.detectRegionsFromImageData({ data, width, height });
  assert.equal(regions.length, 2);
});

test('회전된 네 꼭짓점을 좌상단부터 시계 방향으로 정렬한다', () => {
  assert.deepEqual(photo.orderQuad([
    { x: 90, y: 90 }, { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 90 },
  ]), [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
  ]);
});

test('카드 비율의 사각형만 정규화 영역으로 변환한다', () => {
  const card = photo.regionFromQuad([
    { x: 10, y: 10 }, { x: 69, y: 10 }, { x: 69, y: 96 }, { x: 10, y: 96 },
  ], 100, 120, .4);
  assert.ok(card);
  assert.equal(card.polygon.length, 4);
  assert.equal(photo.regionFromQuad([
    { x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 20 }, { x: 0, y: 20 },
  ], 100, 100, .2), null);
});
