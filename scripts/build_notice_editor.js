// 공지 페이지에서만 사용하는 자체 호스팅 Tiptap 번들.
const { buildSync } = require('esbuild');
buildSync({entryPoints:['scripts/admin_notice_editor.js'],bundle:true,format:'iife',globalName:'NoticeEditor',outfile:'public/vendor/notice-editor.js',minify:true,target:['es2020'],legalComments:'linked'});
