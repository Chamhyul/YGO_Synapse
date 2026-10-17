'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = require('../card-service/manifest.json');
const output = path.join(root, 'functions/services/card-service');
for (const file of manifest.modules) {
  const target = path.join(root, 'functions', file);
  let relative = path.relative(path.dirname(target), path.join(output, file)).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  const bridge = `// 카드 원본: card-service/src/${file} (호환 패키지는 sync-card-service.cjs로 생성)\nmodule.exports = require(${JSON.stringify(relative)});\n`;
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== bridge) {
    console.error(`기존 Functions 호환 연결 불일치: ${file}`);
    process.exit(1);
  }
}
require('../card-service/tools/export-compat.cjs').exportCompat(output, process.argv.includes('--write'));
