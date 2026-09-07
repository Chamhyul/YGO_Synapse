const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const upload = require('./upload_card_illustrations');

test('업로드 CLI는 기본적으로 dry-run이며 --apply를 명시해야 쓴다', () => {
  assert.equal(upload.parseArgs([]).apply, false);
  const options = upload.parseArgs(['--apply', '--limit', '3', '--concurrency', '2']);
  assert.equal(options.apply, true);
  assert.equal(options.limit, 3);
  assert.equal(options.concurrency, 2);
});

test('서비스 이미지 파일명만 허용한다', () => {
  assert.equal(upload.isTargetName('4007_1.webp'), true);
  assert.equal(upload.isTargetName('4041_18.webp'), true);
  assert.equal(upload.isTargetName('4007_0.webp'), false);
  assert.equal(upload.isTargetName('token.webp'), false);
  assert.equal(upload.isTargetName('4007_1.jpg'), false);
});

test('매니페스트에서 CID/ciid와 Momobako 원본 ID 대응표를 만든다', () => {
  const index = upload.buildSourceIndex({ files: {
    89631139: {
      status: 'ready', cid: '4007', ciid: 1, target: '4007_1.webp', transform: 'art', localSha256: 'a',
    },
    16178681: {
      status: 'ready', cid: '11213', ciid: 1, target: '11213_1.webp', transform: 'artp', localSha256: 'b',
    },
    19144623: { status: 'pending', reason: 'TOKEN_PLACEHOLDER' },
  } }, 'public/resources/illustrations');

  assert.deepEqual(index.files['4007_1'], {
    sourceImageId: '89631139', cid: '4007', ciid: 1, transform: 'art', cdnAvailable: true,
    storagePath: 'public/resources/illustrations/4007_1.webp', contentSha256: 'a',
  });
  assert.equal(index.files['11213_1'].transform, 'artp');
  assert.equal(index.files['19144623_1'], undefined);
});

test('원격에서 사라진 원본은 Storage 대체 소스로 유지한다', () => {
  const index = upload.buildSourceIndex({ files: {
    123: {
      status: 'sourceMissing', cid: '10', ciid: 2, target: '10_2.webp', transform: 'art', localSha256: 'hash',
    },
  } }, 'public/resources/illustrations');
  assert.equal(index.files['10_2'].cdnAvailable, false);
  assert.equal(index.files['10_2'].sourceMissing, true);
});

test('원격 인덱스와 해시가 다른 로컬 파일만 업로드 대상으로 고른다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'illustration-upload-test-'));
  try {
    fs.writeFileSync(path.join(directory, '1_1.webp'), 'one');
    fs.writeFileSync(path.join(directory, '2_1.webp'), 'two');
    const local = { files: {
      '1_1': { storagePath: 'public/resources/illustrations/1_1.webp', contentSha256: 'same' },
      '2_1': { storagePath: 'public/resources/illustrations/2_1.webp', contentSha256: 'new' },
      '3_1': { storagePath: 'public/resources/illustrations/3_1.webp', contentSha256: 'missing-local' },
    } };
    const remote = { files: {
      '1_1': { contentSha256: 'same' },
      '2_1': { contentSha256: 'old' },
    } };
    assert.deepEqual(upload.selectUploadCandidates(local, remote, directory).map(item => item.key), ['2_1']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('같은 CID/ciid를 서로 다른 원본이 소유하면 인덱스 생성을 거부한다', () => {
  assert.throws(() => upload.buildSourceIndex({ files: {
    100: { status: 'ready', cid: '1', ciid: 1, target: '1_1.webp' },
    101: { status: 'ready', cid: '1', ciid: 1, target: '1_1.webp' },
  } }, 'public/resources/illustrations'), /중복 CID\/ciid/);
});

test('pHash 검색 인덱스가 표시 인덱스와 완전히 대응해야 한다', () => {
  const source = { files: {
    '1_1': { cid: '1', ciid: 1, contentSha256: 'sha-a' },
    '2_1': { cid: '2', ciid: 1, contentSha256: 'sha-b' },
  } };
  const valid = {
    schemaVersion: 1,
    algorithmVersion: 'test',
    files: {
      '1_1': { cid: '1', ciid: 1, phash: '0000000000000000', contentSha256: 'sha-a' },
      '2_1': { cid: '2', ciid: 1, phash: 'ffffffffffffffff', contentSha256: 'sha-b' },
    },
  };
  assert.doesNotThrow(() => upload.validateSearchIndex(source, valid));
  assert.throws(() => upload.validateSearchIndex(source, {
    ...valid, files: { '1_1': valid.files['1_1'] },
  }), /누락 1개/);
  assert.throws(() => upload.validateSearchIndex(source, {
    ...valid, files: { ...valid.files, '2_1': { ...valid.files['2_1'], contentSha256: 'old' } },
  }), /원본 해시 불일치/);
});
