'use strict';
// 브라우저 테스트의 외부 글꼴·아이콘은 빌드 때만 받아 오프라인으로 제공한다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const directory = '/opt/browser-assets';
const manifest = {};
const hosts = new Set(['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);
async function cache(url) {
  if (manifest[url]) return;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname)) throw Error('허용되지 않은 테스트 자산 주소');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`테스트 자산 다운로드 실패: ${response.status}`);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const body = Buffer.from(await response.arrayBuffer());
  const filename = createHash('sha256').update(url).digest('hex');
  fs.writeFileSync(path.join(directory, filename), body);
  manifest[url] = { filename, contentType };
  if (contentType.includes('text/css')) {
    for (const match of body.toString('utf8').matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
      if (!match[1].startsWith('data:')) await cache(new URL(match[1], url).href);
    }
  }
}
(async () => {
  fs.mkdirSync(directory, { recursive: true });
  await cache('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');
  await cache('https://fonts.googleapis.com/icon?family=Material+Icons');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  console.log(`오프라인 브라우저 자산 ${Object.keys(manifest).length}개 준비 완료`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
