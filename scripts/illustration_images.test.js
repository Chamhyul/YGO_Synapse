const test = require('node:test');
const assert = require('node:assert/strict');

const images = require('../public/illustration-images');

test('CID와 ciid로 표시용 인덱스 키를 만든다', () => {
  assert.equal(images.normalizeKey('4007', 2), '4007_2');
  assert.equal(images.normalizeKey('', 1), null);
  assert.equal(images.normalizeKey('4007', 0), null);
});

test('Momobako 일반·펜듈럼 URL과 Storage 대체 URL을 만든다', () => {
  assert.equal(images.momobakoUrl({ sourceImageId: '89631139', transform: 'art', cdnAvailable: true }),
    'https://cdn.233.momobako.com/ygopro/pics/89631139.jpg!art');
  assert.equal(images.momobakoUrl({ sourceImageId: '16178681', transform: 'artp', cdnAvailable: true }),
    'https://cdn.233.momobako.com/ygopro/pics/16178681.jpg!artp');
  assert.equal(images.momobakoUrl({ sourceImageId: null, cdnAvailable: false }), null);
  assert.match(images.storageUrl('public/resources/illustrations/4007_1.webp', 'abcdef1234567890'),
    /4007_1\.webp\?v=abcdef123456/);
});

test('표시 해석 결과는 CDN 우선과 Storage 대체 URL을 함께 제공한다', () => {
  const result = images.resolveFromIndex({ files: {
    '4007_1': {
      sourceImageId: '89631139', transform: 'art', cdnAvailable: true,
      storagePath: 'public/resources/illustrations/4007_1.webp', contentSha256: 'abcdef1234567890',
    },
  } }, '4007', 1);
  assert.match(result.primaryUrl, /89631139\.jpg!art$/);
  assert.match(result.fallbackUrl, /4007_1\.webp\?v=abcdef123456$/);
});

test('CDN 오류 시 Storage URL로 교체한다', () => {
  const listeners = {};
  const image = {
    src: '',
    addEventListener(name, handler) { listeners[name] = handler; },
    removeEventListener(name, handler) { if (listeners[name] === handler) delete listeners[name]; },
  };
  const cleanup = images.displayResolvedImage(image, {
    primaryUrl: 'https://cdn.example/image.webp', fallbackUrl: 'https://storage.example/image.webp',
  }, { timeoutMs: 10000 });
  assert.equal(image.src, 'https://cdn.example/image.webp');
  listeners.error();
  assert.equal(image.src, 'https://storage.example/image.webp');
  cleanup();
});
