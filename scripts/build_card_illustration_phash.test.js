const test = require('node:test');
const assert = require('node:assert/strict');

const phash = require('./build_card_illustration_phash');

test('32x32 픽셀에서 64비트 pHash를 만든다', () => {
  const pixels = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
  const result = phash.phashFromPixels(pixels);
  assert.match(result, /^[a-f0-9]{16}$/);
  assert.equal(phash.phashFromPixels(pixels), result);
});

test('pHash 해밍 거리를 계산한다', () => {
  assert.equal(phash.hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(phash.hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(phash.hammingDistance('0000000000000000', '000000000000000f'), 4);
});

test('준비 및 원본 누락 상태만 pHash 대상으로 유지한다', () => {
  const targets = phash.manifestTargets({ files: {
    a: { status: 'ready', cid: '1', ciid: 1, target: '1_1.webp', localSha256: 'a' },
    b: { status: 'sourceMissing', cid: '2', ciid: 1, target: '2_1.webp', localSha256: 'b' },
    c: { status: 'pending', cid: '3', ciid: 1, target: '3_1.webp', localSha256: 'c' },
  } });
  assert.deepEqual([...targets.keys()], ['1_1', '2_1']);
});
