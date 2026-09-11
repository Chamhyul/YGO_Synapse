const test = require('node:test');
const assert = require('node:assert/strict');

const classifier = require('../services/draw2CardClassifierService');

test('일러스트 동기화 매니페스트의 패스코드를 CID와 ciid로 변환한다', () => {
  const index = classifier.buildPasscodeIndex({ files: {
    13243124: { cid: '22694', ciid: 2 },
    13243125: { cid: '22694', ciid: 1 },
    invalid: { cid: '1', ciid: 1 },
  } }, true);
  assert.deepEqual(index.get('13243124'), { cid: '22694', ciid: 2 });
  assert.deepEqual(index.get('13243125'), { cid: '22694', ciid: 1 });
  assert.equal(index.has('invalid'), false);
});

test('배포용 일러스트 인덱스의 sourceImageId를 CID로 변환한다', () => {
  const index = classifier.buildPasscodeIndex({ files: {
    '22694_2': { sourceImageId: '13243124', cid: '22694', ciid: 2 },
    '22694_1': { sourceImageId: '13243124', cid: '22694', ciid: 1 },
  } });
  assert.deepEqual(index.get('13243124'), { cid: '22694', ciid: 1 });
});

test('Draw2 로짓에서 점수순 후보와 공식 카드명을 만든다', () => {
  const result = classifier.topCandidates(new Float32Array([1, 3, 2]), {
    0: 'First-100', 1: 'Second-200', 2: 'Third-300',
  }, { 200: { EN: 'Second Card' } }, 2);
  assert.deepEqual(result.map(item => item.passcode), ['200', '300']);
  assert.equal(result[0].cardName, 'Second Card');
  assert.ok(result[0].score > result[1].score);
});

test('잘못된 이미지 입력을 거부한다', () => {
  assert.throws(() => classifier.decodeImage('not base64!'), /base64/);
});
