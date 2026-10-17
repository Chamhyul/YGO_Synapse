'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportCompat } = require('../tools/export-compat.cjs');
test('독립 카드 폴더에서 버전·원본 해시가 고정된 호환 패키지를 재현하고 변조·미등록 파일을 거부한다', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'card-compat-'));
  try {
    exportCompat(output, true); exportCompat(output);
    const release = JSON.parse(fs.readFileSync(path.join(output, 'release.json')));
    assert.equal(release.version, require('../package.json').version);
    assert.match(release.sourceSha256, /^[a-f0-9]{64}$/);
    fs.appendFileSync(path.join(output, 'services/cardQueryService.js'), '\n// modified');
    assert.throws(() => exportCompat(output), /불일치/);
    exportCompat(output, true);
    fs.writeFileSync(path.join(output, 'unknown.txt'), 'preserve');
    assert.throws(() => exportCompat(output, true), /미등록/);
    assert.equal(fs.readFileSync(path.join(output, 'unknown.txt'), 'utf8'), 'preserve');
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});
