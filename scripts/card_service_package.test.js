'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../functions/services/card-service/manifest.json');
const root = path.resolve(__dirname, '..');
const packaged = path.join(root, 'functions/services/card-service');

test('카드 패키지의 상대 의존성은 카드 모듈 또는 명시된 호스트 어댑터로 닫힌다', () => {
  const allowed = new Set([...manifest.modules, ...manifest.hostBindings]);
  for (const file of manifest.modules) {
    const source = fs.existsSync(path.join(root, 'card-service/src')) ? path.join(root, 'card-service/src') : packaged;
    const code = fs.readFileSync(path.join(source, file), 'utf8');
    assert.equal(fs.readFileSync(path.join(packaged, file), 'utf8'), code, file);
    for (const match of code.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])) + '.js';
      assert.ok(allowed.has(dependency), `${file}: 미등록 상대 의존성 ${dependency}`);
    }
  }
  assert.deepEqual(manifest.hostBindings, ['config/cardPaths.js', 'config/firebase.js',
    'services/adminActionTransport.js', 'services/cardApiAccessRepository.js', 'services/cardReadClient.js', 'services/publicReadTransport.js', 'utils/auth.js']);
});

test('기존 Functions import와 카드 패키지 import는 같은 모듈 인스턴스를 반환한다', () => {
  for (const file of ['services/cardPresentation.js', 'services/publicCardContract.js',
    'utils/cardSchema.js', 'utils/text.js']) {
    assert.equal(require(path.join(root, 'functions', file)), require(path.join(packaged, file)), file);
  }
});

test('사진 검색의 로컬 모델과 일러스트 경로는 폴더 분리 전 위치를 유지한다', () => {
  const paths = require('../functions/config/cardPaths');
  assert.equal(paths.modelDir, path.join(root, 'data/models'));
  assert.equal(paths.illustrationManifest, path.join(root, 'data/illustration-sync/manifest.json'));
  const source = fs.readFileSync(path.join(packaged, 'services/draw2CardClassifierService.js'), 'utf8');
  assert.ok(source.includes("require('../config/cardPaths')"));
  assert.ok(!source.includes('path.resolve(__dirname'));
});
