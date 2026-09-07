const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('./sync_card_illustrations');

test('Momobako metadata에서 이미지 식별자와 변경 정보를 추출한다', () => {
  const entries = sync.parseMetadata([
    '46986414.webp:155282,1766990124,c0db487a5a36ece9d7ca4b0248bab32a',
    '46986415.webp:155283,1766990125,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'invalid',
  ].join('\n'));
  assert.equal(entries.size, 2);
  assert.deepEqual(entries.get('46986415'), {
    sourceImageId: '46986415', remoteSize: 155283, remoteMtime: 1766990125,
    remoteMd5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
});

test('정식 8자리 패스코드와 임시 9자리 ID를 구분한다', () => {
  assert.equal(sync.isOfficialPasscode('46986414'), true);
  assert.equal(sync.isOfficialPasscode('423705'), true);
  assert.equal(sync.isOfficialPasscode('483'), true);
  assert.equal(sync.isOfficialPasscode('0'), false);
  assert.equal(sync.isOfficialPasscode('100458001'), false);
  assert.equal(sync.isOfficialPasscode('1234567'), true);
  assert.equal(sync.isTemporaryPasscode('100458001'), true);
  assert.equal(sync.isTemporaryPasscode('46986414'), false);
  assert.equal(sync.isTemporaryPasscode('0'), false);
});

test('사용자가 확인한 미연결 268개를 토큰 원본으로 제외한다', () => {
  assert.equal(sync.TOKEN_SOURCE_IDS.size, 268);
  assert.equal(sync.TOKEN_SOURCE_IDS.has('19144623'), true);
  assert.equal(sync.TOKEN_SOURCE_IDS.has('77571455'), true);
});

test('기본 및 연속 대체 일러스트의 CIID를 계산한다', () => {
  assert.equal(sync.resolveCiid({ id: 46986414 }), 1);
  assert.equal(sync.resolveCiid({ id: 46986414, altart: 46986415 }), 2);
  assert.equal(sync.resolveCiid({ id: 46986414, altart: 46986431 }), 18);
  assert.throws(() => sync.resolveCiid({ id: 46986414, altart: 36996508 }), /INVALID_CIID_MAPPING/);
});

test('프로젝트 카드 문서에서 펜듈럼 속성을 판별한다', () => {
  assert.equal(sync.isPendulumDocument({ info: { properties: ['Effect', 'Pendulum'] } }), true);
  assert.equal(sync.isPendulumDocument({ info: { properties: ['Effect'] } }), false);
  assert.equal(sync.isPendulumDocument({}), false);
});

test('일반 및 펜듈럼 중앙 이미지 URL을 생성한다', () => {
  assert.equal(sync.buildArtworkUrl('46986414', false),
    'https://cdn.233.momobako.com/ygopro/pics/46986414.jpg!art');
  assert.equal(sync.buildArtworkUrl('16178681', true),
    'https://cdn.233.momobako.com/ygopro/pics/16178681.jpg!artp');
});

test('증분 후보는 신규, 변경, 대기 및 실패 항목만 포함한다', () => {
  const metadata = new Map([
    ['1', { sourceImageId: '1', remoteMd5: 'same' }],
    ['2', { sourceImageId: '2', remoteMd5: 'new' }],
    ['3', { sourceImageId: '3', remoteMd5: 'same' }],
    ['4', { sourceImageId: '4', remoteMd5: 'same' }],
  ]);
  const manifest = { files: {
    1: { remoteMd5: 'same', status: 'ready' },
    2: { remoteMd5: 'old', status: 'ready' },
    3: { remoteMd5: 'same', status: 'pending' },
    4: { remoteMd5: 'same', status: 'failed' },
  } };
  assert.deepEqual(sync.selectCandidates(metadata, manifest, {}).map(item => item.sourceImageId), ['2', '3', '4']);
});

test('JPEG SOF 구간에서 이미지 크기를 읽는다', () => {
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x01, 0x00,
    0x01, 0x00,
    0x03, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.deepEqual(sync.imageDimensions(jpeg), { format: 'jpeg', width: 256, height: 256 });
  assert.equal(sync.imageDimensions(Buffer.from('not image')), null);
});

test('Momobako 변환 응답인 VP8 WebP의 크기를 읽는다', () => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp.set([0x9d, 0x01, 0x2a], 23);
  webp.writeUInt16LE(290, 26);
  webp.writeUInt16LE(216, 28);
  assert.deepEqual(sync.imageDimensions(webp), { format: 'webp', width: 290, height: 216 });
});

test('CLI 안전 옵션을 파싱한다', () => {
  const options = sync.parseArgs(['--dry-run', '--full', '--ignore-etag', '--limit', '10', '--concurrency', '2', '--cid', '4041']);
  assert.equal(options.dryRun, true);
  assert.equal(options.full, true);
  assert.equal(options.limit, 10);
  assert.equal(options.concurrency, 2);
  assert.equal(options.cid, '4041');
  assert.equal(options.ignoreEtag, true);
});

test('Momobako ETag가 같으면 metadata 본문 없이 변경 없음으로 처리한다', async () => {
  const originalFetch = global.fetch;
  let receivedHeaders;
  global.fetch = async (_url, init) => {
    receivedHeaders = init.headers;
    return { status: 304 };
  };
  try {
    const result = await sync.fetchMetadata('"etag-value"');
    assert.equal(result.notModified, true);
    assert.equal(result.etag, '"etag-value"');
    assert.equal(receivedHeaders['If-None-Match'], '"etag-value"');
  } finally {
    global.fetch = originalFetch;
  }
});
