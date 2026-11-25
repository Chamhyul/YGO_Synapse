'use strict';
const { readPublicNotices } = require('./notices.cjs');
const http = require('node:http');
const { promisify } = require('node:util');
const { gzip, brotliCompress, constants } = require('node:zlib');
const { readFile } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const gzipJson = promisify(gzip);
const brotliJson = promisify(brotliCompress);
const jsonBrotliOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };
function selectJsonEncoding(header = '') {
  const qualities = new Map();
  for (const encoding of header.split(',')) {
    const [name, ...params] = encoding.trim().toLowerCase().split(';');
    const weight = params.find(param => /^\s*q\s*=/.test(param));
    const quality = weight === undefined ? 1 : Number(weight.split('=')[1]);
    qualities.set(name.trim(), quality > 0 && quality <= 1 ? quality : 0);
  }
  const quality = name => qualities.get(name) ?? qualities.get('*') ?? 0;
  const br = quality('br'), gz = quality('gzip');
  if (br > 0 && br >= gz) return 'br';
  return gz > 0 ? 'gzip' : null;
}
const cardDetailTtlMs = 30_000;
const cardDetailMaxEntries = 128;
const cardDetailMaxBytes = 2 * 1024 * 1024;

function createCardDetailCache(readCard, now) {
  const cached = new Map();
  const pending = new Map();
  let cachedBytes = 0;

  return async (cid, locale) => {
    const key = `${cid}:${locale}`;
    const entry = cached.get(key);
    if (entry) {
      cached.delete(key);
      if (now() < entry.expiresAt) {
        cached.set(key, entry);
        return entry.body;
      }
      cachedBytes -= entry.body.length;
    }

    let request = pending.get(key);
    if (!request) {
      request = (async () => {
        const card = await readCard(cid, locale);
        const body = Buffer.from(JSON.stringify({ success: true, card }));
        if (body.length <= cardDetailMaxBytes) {
          cached.set(key, { body, expiresAt: now() + cardDetailTtlMs });
          cachedBytes += body.length;
          while (cached.size > cardDetailMaxEntries || cachedBytes > cardDetailMaxBytes) {
            const [oldest, value] = cached.entries().next().value;
            cached.delete(oldest);
            cachedBytes -= value.body.length;
          }
        }
        return body;
      })().finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return request;
  };
}
const { configuration } = require('./config.cjs');
const { createDatabase } = require('./db.cjs');
const { createAuthentication } = require('./auth.cjs');
const { accountView } = require('./account.cjs');
const { createRepository } = require('./repository.cjs');
const { encodeCatalogRows } = require('./catalog-wire.cjs');
const { MAX_IMPORT_BYTES, validSheetId, readPublicSheet, importIdentity, digestImport, importResultView } = require('./inventory-import.cjs');
const { contentSecurityPolicy } = require('./public-assets.cjs');
const { createDeckSource,validatePhoto,analyzePhoto,photoBodyLimit } = require('./registration-sources.cjs');
const { createMembershipVerification } = require('./membership-verification.cjs');
const { createMembershipProviders } = require('./membership-providers.cjs');
const assets = { '/':['index.html','text/html; charset=utf-8'], '/index.html':['index.html','text/html; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'],
  '/tokens.css':['tokens.css','text/css; charset=utf-8'], '/favicon.png':['favicon.png','image/png'] };
const errors = new Set(['UNAUTHORIZED','ACCOUNT_UNAVAILABLE','NOT_FOUND','INVALID_QUERY','INVALID_COMMAND','INVALID_LOCATION','REGISTRATION_REQUIRED',
  'IDEMPOTENCY_CONFLICT','INSUFFICIENT_QUANTITY','SAME_LOCATION','LOCATION_NOT_FOUND','VARIANT_UNAVAILABLE','UNRESOLVED_ITEM','DEMO_BUSY',
  'CONSENT_VERSION_CHANGED','IMPORT_REQUEST_INVALID','IMPORT_REQUEST_CONFLICT','IMPORT_RETRY_UNAVAILABLE',
  'IMPORT_REQUEST_CANCELLED','IMPORT_REQUEST_PENDING','INVENTORY_GENERATION_CHANGED','INVENTORY_REVISION_CHANGED','SHEET_CHANGED','QUANTITY_LIMIT',
  'APPCHECK_REQUIRED','APPCHECK_INVALID','INVALID_IMPORT','PACK_UNAVAILABLE','DECK_UNAVAILABLE','INVALID_PHOTO',
  'MEMBERSHIP_PROVIDER_UNAVAILABLE','MEMBERSHIP_TOO_MANY_REQUESTS','MEMBERSHIP_VERIFICATION_EXPIRED','MEMBERSHIP_ROSTER_CHANGED','DISCORD_REDIRECT_INVALID']);
const importMessages = {
  IMPORT_REQUEST_CANCELLED: '이전 가져오기는 취소되었습니다. 새 시도로 다시 진행해 주세요.',
  IMPORT_REQUEST_PENDING: '이전 가져오기 저장 결과를 확인 중입니다. 새 작업으로 다시 제출하지 마세요.',
  INVENTORY_GENERATION_CHANGED: '보유 카드가 초기화되었습니다. 다시 확인해 주세요.',
  SHEET_CHANGED: '확인한 이후 시트가 변경되었습니다. 시트를 다시 확인해 주세요.',
  INVALID_IMPORT: '가져올 카드 데이터나 시트 ID를 확인해 주세요.',
  PACK_UNAVAILABLE: '수록 목록이 확정된 팩을 찾을 수 없습니다.',
  DECK_UNAVAILABLE: '덱 정보를 가져오지 못했습니다.',
  INVALID_PHOTO: '분석할 카드 사진을 확인해 주세요.',
};
// 기존 가입 API와 같은 공개 문서의 SHA-256을 사용한다.
const consentVersions = Object.freeze({
  terms: 'a189fde0dce4ec14f7ae6b8b495674e42b455f1d453d785084ffd5a083dca7ca',
  privacy: '227208e70b6de548fd8e081b50a0b01dd2adc6537d3c8d05fa80e60879ada2e8',
});
const importStatusPaths = new Set(['/api/v2/migrateFromData', '/api/v2/migrateFromSheet']);
function validateBodyHeaders(req, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(Error('INVALID_COMMAND'), { status: 415 });
  if (Number(req.headers['content-length']) > maxBytes) throw Object.assign(Error('INVALID_COMMAND'), { status: 413 });
}
async function readBody(req, maxBytes = 16384) {
  validateBodyHeaders(req, maxBytes);
  const chunks=[];let length=0;
  for await (const chunk of req) { length += chunk.length; if (length > maxBytes) throw Object.assign(Error('INVALID_COMMAND'), { status: 413 }); chunks.push(chunk); }
  try { const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body; }
  catch (_) { throw Object.assign(Error('INVALID_COMMAND'), { status: 400 }); }
}
function createServer({ config, database, authentication, repository, loadNotices = readPublicNotices, readSheet = readPublicSheet,
  deckSource=createDeckSource(), classifyPhoto=analyzePhoto, membershipWriter, cardDetailNow=()=>performance.now() } = {}) {
  config ||= configuration(); database ||= createDatabase(config.databaseUrl, config.poolMax, config.databaseRole, {prepareCatalog:true});
  authentication ||= createAuthentication(config); repository ||= createRepository(database);
  const readCardDetail = createCardDetailCache((cid, locale) => repository.card(cid, locale), cardDetailNow);
  const membershipVerification=membershipWriter ? createMembershipVerification({
    ...membershipWriter, enqueueClaims:authentication.enqueueMembershipClaims,
  }) : null;
  const membershipSelect='select provider,status,level_name,provider_account_id from app.user_memberships where user_id=$1';
  async function readAccount(uid, { registered = false, compact=false, timing=(_name,work)=>work(),onTiming } = {}) {
    if (!registered && !await repository.registrationStatus(uid)) throw Object.assign(Error('REGISTRATION_REQUIRED'), {status:403});
    const row = await timing('membership_read',async()=>membershipWriter ? compact&&typeof membershipWriter.database.readUser==='function'
      ? (await membershipWriter.database.readUser(uid,membershipSelect,{onTiming,timingPrefix:'membership_db'})).rows[0]
      : await membershipWriter.database.withUser(uid, async client =>
      (await timing('membership_db_sql',()=>client.query(membershipSelect,[uid]))).rows[0], {readOnly:true,onTiming,timingPrefix:'membership_db'})
      : config.mode === 'demo' ? await repository.membershipStatus(uid).then(value => value.status === 'unknown' ? undefined :
        {provider:value.provider,status:value.status,level_name:value.levelName})
        : (() => { throw Object.assign(Error('ACCOUNT_UNAVAILABLE'),{status:503}); })());
    const account = await timing('auth_account',()=>authentication.currentAccount(uid));
    return accountView(account,row,{demo:config.mode === 'demo'});
  }
  const servedAssets={...assets};
  try { const manifest=JSON.parse(readFileSync(path.join(config.webRoot,'asset-manifest.json'),'utf8'));
    for(const file of manifest.files){if(!/^[\w./-]+$/.test(file.name)||file.name.split('/').includes('..'))throw Error('잘못된 자산 경로');servedAssets['/'+file.name]=[file.name,file.type];}
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  let artworkStorage;
  const demoRequests = [];
  const server = http.createServer(async (req, res) => {
    const start = performance.now(), phases=Object.create(null);
    const onTiming=(name,ms)=>{if(/^(db|membership_db)_(acquire|connect|prepare|pool_wait|begin|uid|commit|rollback|read_batch)$/.test(name)&&Number.isFinite(ms)&&ms>=0)phases[name]=(phases[name]||0)+ms;};
    const timed=async(name,work)=>{const at=performance.now();try{return await work();}finally{phases[name]=(phases[name]||0)+performance.now()-at;}};
    const serverTiming=()=>[`api;dur=${(performance.now()-start).toFixed(1)}`,...Object.entries(phases).map(([name,ms])=>`${name};dur=${ms.toFixed(1)}`)].join(',');
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy('/'));
    const json = (status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Server-Timing':serverTiming() }); res.end(JSON.stringify(value)); };
    const catalogJson = async (value, { compressSmall = false } = {}) => {
      const jsonStarted=performance.now();
      let body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      phases.json=performance.now()-jsonStarted;
      res.appendHeader('Vary', 'Accept-Encoding');
      const encoding = (compressSmall || body.length >= 1024) && selectJsonEncoding(req.headers['accept-encoding']);
      if (encoding) body = await timed('compression',()=>encoding === 'br'
        ? brotliJson(body, jsonBrotliOptions)
        : gzipJson(body, { level: 3 }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(encoding ? { 'Content-Encoding': encoding } : {}),
        'Content-Length': body.length,
        'Server-Timing': serverTiming(),
      });
      return res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const endpoint = url.pathname;
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(endpoint));
      if (req.method === 'GET' && endpoint === '/healthz') { await database.ready(); return json(200,{success:true,service:'synapse-transition',environment:config.environment,authMode:config.mode}); }
      if(req.method==='GET'&&endpoint==='/api/v2/full-crawl/status'){
        if(!config.artworkBucket)return json(404,{success:false,code:'NOT_FOUND'});
        artworkStorage ||=new(require('@google-cloud/storage').Storage)();let value;
        try{value=JSON.parse((await artworkStorage.bucket(config.artworkBucket).file('system/catalog-crawl/full-20261030/state.json').download())[0]);}
        catch(error){if(error.code===404)return json(404,{success:false,code:'NOT_FOUND'});throw error;}
        const {id,status,phase,catalogCounts,localeIndex,packIndex,currentPack,counts,createdAt,updatedAt,finishedAt,reason}=value;
        const recovery=value.recovery?Object.fromEntries(['id','locale','total','index','resolved','remainingIssues','pendingPacks','finishedAt'].filter(k=>value.recovery[k]!==undefined).map(k=>[k,value.recovery[k]])):undefined;
        return json(200,{success:true,id,status,phase,catalogCounts,localeIndex,packIndex,currentPack,counts,recovery,createdAt,updatedAt,finishedAt,reason});
      }
      const artwork=/^\/api\/v2\/artwork-sources\/([1-9]\d{0,17})\.webp$/.exec(endpoint);
      if(req.method==='GET'&&artwork){
        const selected=(await database.pool.query('select cid,image_ciid,image_variant from catalog.artwork_sources where id=$1',[artwork[1]])).rows[0];
        if(!selected?.image_ciid||!['base','jp'].includes(selected.image_variant))return json(404,{success:false,code:'IMAGE_LINK_UNCONFIRMED'});
        if(!config.artworkBucket)return json(503,{success:false,code:'ARTWORK_UNAVAILABLE'});
        artworkStorage ||= new(require('@google-cloud/storage').Storage)();
        const object='private/illustrations/'+selected.cid+'_'+selected.image_ciid+(selected.image_variant==='jp'?'_jp':'')+'.webp';
        let body;try{[body]=await artworkStorage.bucket(config.artworkBucket).file(object).download();}catch(error){if(error.code===404)return json(404,{success:false,code:'IMAGE_NOT_FOUND'});throw error;}
        res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'private,no-store'});return res.end(body);
      }
      if (req.method === 'GET' && servedAssets[endpoint]) {
        const [file,type] = servedAssets[endpoint];
        const body = await readFile(path.join(config.webRoot,file)); res.writeHead(200,{'Content-Type':type}); return res.end(body);
      }
      const initialLoginRead=endpoint==='/api/v2/registration' && url.searchParams.get('includeUserData')==='true'
        && url.searchParams.get('initialView')==='inventory-v1';
      if (req.headers.origin) {
        const allowed = (process.env.TRANSITION_ALLOWED_ORIGINS || 'http://127.0.0.1:5005,http://localhost:5005').split(',');
        if (!allowed.includes(req.headers.origin)) return json(403,{success:false,code:'ORIGIN_DENIED'});
        res.setHeader('Access-Control-Allow-Origin',req.headers.origin); res.setHeader('Vary','Origin');
        if(initialLoginRead){res.setHeader('Timing-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Expose-Headers','Server-Timing');}
      }
      if (req.method === 'OPTIONS') {
        if(initialLoginRead && req.headers['access-control-request-method']==='GET'){
          res.setHeader('Access-Control-Max-Age','600');res.appendHeader('Vary','Access-Control-Request-Method, Access-Control-Request-Headers');
        }
        res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Firebase-AppCheck'});return res.end();
      }
      // 공개 준비 요청에도 기존 허용 Origin 정책을 적용한다. 응답은 인증·DB 접근 권한이 아니다.
      if (req.method === 'GET' && endpoint === '/api/v2/environment') return json(200,{success:true,environment:config.environment,authMode:config.mode,nameAutocompleteContinuation:true,
        ...(config.environment==='production'&&config.mode==='firebase'?{loginReadDirectVersion:1}:{}),
        membershipProviders:Object.keys(membershipWriter?.providers || {})});
      if (endpoint === '/api/v2/notices') return req.method === 'GET' ? json(200, await loadNotices()) : json(405, {success:false,code:'METHOD_NOT_ALLOWED'});
      if (req.method === 'POST' && endpoint === '/api/v2/demo/session' && config.mode === 'demo') {
        const body = await readBody(req); if (Object.keys(body).length) return json(400,{success:false,code:'INVALID_COMMAND'});
        const now=Date.now(); while(demoRequests.length && demoRequests[0]<now-60000) demoRequests.shift();
        if (demoRequests.length >= 20) return json(429,{success:false,code:'DEMO_BUSY'}); demoRequests.push(now);
        const session=authentication.createDemoSession(); const data=await repository.createDemo(session.uid);
        return json(201,{success:true,token:session.token,expiresAt:session.expiresAt,...data});
      }
      if (req.method === 'GET' && endpoint === '/api/v2/catalog') return await catalogJson({success:true,cards:await repository.catalog(url.searchParams.get('q')||'',url.searchParams.get('locale')||'ko')});
      if (req.method==='POST' && endpoint==='/api/v2/catalog/inventory-batches') {
        await timed('appcheck',()=>authentication.verifyAppCheck(req.headers['x-firebase-appcheck']));
        const body=await readBody(req);
        const result=await timed('catalog_read',()=>repository.inventoryCardBatches(body,{cancelled:()=>req.aborted || res.destroyed,timing:timed}));
        if(req.aborted || res.destroyed)return;
        return await catalogJson({success:true,...result});
      }
      if (req.method === 'POST' && endpoint === '/api/v2/catalog/registration') {
        const body=await readBody(req);
        if(body.includeDetails===true)await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        return await catalogJson({success:true,...await repository.registrationCards(body)});
      }
      if (req.method === 'GET' && endpoint === '/api/v2/search') {
        const autocomplete=url.searchParams.get('mode')==='autocomplete';
        const continuation = autocomplete && url.searchParams.get('continuation') === '1';
        return await catalogJson({success:true,...await repository.search(url.searchParams.get('q')||'',url.searchParams.get('locale')||'ko',url.searchParams.get('after')||'0',Number(url.searchParams.get('limit')||50),{autocomplete,field:url.searchParams.get('field') ?? undefined,view:url.searchParams.get('view') ?? undefined,continuation})});
      }
      const card = /^\/api\/v2\/cards\/([1-9]\d{0,9})$/.exec(endpoint);
      if (req.method === 'GET' && card) {
        const locale = url.searchParams.get('locale') || 'ko';
        const body = await timed('catalog_read', () => readCardDetail(card[1], locale));
        if (req.aborted || res.destroyed) return;
        return await catalogJson(body);
      }
      if (req.method==='GET' && endpoint==='/api/v2/packs') {
        return json(200,{success:true,packs:await repository.findPacks(url.searchParams.get('name'))});
      }
      if (req.method==='GET' && endpoint==='/api/v2/packs/suggestions') {
        const names = await timed('pack_suggestions', () => repository.findPackSuggestions(url.searchParams.get('q') || ''));
        return json(200,{success:true,names});
      }
      const pack=/^\/api\/v2\/packs\/([a-z0-9-]{1,40})\/(cids|cards)$/i.exec(endpoint);
      if (req.method==='GET' && pack) {
        const result=await repository.packCards(pack[1],url.searchParams.get('locale')||'ko',{
          offset:Number(url.searchParams.get('offset')||0),summaryOnly:pack[2]==='cids',
        });
        const value = {success:true,...result};
        if (pack[2] === 'cards') return await catalogJson(value, { compressSmall: true });
        return json(200,value);
      }
      if (req.method==='GET' && ['/api/v2/searchDeck','/api/v2/getDeckCards'].includes(endpoint)) {
        if(config.mode==='demo')await authentication.verify(req.headers.authorization);
        else await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        const result=endpoint.endsWith('searchDeck')
          ? await deckSource.search(url.searchParams.get('deckCode'),url.searchParams.get('locale')||'ko')
          : await deckSource.cards(url.searchParams.get('url'));
        return json(200,result);
      }
      if (req.method==='POST' && endpoint==='/api/v2/searchCardByImage') {
        await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        const body=validatePhoto(await readBody(req,photoBodyLimit));
        try {
          return json(200,await classifyPhoto(body,req.headers));
        } catch(error) {
          const status=[400,401,403,429].includes(error.status)?error.status:503;
          return json(status,{success:false,message:status===401||status===403?'앱 인증을 확인해 주세요.':'사진 분석을 완료하지 못했습니다.'});
        }
      }
      const membershipAction=/^\/api\/v2\/membership\/(discord|youtube)\/(start|verify)$/.exec(endpoint);
      const protectedPath = ['/api/v2/bootstrap','/api/v2/locations','/api/v2/locations/delete','/api/v2/inventory/commands','/api/v2/preferences',
        '/api/v2/profile','/api/v2/registration','/api/v2/membership','/api/v2/clearUserData','/api/v2/checkSheet','/api/v2/inventory/add-batch'].includes(endpoint) || importStatusPaths.has(endpoint);
      if (!protectedPath && !membershipAction) return json(404,{success:false,code:'NOT_FOUND'});
      const registrationRead=endpoint==='/api/v2/registration' && req.method==='GET';
      const membershipWrite=req.method==='POST' && membershipAction;
      // 두 검증을 모두 통과한 요청만 DB에 접근한다.
      const [uid]=await Promise.all([timed('identity',()=>authentication.verify(req.headers.authorization)),
        ...(registrationRead || membershipWrite ? [timed('appcheck',()=>authentication.verifyAppCheck(req.headers['x-firebase-appcheck']))] : [])]);
      if (!membershipWrite && config.mode === 'firebase' && req.method === 'POST' && !await database.writesReady()) {
        return json(503,{success:false,code:'CUTOVER_WRITE_UNAVAILABLE'});
      }
      if (membershipWrite) {
        const gate=await repository.membershipWriteGate(uid);
        if (config.mode==='firebase' && !gate.ready) return json(503,{success:false,code:'CUTOVER_WRITE_UNAVAILABLE'});
        if (!membershipVerification) return json(503,{success:false,code:'MEMBERSHIP_PROVIDER_UNAVAILABLE'});
        if (!gate.registered) return json(403,{success:false,code:'REGISTRATION_REQUIRED'});
        const [,provider,action]=membershipAction;
        const body=await readBody(req);
        if (action === 'start') {
          const {redirectUri,...startBody}=body;
          const result=await membershipVerification.start(uid,provider,startBody,{redirectUri});
          return json(200,{success:true,uid,...result});
        }
        const prepareAccount=config.mode==='demo' ? async()=>async()=>{
          if (await authentication.verify(req.headers.authorization)!==uid) {
            throw Object.assign(Error('UNAUTHORIZED'),{status:401});
          }
          return authentication.currentAccount(uid);
        } : () => authentication.prepareMembershipAccount(req.headers.authorization,uid);
        const payload=({account,membershipRow})=>({success:true,uid,...accountView(account,membershipRow,{demo:config.mode==='demo'})});
        res.appendHeader('Vary','Accept');
        let committedResult;
        const onCommitted=req.headers.accept==='application/x-ndjson' ? result=>{
          if (res.destroyed || res.writableEnded) return;
          committedResult=payload(result);
          res.writeHead(200,{
            'Content-Type':'application/x-ndjson; charset=utf-8',
            'Cache-Control':'private, no-store, no-transform',
            'X-Accel-Buffering':'no',
            'Server-Timing':serverTiming(),
          });
          res.write(JSON.stringify({v:1,type:'result',result:committedResult})+'\n');
        } : undefined;
        const verified=await membershipVerification.verify(uid,provider,body,prepareAccount,{includeSource:true,onCommitted});
        // 응답을 열어 둔 채 권한 작업 접수를 마친다.
        if (committedResult) {
          if (!res.destroyed) res.end(JSON.stringify({v:1,type:'recorded',success:true,result:committedResult})+'\n');
          return;
        }
        return json(200,payload(verified));
      }
      if (req.method === 'GET' && endpoint === '/api/v2/membership') {
        return json(200,{success:true,...await readAccount(uid)});
      }
      if (endpoint === '/api/v2/registration') {
        if(!registrationRead)await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        if (req.method === 'GET') {
          const includeUserData=url.searchParams.get('includeUserData');
          const initialView=url.searchParams.get('initialView');
          if(initialView!==null&&(initialView!=='inventory-v1'||includeUserData!=='true'))throw Object.assign(Error('INVALID_QUERY'),{status:400});
          const includeInventoryCatalog=url.searchParams.get('includeInventoryCatalog');
          const inventoryLocale=url.searchParams.get('inventoryLocale')||'ko';
          const inventoryEncoding=url.searchParams.get('inventoryCatalogEncoding');
          if(inventoryEncoding!==null && inventoryEncoding!=='rows-v1')throw Object.assign(Error('INVALID_QUERY'),{status:400});
          if(!['ko','ja','ae','cn','en','de','fr','it','es','pt'].includes(inventoryLocale))throw Object.assign(Error('INVALID_QUERY'),{status:400});
          if(includeInventoryCatalog!==null && (!['true','false'].includes(includeInventoryCatalog) || includeInventoryCatalog==='true' && includeUserData!=='true'))throw Object.assign(Error('INVALID_QUERY'),{status:400});
          if(includeUserData!==null && !['true','false'].includes(includeUserData))throw Object.assign(Error('INVALID_QUERY'),{status:400});
          if(includeUserData==='true'){
            let data;
            try { data=await timed('inventory_read',()=>initialView==='inventory-v1'?repository.loginView(uid,inventoryLocale,{timing:timed,onTiming}):repository.bootstrap(uid,{timing:timed,onTiming})); }
            catch(error){
              if(error.message!=='REGISTRATION_REQUIRED' || error.status!==403)throw error;
              return json(200,{success:true,registered:false,consentVersions});
            }
            if(initialView==='inventory-v1'){
              const account=await readAccount(uid,{registered:true,compact:true,timing:timed,onTiming});
              if(req.aborted||res.destroyed)return;
              return await catalogJson({success:true,registered:true,consentVersions,initialView:{success:true,...data,...account}});
            }
            const catalogTask=includeInventoryCatalog==='true' ? timed('login_catalog',async()=>{
              const ids=[...new Set(data.items.map(item=>item.cid).filter(Boolean).map(String))].slice(0,100),groups=[];
              for(let offset=0;offset<ids.length;offset+=25)groups.push({index:groups.length,cids:ids.slice(offset,offset+25)});
              const value=groups.length ? await repository.inventoryCardBatches({locale:inventoryLocale,groups,wireFormat:'shared-rarities-v1'},
                {cancelled:()=>req.aborted||res.destroyed,timing:timed}) : {wireVersion:1,groups:[]};
              return inventoryEncoding==='rows-v1' ? {version:1,locale:inventoryLocale,wireVersion:1,rows:encodeCatalogRows(value.groups)} : {version:1,locale:inventoryLocale,...value};
            }) : Promise.resolve(undefined);
            const [account,inventoryCatalog]=await Promise.all([readAccount(uid,{registered:true,timing:timed,onTiming}),catalogTask]);
            if(req.aborted||res.destroyed)return;
            return await catalogJson({success:true,registered:true,consentVersions,initialData:{success:true,...data,...account,...(inventoryCatalog?{inventoryCatalog}: {})}});
          }
          const registered = await repository.registrationStatus(uid);
          return json(200, { success: true, registered, consentVersions });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (body.agreements?.terms !== true || body.agreements?.privacy !== true) {
            return json(400, { success: false, code: 'INVALID_COMMAND' });
          }
          if (body.consentVersions?.terms !== consentVersions.terms || body.consentVersions?.privacy !== consentVersions.privacy) {
            return json(409, { success: false, code: 'CONSENT_VERSION_CHANGED' });
          }
          await repository.completeRegistration(uid, consentVersions);
          return json(200, { success: true, registered: true });
        }
      }
      if (req.method === 'GET' && importStatusPaths.has(endpoint)) {
        const status = await repository.importStatus(uid, url.searchParams.get('importRequestId'), url.searchParams.get('importFingerprint'));
        if (status.result) status.result=importResultView(status.result);
        return json(200, { success: true, ...status });
      }
      if (req.method === 'GET' && endpoint === '/api/v2/checkSheet') {
        await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        const id = url.searchParams.get('targetId');
        if (!validSheetId(id)) return json(400,{success:false,code:'INVALID_IMPORT',message:'올바른 시트 ID가 필요합니다.'});
        try {
          const preview = await readSheet(id);
          return json(200,{status:'OK',sheetName:'MyCard',rowCount:preview.data.length,totalQty:preview.totalQty,
            skippedZeroCount:preview.skippedZeroCount,legacyQuantity:preview.legacyQuantity,fingerprint:preview.fingerprint});
        } catch (error) {
          if (error.code === 'INVALID_IMPORT') return json(200,{status:'INVALID_DATA',message:error.message});
          if (error.code === 'PUBLIC_SHEET_NO_ACCESS') return json(200,{status:'NO_ACCESS'});
          throw error;
        }
      }
      if (req.method === 'POST' && endpoint === '/api/v2/clearUserData') {
        await authentication.verifyAppCheck(req.headers['x-firebase-appcheck']);
        const body = await readBody(req);
        if (Object.keys(body).some(key=>key!=='requestId')) return json(400,{success:false,code:'INVALID_COMMAND'});
        return json(200,{success:true,...await repository.clearInventory(uid,body.requestId)});
      }
      if (req.method === 'POST' && importStatusPaths.has(endpoint)) {
        const source = endpoint.endsWith('Data') ? 'file' : 'sheet';
        const maxBytes = source === 'file' ? MAX_IMPORT_BYTES : 16384;
        const requestId = url.searchParams.get('importRequestId');
        const identity = importIdentity(uid,requestId,url.searchParams.get('importFingerprint'));
        const generation = url.searchParams.get('importGeneration');
        if (!/^(0|[1-9]\d{0,18})$/.test(generation ?? '') || BigInt(generation)>9223372036854775807n) {
          return json(400,{success:false,code:'IMPORT_REQUEST_INVALID'});
        }
        validateBodyHeaders(req,maxBytes);
        const prior = await repository.reserveImport(uid,identity,generation);
        const body = await readBody(req,maxBytes);
        if (body.importRequestId!==requestId || digestImport(source,body)!==identity.fingerprint) {
          return json(409,{success:false,code:'IMPORT_REQUEST_CONFLICT'});
        }
        const { result, applied } = prior ? {result:prior,applied:false}
          : await repository.importInventory(uid,source,body,identity,generation,readSheet);
        return json(200,importResultView(result,{delta:url.searchParams.get('inventoryView')==='delta',applied}));
      }
      if(req.method==='POST'&&endpoint==='/api/v2/preferences')return json(200,{success:true,preferences:await repository.preferences(uid,await readBody(req))});
      if(req.method==='POST'&&endpoint==='/api/v2/profile'){const body=await readBody(req);if(Object.keys(body).some(k=>k!=='nickname'))return json(400,{success:false,code:'INVALID_COMMAND'});return json(200,{success:true,profile:await repository.nickname(uid,body.nickname)});}
      if (req.method === 'GET' && endpoint === '/api/v2/bootstrap') {
        const data = await repository.bootstrap(uid);
        return await catalogJson({success:true,...data,...await readAccount(uid,{registered:true})});
      }
      if (req.method==='POST' && endpoint==='/api/v2/inventory/add-batch') {
        return json(200,{success:true,...await repository.addBatch(uid,await readBody(req,256*1024))});
      }
      if (req.method === 'POST' && endpoint === '/api/v2/locations') {
        const generation=await repository.inventoryGeneration(uid);
        const body=await readBody(req); if(Object.keys(body).some(k=>k!=='name'))return json(400,{success:false,code:'INVALID_COMMAND'});
        return json(201,{success:true,location:await repository.addLocation(uid,body.name,generation)});
      }
      if (req.method === 'POST' && endpoint === '/api/v2/locations/delete') {
        return json(200,{success:true,...await repository.deleteLocation(uid,await readBody(req))});
      }
      if (req.method === 'POST' && endpoint === '/api/v2/inventory/commands') {
        const generation=await repository.inventoryGeneration(uid);
        return json(200,{success:true,...await repository.command(uid,await readBody(req),generation)});
      }
      return json(405,{success:false,code:'METHOD_NOT_ALLOWED'});
    } catch (error) {
      if(req.aborted || res.destroyed)return;
      if(res.headersSent)return res.destroy();
      if (error.code === 'INVALID_IMPORT') return json(400,{success:false,code:error.code,message:error.message});
      if (error.code === 'PUBLIC_SHEET_NO_ACCESS') return json(403,{success:false,code:error.code,message:'공개·링크 공유 및 다운로드 허용 설정을 확인해 주세요.'});
      if (error.code === 'PUBLIC_SHEET_UNAVAILABLE') return json(503,{success:false,code:error.code,message:'시트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
      const quantity = error.code === '23514';
      const status = errors.has(error.message) || error.message === 'INVALID_COMMAND' ? error.status || 400 : quantity ? 409 : 503;
      return json(status,{success:false,code:quantity?'QUANTITY_LIMIT':errors.has(error.message)?error.message:'SERVICE_UNAVAILABLE',
        message:importMessages[error.message]});
    }
  });
  server.headersTimeout=15000; server.requestTimeout=20000;
  return { server, database, close: async()=>{ await new Promise(resolve=>server.close(resolve)); await database.close(); } };
}
if (require.main === module) {
  const config=configuration();
  const writer=config.membershipDatabaseUrl ? createDatabase(config.membershipDatabaseUrl,2,undefined,{prepareMembership:true}) : null;
  const membershipWriter=writer ? {database:writer,providers:createMembershipProviders({database:writer,discord:config.discord})} : undefined;
  const app=createServer({config,membershipWriter});
  async function ready(){
    await app.database.ready();
    if(writer){
      const {rows:[role]}=await writer.pool.query(`select rolsuper,rolbypassrls,
        pg_has_role(current_user,'synapse_membership_writer','usage') as writer,
        has_table_privilege(current_user,'app.inventory_items','SELECT,INSERT,UPDATE,DELETE') as inventory
        from pg_roles where rolname=current_user`);
      if(!role?.writer || role.rolsuper || role.rolbypassrls || role.inventory)throw Error('멤버십 DB 계정 권한을 확인해 주세요.');
    }
  }
  async function close(){await app.close();await writer?.close();}
  ready().then(()=>app.server.listen(config.port,'0.0.0.0',()=>process.stdout.write('전환 API 준비 완료\n')))
    .catch(async()=>{process.stderr.write('전환 DB 연결 또는 스키마를 확인해 주세요.\n');process.exitCode=1;await close();});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>close().then(()=>process.exit(0)));
}
module.exports={createServer};
