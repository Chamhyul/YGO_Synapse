'use strict';
const path = require('node:path');
// 소스 위치가 바뀌어도 기존 로컬 모델·일러스트 입력 경로를 유지한다.
module.exports = Object.freeze({
  modelDir: path.resolve(__dirname, '../../data/models'),
  illustrationManifest: path.resolve(__dirname, '../../data/illustration-sync/manifest.json'),
});
