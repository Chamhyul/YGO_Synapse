'use strict';
// 설치된 패키지의 라이선스 표기·원문을 모은다. 네트워크나 자격증명에 접근하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = process.cwd();
const output = process.argv[2];
if (!output) throw Error('출력 폴더가 필요합니다.');
const inventories = [], texts = new Map();
for (const relative of ['package-lock.json', 'functions/package-lock.json']) {
  const lockPath = path.join(root, relative);
  if (!fs.existsSync(lockPath)) continue;
  const lock = JSON.parse(fs.readFileSync(lockPath)), base = path.dirname(lockPath);
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    const dir = path.join(base, location), packageFile = path.join(dir, 'package.json');
    const installed = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile)) : null;
    const legalFiles = [];
    if (installed?.version === entry.version) for (const file of fs.readdirSync(dir).sort()) {
      const nativeManifest = installed.name?.startsWith('@img/sharp-libvips-') && /^(README\.md|versions\.json)$/i.test(file);
      if ((!nativeManifest && !/^(licen[sc]e|copying|notice|third[-_]?party[-_]?notices)([._-].*)?$/i.test(file)) || !fs.statSync(path.join(dir, file)).isFile()) continue;
      const data = fs.readFileSync(path.join(dir, file));
      const sha256 = createHash('sha256').update(data).digest('hex');
      texts.set(sha256, data.toString('utf8'));
      legalFiles.push({ file, sha256 });
    }
    inventories.push({ lockfile: relative, path: location, name: installed?.name || location.split('node_modules/').at(-1),
      version: entry.version, license: installed?.license || entry.license || installed?.licenses?.map(item => item.type).join(' OR ') || 'UNRESOLVED',
      optional: !!entry.optional, dev: !!entry.dev, installed: installed?.version === entry.version, legalFiles });
  }
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'dependencies.json'), JSON.stringify({ format: 1, packages: inventories }, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'dependency-license-texts.txt'), [...texts].sort(([a], [b]) => a.localeCompare(b))
  .map(([hash, text]) => 'SHA-256: ' + hash + '\n' + text).join('\n\n'));
console.log(`의존성 ${inventories.length}개, 고지 원문 ${texts.size}개. 미설치·원문 미수집은 목록에서 별도 표시합니다.`);
