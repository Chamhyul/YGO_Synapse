// 실제 계정·운영 쓰기 없이 인증 경계와 로컬/운영 분기를 검증한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const transport = require('../services/adminActionTransport');
const { safeErrorSummary } = require('../utils/safeError');

function load(file, mocks, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, process: { env }, Buffer, __dirname: path.dirname(path.join(__dirname, '..', file)),
    console: { log() {}, error() {}, warn() {} },
    require(name) { assert.ok(Object.hasOwn(mocks, name), `격리되지 않은 의존성: ${name}`); return mocks[name]; },
  });
  return module.exports;
}
function response() {
  return { code: 200, headers: {}, set(k,v) { this.headers[k] = v; return this; }, setHeader(k,v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
}
function request(body = {}) { return { method: 'POST', headers: { authorization: 'Bearer fixture-token' }, query: {}, body }; }
function fixture({ env = {}, claims = { role: 'admin' }, tokenError, disabled = false, lookupError } = {}) {
  const calls = [], writes = [];
  const auth = {
    async verifyIdToken(token, revoked) {
      calls.push(['verify', token, revoked]);
      if (tokenError) throw Object.assign(Error('dummy-private-error'), { code: tokenError });
      if (disabled) throw Object.assign(Error('disabled'), { code: 'auth/user-disabled' });
      return { uid: 'verified-user', role: 'owner' }; // 요청/과거 토큰 역할은 권한 근거가 아니다.
    },
    async getUser(uid) { calls.push(['user', uid]); if (lookupError) throw Error('private'); return { disabled, customClaims: claims }; },
    async listUsers() { writes.push('list'); return { users: [] }; },
    async setCustomUserClaims(uid, value) { writes.push(['claims', uid, value]); },
  };
  const admin = { auth: () => auth, storage: () => ({ bucket: () => ({}) }) };
  const config = { admin, getProductionAuth() { calls.push(['real-auth']); return auth; }, db: {
    collection: name => ({ doc: uid => ({ async set(value) { writes.push(['db',name,uid,value]); },
      async get() { writes.push('db-read'); return { exists: false }; } }),
      async get() { writes.push('csv-read'); return { empty: true }; } }),
    batch: () => ({ set() { writes.push('csv-write'); }, async commit() {} }),
  } };
  const helpers = load('utils/auth.js', { '../config/firebase': config, './safeError': { safeErrorSummary },
    '../services/registrationService': { isRegisteredUser: async uid => { calls.push(['registered',uid]); return true; } },
  }, env);
  return { auth, config, helpers, calls, writes, env };
}

test('로컬에서 본문 UID가 있어도 위조·만료·철회 토큰은 거부한다', async () => {
  const forged = 'header.' + Buffer.from(JSON.stringify({ sub: 'owner', uid: 'owner' })).toString('base64url') + '.fake';
  for (const env of [{FUNCTIONS_EMULATOR:'true'}, {FIREBASE_EMULATOR_HUB:'localhost:5007'}, {}]) {
    for (const tokenError of ['auth/argument-error', 'auth/id-token-expired', 'auth/id-token-revoked']) {
      const f=fixture({env,tokenError}), res=response(), req=request({uid:'owner'});
      req.headers.authorization='Bearer '+forged;
      assert.equal(await f.helpers.verifyUser(req,res),null);
      assert.equal(res.code,401);
      assert.equal(f.calls.find(c=>c[0]==='verify')[2],true);
    }
  }
});
test('정상 로컬 로그인은 실제 Auth로 검증하고 요청의 UID 대신 검증한 UID를 사용한다',async()=>{
  const f=fixture({env:{FUNCTIONS_EMULATOR:'true'}}),res=response();
  assert.equal(await f.helpers.verifyUser(request({uid:'other-user'}),res),'verified-user');
  assert.deepEqual(f.calls,[['real-auth'],['verify','fixture-token',true]]);
  assert.equal(f.writes.length,0);
});
test('인증 헤더 누락·배열·빈 값과 Auth 에뮬레이터는 검증 전에 거부한다',async()=>{
  for(const authorization of [undefined,[],123,'Basic x','Bearer ','Bearer a b']){
    const f=fixture(),res=response();await f.helpers.verifyUser({headers:{authorization}},res);
    assert.equal(res.code,401);assert.equal(f.calls.length,0);
  }
  const f=fixture({env:{FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'}}),res=response();
  assert.equal(await f.helpers.verifyUser(request(),res),null);assert.equal(f.calls.length,0);
});
test('관리자 역할은 현재 계정으로 확인하고 일반·비활성·권한 철회·조회 장애는 차단한다',async()=>{
  for(const [options,expected] of [[{claims:{}},403],[{claims:{admin:'true'}},403],
    [{disabled:true},401],[{tokenError:'auth/id-token-revoked'},401],[{lookupError:true},503]]){
    const f=fixture(options),res=response();assert.equal(await f.helpers.verifyAdmin(request({role:'owner'}),res),null);
    assert.equal(res.code,expected);assert.equal(f.writes.length,0);
  }
  for(const claims of [{admin:true},{role:'admin'},{role:'owner'}]){
    const f=fixture({claims}),res=response();assert.ok(await f.helpers.verifyAdmin(request(),res));
    const ownerResponse=response();const result=await f.helpers.verifyAdmin(request(),ownerResponse,{ownerOnly:true});
    assert.equal(!!result,claims.role==='owner');
  }
});
test('로컬 관리자 권한 확인은 직접 실행할 수 없다',async()=>{
  for(const key of ['FUNCTIONS_EMULATOR','FIREBASE_EMULATOR_HUB','FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST']){
    const f=fixture({env:{[key]:'true'}}),res=response();assert.equal(await f.helpers.verifyAdmin(request(),res),null);
    assert.equal(res.code,503);assert.equal(f.calls.length,0);
  }
});

function noticeRoutes(f, forward = async()=>false) {
  return load('routes/admin/notices.js', {
    'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},'../../config/firebase':f.config,
    '../../utils/auth':f.helpers,'../../utils/safeError':{safeErrorSummary},
    '../../services/adminActionTransport':{forwardAdminRequest:forward},
    '../../services/noticeService':{createStorageNoticeStore:()=>({}),createNoticeService:()=>({mutate:async()=>{f.writes.push('notice');return{};}})},
  },f.env);
}
test('역할 변경은 현재 owner만 실행하며 거부 시 Auth·DB에 쓰지 않는다',async()=>{
  for(const claims of [{},{role:'admin'},{role:'owner'}]){
    const f=fixture({claims}),res=response();await noticeRoutes(f).manageAdminRole(request({action:'setAdmin',targetUid:'target',isAdmin:true,role:'owner'}),res);
    assert.equal(res.code,claims.role==='owner'?200:403);
    assert.equal(f.writes.length,claims.role==='owner'?2:0);
  }
});

const cases=[['admin/cardIndexes','rebuildCardNames','../../services/cardIndexService',{rebuildCardNames:async()=>({})}],
  ['admin/cardNumbers','migrateCardNumbersField','../../services/cardNumbersMigrationService',{startCardNumbersMigration:async()=>({httpStatus:200})}],
  ['admin/cardIllustrations','migrateCardIllustrations','../../services/cardIllustrationsMigrationService',{startCardIllustrationsMigration:async()=>({httpStatus:200})}],
  ['admin/autoCrawler','triggerAutoCrawl','../../services/autoCrawlerService',{controlAutoCrawl:async()=>({})}]];
for(const [file,name,dependency,service] of cases){
  test(`${name}: 운영의 현재 권한 확인 전에는 작업을 시작하지 않는다`,async()=>{
    for(const allowed of [false,true]){
      const f=fixture({claims:allowed?{role:'admin'}:{}}),res=response();let runs=0;
      const routes=load('routes/'+file+'.js',{
        'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},
        '../../utils/auth':{...f.helpers,verifyAppCheck:async()=>true},
        '../../services/adminActionTransport':{forwardAdminRequest:async()=>false},
        [dependency]:Object.fromEntries(Object.entries(service).map(([key,fn])=>[key,async()=>{runs++;return fn();}])),
      });
      await routes[name](request(),res);assert.equal(res.code,allowed?200:403);assert.equal(runs,allowed?1:0);
    }
  });
}
test('로컬 공지·권한 변경은 전달만 하며 검증과 쓰기를 직접 수행하지 않는다',async()=>{
  for(const name of ['manageNotice','manageAdminRole']){
    const f=fixture({env:{FUNCTIONS_EMULATOR:'true'}}),res=response();let operation;
    const routes=noticeRoutes(f,async(_req,r,op)=>{operation=op;r.status(503).json({success:false});return true;});
    await routes[name](request({action:'setOwner',targetUid:'target'}),res);
    assert.equal(operation,name);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.equal(res.code,503);
  }
});

function remote(body={success:true},status=200,version='1'){
  return {status,headers:{get:key=>key.toLowerCase()==='content-type'?'application/json':version},json:async()=>body};
}
test('관리 요청은 고정 운영 주소에 사용자 토큰과 App Check만 전달한다',async()=>{
  const req=request({action:'list'}),res=response();req.headers.cookie='local-cookie';req.headers['x-firebase-appcheck']='app-token';
  let sent;
  assert.equal(await transport.forwardAdminRequest(req,res,'manageAdminRole',{env:{FUNCTIONS_EMULATOR:'true'},fetchImpl:async(url,options)=>{sent={url,options};return remote({success:true});}}),true);
  assert.equal(sent.url,'https://asia-northeast3-ygo-synapse.cloudfunctions.net/adminHandleOperationRequest');
  assert.deepEqual(Object.keys(sent.options.headers).sort(),['Authorization','Content-Type','X-Firebase-AppCheck']);
  assert.equal(sent.options.redirect,'error');assert.equal(JSON.parse(sent.options.body).operation,'manageAdminRole');
  assert.equal(res.code,200);
});
test('운영 연결 실패·옛 응답·잘못된 응답은 503이며 자동 재시도나 로컬 대체가 없다',async()=>{
  for(const reply of [()=>{throw Error('dummy-secret');},()=>remote({},200,null),()=>remote(null),()=>remote([],200)]){
    let attempts=0;const res=response();
    assert.equal(await transport.forwardAdminRequest(request(),res,'manageNotice',{env:{FUNCTIONS_EMULATOR:'true'},fetchImpl:async()=>{attempts++;return reply();}}),true);
    assert.equal(res.code,503);assert.equal(attempts,1);assert.doesNotMatch(JSON.stringify(res.body),/dummy-secret/);
  }
});
test('관리 작업 진입점은 로컬 실행·미허용 작업·인증 누락을 거부하고 헤더 위조를 전달하지 않는다',async()=>{
  let runs=0,received;
  const resolve=()=>async(req,res)=>{runs++;received=req;return res.json({success:true});};
  const envelope={operation:'manageNotice',method:'POST',body:{headers:{authorization:'Bearer fake'}},query:{}};
  let res=response();await transport.createAdminOperationRequestHandler(resolve,{env:{FUNCTIONS_EMULATOR:'true'}})(request(envelope),res);
  assert.equal(res.code,503);assert.equal(runs,0);
  for(const operation of ['__proto__','getUserData','https://evil.invalid']){
    res=response();await transport.createAdminOperationRequestHandler(resolve,{env:{}})(request({...envelope,operation}),res);
    assert.equal(res.code,400);assert.equal(runs,0);
  }
  res=response();await transport.createAdminOperationRequestHandler(resolve,{env:{}})({...request(envelope),headers:{}},res);
  assert.equal(res.code,401);assert.equal(runs,0);
  res=response();await transport.createAdminOperationRequestHandler(resolve,{env:{}})(request(envelope),res);
  assert.equal(runs,1);assert.equal(received.headers.authorization,'Bearer fixture-token');assert.equal(received.method,'POST');
});
test('공개 카드 검색은 사용자 로그인 없이 유지한다',async()=>{
  const f=fixture({env:{FUNCTIONS_EMULATOR:'true'}}),res=response();
  const routes=load('routes/card.js',{
    'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},'../config/firebase':f.config,
    '../utils/auth':f.helpers,'../utils/common':{},'../scrapers/cardScraper':{},
    '../services/cardService':{getCardFromCacheByNo:async()=>({cid:'42',info:{}}),buildSearchResponse:()=>({cid:'42'})},
    '../utils/inventoryStorage':{},'../services/cardQueryService':{},'../services/inventoryMigrationService':{},'../utils/indexStorage':{},
  },f.env);
  await routes.searchCardByNo({method:'GET',headers:{},query:{cardNo:'TEST'}},res);
  assert.equal(res.code,200);assert.equal(res.body.cid,'42');assert.equal(f.calls.length,0);
});

test('로컬 인벤토리 수정은 실제로 검증한 UID의 기존 저장 경로만 사용한다',async()=>{
  for(const valid of [true,false]){
    const f=fixture({env:{FUNCTIONS_EMULATOR:'true'},tokenError:valid?undefined:'auth/id-token-expired'}),res=response();
    const paths=[];let saves=0;
    const data={version:3,amount:1,locations:{},rarities:{},cards:{}};
    f.config.admin.storage=()=>({bucket:()=>({file:name=>{paths.push(name);return{
      getMetadata:async()=>[{generation:'1'}],download:async()=>[Buffer.from(JSON.stringify(data))],save:async()=>{saves++;},
    };}})});
    const migration={prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'})};
    const storage=load('utils/inventoryStorage.js',{'../config/firebase':f.config,'../services/inventoryMigrationService':migration});
    const routes=load('routes/card.js',{
      'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},'../config/firebase':f.config,
      '../utils/auth':f.helpers,'../utils/common':{},'../scrapers/cardScraper':{},'../services/cardService':{},
      '../utils/inventoryStorage':{...storage,processMoveCards:inventory=>{inventory.amount=2;return[];}},
      '../services/cardQueryService':{},'../services/inventoryMigrationService':migration,'../utils/indexStorage':{},
    },f.env);
    await routes.moveCards(request({uid:'other-user',moves:[{cardNo:'TEST',qty:1}]}),res);
    assert.equal(res.code,valid?200:401);assert.equal(saves,valid?1:0);
    assert.ok(paths.every(name=>name==='users/verified-user/inventory.json'));
    assert.equal(f.env.FUNCTIONS_EMULATOR,'true');
  }
});
test('별도 실제 Auth 생성은 기본 앱과 로컬 저장소 설정을 변경하지 않는다',()=>{
  const env={FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:5003',FIREBASE_STORAGE_EMULATOR_HOST:'localhost:5004'};
  const before={...env},apps=[{name:'[DEFAULT]'}],defaultDb={};
  const admin={apps,firestore:()=>defaultDb,auth:app=>({app}),credential:{cert:()=>({fixture:true})},
    initializeApp(options,name){const app={name,options};apps.push(app);return app;}};
  const config=load('config/firebase.js',{'firebase-admin':admin,'node:fs':{existsSync:()=>true,readFileSync:()=>JSON.stringify({project_id:'ygo-synapse'})},
    'node:path':path,'firebase-admin/firestore':{},'firebase-functions/params':{defineSecret:name=>({name})}},env);
  assert.equal(config.getProductionAuth().app.name,'verified-user-auth');
  assert.equal(config.getProductionAuth().app.name,'verified-user-auth');
  assert.equal(apps.filter(app=>app.name==='verified-user-auth').length,1);
  assert.equal(config.db,defaultDb);assert.equal(apps[0].name,'[DEFAULT]');assert.deepEqual(env,before);
});
test('멤버십 CSV 관리자 업로드도 실제 현재 권한을 확인한 뒤에만 데이터에 접근한다',async()=>{
  for(const allowed of [false,true]){
    const f=fixture({claims:allowed?{role:'admin'}:{}}),res=response();
    const routes=load('routes/integration.js',{
      'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},'../config/firebase':f.config,
      '../utils/auth':f.helpers,'../utils/safeError':{safeErrorSummary},
      '../services/adminActionTransport':{forwardAdminRequest:async()=>false},'../integrations/googleSheets':{},'../integrations/discord':{},
    });
    await routes.uploadMembershipCsv(request({members:[{channelId:'synthetic-channel'}]}),res);
    assert.equal(res.code,allowed?200:403);assert.equal(f.writes.length,allowed?2:0);
  }
});
test('로컬 전달부터 운영 공지 인증까지 연결하여 검증 실패와 정상 저장을 구분한다',async()=>{
  for(const tokenError of ['auth/id-token-revoked',undefined]){
    const production=fixture({tokenError}),routes=noticeRoutes(production);
    const backend=transport.createAdminOperationRequestHandler(operation=>routes[operation],{env:{}});
    const res=response();
    await transport.forwardAdminRequest(request({action:'add',uid:'owner',role:'owner'}),res,'manageNotice',{
      env:{FUNCTIONS_EMULATOR:'true'},fetchImpl:async(_url,options)=>{
        const reply=response();await backend({method:'POST',headers:{authorization:options.headers.Authorization},body:JSON.parse(options.body)},reply);
        return remote(reply.body,reply.code,reply.headers['X-YGO-Admin-Action']);
      },
    });
    assert.equal(res.code,tokenError?401:200);assert.equal(production.writes.length,tokenError?0:1);
  }
});
