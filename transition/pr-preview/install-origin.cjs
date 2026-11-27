'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const server = path.join(__dirname, 'server.cjs');
const source = readFileSync(server, 'utf8');
const prologue = "'use strict';\n";
const oldCheck = "if (!allowed.includes(req.headers.origin)) return json(403,{success:false,code:'ORIGIN_DENIED'});";
if (!source.startsWith(prologue) || source.split(oldCheck).length !== 2
    || !source.includes('createPreviewInventoryDatabase(config,process.env.TRANSITION_PREVIEW_INVENTORY_DB)')) {
  throw Error('미리보기 API 기준 이미지의 출처 검증 코드를 확인해 주세요.');
}
const newCheck = `if (!allowed.includes(req.headers.origin)
            && !allowsPrPreviewOrigin(req.headers.origin, config, Boolean(previewInventoryDatabase))) {
          return json(403,{success:false,code:'ORIGIN_DENIED'});
        }`;
writeFileSync(server, source
  .replace(prologue, prologue + "const { allowsPrPreviewOrigin } = require('./origin.cjs');\n")
  .replace(oldCheck, newCheck));
