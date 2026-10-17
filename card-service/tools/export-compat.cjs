'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
function files(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error('패키지 심볼릭 링크는 허용하지 않습니다.');
    return entry.isDirectory() ? files(path.join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name];
  });
}
function exportCompat(output, write = false) {
  const manifest = require('../manifest.json');
  const source = path.join(root, 'src'), expected = new Map();
  const unlisted = files(source).filter(file => !manifest.modules.includes(file));
  if (unlisted.length) throw Error('카드 원본의 미등록 파일: ' + unlisted.join(', '));
  for (const file of manifest.modules) expected.set(file, fs.readFileSync(path.join(source, file)));
  const sourceDigest = digest(JSON.stringify([...expected].map(([file, data]) => [file, digest(data)]).concat([
    ['manifest.json', digest(JSON.stringify(manifest))],
  ])));
  for (const file of manifest.hostBindings) {
    const relative = path.posix.relative(path.posix.dirname('functions/services/card-service/' + file), 'functions/' + file);
    expected.set(file, Buffer.from(`// 기존 서비스의 인증·설정 어댑터. 카드 원본에 사용자 구현을 복제하지 않습니다.\nmodule.exports = require(${JSON.stringify(relative)});\n`));
  }
  expected.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  expected.set('release.json', Buffer.from(JSON.stringify({ format: 1, package: 'ygo-card-service',
    version: require('../package.json').version, sourceSha256: sourceDigest, readApiVersion: 1 }, null, 2) + '\n'));
  expected.set('content-sha256.json', Buffer.from(JSON.stringify(Object.fromEntries([...expected]
    .map(([file, data]) => [file, digest(data)])), null, 2) + '\n'));
  const stale = files(output).filter(file => !expected.has(file));
  if (stale.length) throw Error('미등록 출력 파일을 보존합니다: ' + stale.join(', '));
  const changed = [...expected].filter(([file, data]) => !fs.existsSync(path.join(output, file)) || !fs.readFileSync(path.join(output, file)).equals(data));
  if (!write && changed.length) throw Error('카드 패키지 불일치: ' + changed.map(([file]) => file).join(', '));
  if (write) for (const [file, data] of changed) {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true }); fs.writeFileSync(path.join(output, file), data);
  }
  console.log(`카드 원본 ${manifest.modules.length}개, 호스트 어댑터 ${manifest.hostBindings.length}개: ${write ? '동기화' : '대조'} 완료 (${sourceDigest})`);
}
if (require.main === module) {
  const index = process.argv.indexOf('--output');
  if (index < 0 || !process.argv[index + 1]) throw Error('--output으로 호환 패키지 폴더를 지정해야 합니다.');
  exportCompat(path.resolve(process.argv[index + 1]), process.argv.includes('--write'));
}
module.exports = { exportCompat };
