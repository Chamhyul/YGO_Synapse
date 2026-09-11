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
    /\/api\/illustrations\/4007_1\.webp$/);
});

test('표시 해석 결과는 CDN 우선과 Storage 대체 URL을 함께 제공한다', () => {
  const result = images.resolveFromIndex({ files: {
    '4007_1': {
      sourceImageId: '89631139', transform: 'art', cdnAvailable: true,
      storagePath: 'public/resources/illustrations/4007_1.webp', contentSha256: 'abcdef1234567890',
    },
  } }, '4007', 1);
  assert.match(result.primaryUrl, /89631139\.jpg!art$/);
  assert.match(result.fallbackUrl, /\/api\/illustrations\/4007_1\.webp$/);
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

test('불연속 CIID와 표시 라벨을 구분한다', () => {
  assert.deepEqual([1, 9, 15, 21, 112].map(images.label), ['기본', '9th', '15th', '21st', '112th']);
  assert.deepEqual(['기본', '2nd', '15th'].map(images.ciidValue), ['1', '2', '15']);
  assert.equal(images.ciidValue('unknown'), '');
});

function fakeImage(requests, outcome) {
  return { set src(url) { requests.push(url); queueMicrotask(() => outcome(url) ? this.onload?.() : this.onerror?.()); } };
}

test('미리 로딩은 모모바코 실패 후 Storage를 사용하고 중복 요청을 공유한다', async t => {
  images.resetIndexCache();
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ files: {
    '4007_9': { sourceImageId: '89631139', transform: 'art' },
  } }) }));
  const requests = [];
  const options = { createImage: () => fakeImage(requests, url => url.startsWith('/api/illustrations/')) };
  const first = images.preload('4007', '9', options);
  const second = images.preload('4007', '9th', options);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.status, 'loaded');
  assert.match(result.url, /4007_9.webp/);
  assert.equal(requests.length, 2);
  await images.preload('4007', 9, options);
  assert.equal(requests.length, 2);
});

test('인덱스 요청 실패와 항목 누락 모두 cid_ciid.webp로 대체한다', async t => {
  for (const failure of [true, false]) {
    images.resetIndexCache();
    const mock = t.mock.method(global, 'fetch', async () => {
      if (failure) throw new Error('offline');
      return { ok: true, json: async () => ({ files: {} }) };
    });
    const requests = [];
    const result = await images.preload('4007', 15, { createImage: () => fakeImage(requests, () => true) });
    assert.equal(result.status, 'loaded');
    assert.equal(requests.length, 1);
    assert.match(requests[0], /4007_15.webp/);
    mock.mock.restore();
  }
});

test('서버 이미지까지 실패해도 거부된 promise 대신 실패 상태를 반환한다', async t => {
  images.resetIndexCache();
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ files: {} }) }));
  const result = await images.preload('4007', 1, { createImage: () => fakeImage([], () => false) });
  assert.deepEqual(result, { status: 'error', url: null });
});

test('모모바코 응답이 멈추면 제한 시간 후 서버 이미지로 전환한다', async t => {
  images.resetIndexCache();
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ files: {
    '4007_1': { sourceImageId: '89631139' },
  } }) }));
  const requests = [];
  const result = await images.preload('4007', 1, { timeoutMs: 5, createImage: () => ({
    set src(url) {
      requests.push(url);
      if (url.startsWith('/api/illustrations/')) queueMicrotask(() => this.onload?.());
    }
  }) });
  assert.equal(result.status, 'loaded');
  assert.equal(requests.length, 2);
});

test('카드 CID만 확정되어도 인덱스의 실제 CIID 이미지를 미리 요청한다', async t => {
  images.resetIndexCache();
  const requests = [];
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ files: {
    '4007_1': {}, '4007_15': {}, '4008_1': {},
  } }) }));
  const original = global.Image;
  global.Image = function () { return fakeImage(requests, () => true); };
  t.after(() => { if (original) global.Image = original; else delete global.Image; });
  await images.preloadCard('4007');
  assert.equal(requests.length, 2);
  assert.ok(requests.some(url => url.includes('4007_15.webp')));
  assert.ok(requests.every(url => !url.includes('4008')));
});
