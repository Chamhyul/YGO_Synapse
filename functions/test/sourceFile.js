'use strict';
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../services/card-service/manifest.json');
const moved = new Set(manifest.modules);
const functions = path.resolve(__dirname, '..');
// VM 합성 검사는 호환 래퍼 대신 실제 카드 구현을 읽는다. 모의 의존성 키는 유지한다.
function readSourceFile(filename, ...options) {
  const relative = path.relative(functions, filename).split(path.sep).join('/');
  return fs.readFileSync(moved.has(relative)
    ? path.join(functions, 'services/card-service', relative) : filename, ...options);
}
module.exports = { readSourceFile };
