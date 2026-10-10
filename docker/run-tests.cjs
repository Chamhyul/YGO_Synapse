'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = ['functions/test', 'scripts'].flatMap(directory => fs.readdirSync(directory)
  .filter(name => name.endsWith('.test.js') && !name.endsWith('.browser.test.js'))
  .sort().map(name => `${directory}/${name}`));
console.log(`서버·클라이언트·도구 테스트 ${files.length}개 파일을 실행합니다. 브라우저 검사는 browser-tests에서 실행합니다.`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
