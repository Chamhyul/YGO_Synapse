const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCardManifest, addCardToManifest } = require('../services/cardIndexBuilder');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function loadModule(file, mocks) {
  const filename = path.join(__dirname, '..', file);
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, Date, Buffer,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return module.exports;
}
const card = (name, number) => ({ names: [name], numbers: [number], info: { 0: [name, 1, { [number]: ['팩', 'N'] }] } });

function fixture() {
  const data = new Map([["system/cardIndexState", { ready: true }]]);
  let generation = 1;
  let manifest = null, failType = null, hook = null;
  const ref = key => ({ path: key, id: key.split('/').pop(), get: async () => snapshot(key),
    set: async (value, options) => data.set(key, options?.merge ? { ...data.get(key), ...clone(value) } : clone(value)) });
  const snapshot = key => {
    const saved = clone(data.get(key));
    return { ref: ref(key), id: key.split('/').pop(), exists: saved !== undefined, data: () => saved };
  };
  const db = {
    collection: name => {
      let limit = Infinity, after = '', order = '';
      const query = { doc: id => ref(`${name}/${id}`),
        orderBy: field => { order = field; return query; },
        select: () => query,
        limit: size => { limit = size; return query; },
        startAfter: cursor => { after = typeof cursor === 'string' ? cursor : cursor.id; return query; },
        get: async () => {
          const entries = [...data.keys()].filter(key => key.startsWith(name + '/') && key.split('/').pop() > after);
          entries.sort((a,b) => order === 'queuedAt' ? data.get(a).queuedAt - data.get(b).queuedAt : a.localeCompare(b));
          const docs = entries.slice(0,limit).map(snapshot);
          return { docs, size: docs.length, empty: !docs.length };
        } };
      return query;
    },
    getAll: async (...refs) => refs.map(r => snapshot(r.path)),
    runTransaction: async fn => {
      const writes = [];
      const result = await fn({ get: async r => snapshot(r.path), getAll: async (...refs) => refs.map(r => snapshot(r.path)),
        set: (r, value) => writes.push(() => data.set(r.path, clone(value))),
        delete: r => writes.push(() => data.delete(r.path)) });
      writes.forEach(write => write()); return result;
    },
  };
  const storage = {
    readManifestGeneration: async () => generation,
    writeCardManifest: async (names, numbers, expected) => {
      if (hook) await hook();
      if (failType) throw Error('목록 저장 실패');
      if (expected !== generation) throw Error('버전 충돌');
      manifest = clone({ names, numbers });
      generation++;
    },
  };
  const service = loadModule('services/cardIndexService.js', {
    '../config/firebase': { db, FieldPath: { documentId: () => '__name__' } },
    './cardWriteService': { PENDING_COLLECTION: 'pendingCardIndexUpdates' },
    './cardIndexDispatchService': { requestCardIndexWork: async () => ({ scheduled: true }) },
    './cardIndexBuilder': { createCardManifest, addCardToManifest },
    '../utils/indexStorage': storage,
  });
  const queue = (id, version, value) => { data.set(`cards/${id}`, value); data.set(`pendingCardIndexUpdates/${id}`, { version, queuedAt: Date.now() }); };
  return { service, data, queue, get manifest() { return manifest; },
    set fail(value) { failType = value; }, set hook(value) { hook = value; } };
}

test('목록 생성은 원본 배열을 합치고 공유 이름과 슬래시를 보존한다', () => {
  const manifest = createCardManifest();
  addCardToManifest(manifest, card('공유/이름', ' A '));
  addCardToManifest(manifest, card('공유/이름', 'B'));
  assert.deepEqual([...manifest.names], ['공유/이름']);
  assert.deepEqual([...manifest.numbers], ['A', 'B']);
});

test('대기 기록이 없는 기존 카드도 최초 목록 생성에 포함한다', async () => {
  const f = fixture();
  f.data.set('cards/old', card('기존', 'OLD'));
  f.queue('1', 'v1', card('추가', 'NEW'));
  const result = await f.service.processPendingCardIndexes();
  assert.equal(result.totalCards, 2);
  assert.deepEqual(f.manifest.numbers, ['NEW', 'OLD']);
  assert.equal(f.data.has('pendingCardIndexUpdates/1'), false);
});

test('목록 저장 실패 시 대기 기록을 남긴다', async () => {
  const f = fixture(); f.queue('1', 'v1', card('카드', 'NO')); f.fail = true;
  await assert.rejects(f.service.processPendingCardIndexes(), /목록 저장 실패/);
  assert.equal(f.data.get('pendingCardIndexUpdates/1').version, 'v1');
});

test('생성 도중 발생한 변경은 완료 처리하지 않는다', async () => {
  const f = fixture(); f.queue('1', 'v1', card('이전', 'OLD'));
  f.hook = async () => { f.hook = null; f.queue('1', 'v2', card('최신', 'NEW')); };
  await f.service.processPendingCardIndexes();
  assert.equal(f.data.get('pendingCardIndexUpdates/1').version, 'v2');
  await f.service.processPendingCardIndexes();
  assert.deepEqual(f.manifest.numbers, ['NEW']);
});

test('잠금이 있으면 목록을 저장하지 않는다', async () => {
  const f = fixture(); f.queue('1', 'v1', card('카드', 'NO'));
  f.data.set('system/cardIndexWriter', { owner: 'other', expiresAt: Date.now() + 60000 });
  assert.equal((await f.service.processPendingCardIndexes()).busy, true);
  assert.equal(f.manifest, null);
});

test('수동 재생성은 삭제된 카드의 이름과 번호를 제거한다', async () => {
  const f = fixture(); f.queue('1', 'v1', card('카드', 'NO'));
  await f.service.processPendingCardIndexes();
  f.data.delete('cards/1');
  await f.service.rebuildAllCardIndexes();
  assert.deepEqual(f.manifest, { names: [], numbers: [] });
});

test('목록 저장은 generation 조건을 전달하고 충돌을 전파한다', async () => {
  let condition;
  const storage = loadModule('utils/indexStorage.js', { '../config/firebase': {
    getBucket: () => ({ file: () => ({ save: async (body, options) => {
      condition = options.preconditionOpts.ifGenerationMatch;
      throw Object.assign(Error('충돌'), { code: 412 });
    } }) })
  } });
  await assert.rejects(storage.writeCardManifest([], [], '456'), /충돌/);
  assert.equal(condition, '456');
});

test('원본과 대기 기록은 하나의 배치로 저장하며 실패를 전달한다',async()=>{
  const operations=[];let commits=0;
  const batch={set:(...args)=>operations.push(args),commit:async()=>{commits++;throw Error('원자적 저장 실패');}};
  const service=loadModule('services/cardWriteService.js',{'./cardIndexDispatchService':{requestCardIndexWork:async()=>({scheduled:true})},'../config/firebase':{
    db:{batch:()=>batch,collection:name=>({doc:id=>`${name}/${id}`})},FieldValue:{serverTimestamp:()=> 'server-time'}
  }});
  await assert.rejects(service.saveCardAndQueueIndex('1',card('카드','NO')),/원자적 저장 실패/);
  assert.equal(commits,1);assert.equal(operations.length,2);
  assert.equal(operations[0][0],'cards/1');assert.equal(operations[1][0],'pendingCardIndexUpdates/1');
  assert.ok(operations[1][1].version);
});

test('운영·로컬 주소 목록이 서버 등록과 일치하고 레거시 호출이 없다',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../public/script.js'),'utf8');
  const config=source.slice(0,source.indexOf('// Safari 최적화: callApi'));
  const functions=require('../index');
  for(const hostname of ['localhost','ygo-synapse.web.app']){
    const sandbox={location:{hostname}};vm.createContext(sandbox);
    vm.runInContext(config+'\nthis.endpoints=FIREBASE_CONFIG.ENDPOINTS;',sandbox);
    for(const [name,url] of Object.entries(sandbox.endpoints)){
      assert.equal(typeof functions[name],'function',name);assert.ok(url.endsWith('/'+name));
    }
    assert.ok(sandbox.endpoints.updateNickname);
    for(const match of source.matchAll(/callApi\(['"]([^'"]+)['"]/g))assert.ok(sandbox.endpoints[match[1]],match[1]);
    for(const name of ['keepAlivePing','checkMembership','cleanNumbersCollection','buildIndex'])assert.equal(sandbox.endpoints[name],undefined);
  }
  const helper=source.slice(source.indexOf('const cardResponseCache ='),source.indexOf('// 검색 시 최신 공통 목록'));
  const sandbox={location:{hostname:'localhost'}};vm.createContext(sandbox);vm.runInContext(config+helper,sandbox);
  await assert.rejects(sandbox.requestApi('missing'),/등록되지 않은/);
});

test('닉네임 라우트는 인증된 사용자만 저장하고 잘못된 입력을 거절한다',async()=>{
  const writes=[];let uid='user-1';
  const routes=loadModule('routes/user.js',{
    'firebase-functions/v2/https':{onRequest:(_,fn)=>fn},
    '../config/firebase':{db:{collection:name=>({doc:id=>({set:async value=>writes.push({name,id,value})})})},FieldValue:{serverTimestamp:()=> 'time'}},
    '../utils/common':{},'../utils/packsStorage':{},'../utils/inventoryStorage':{},
    '../services/cardQueryService':{},'../services/inventoryMigrationService':{},
    '../utils/auth':{setCors(){},verifyUser:async()=>uid},
  });
  let status=200,body;
  const res={status(code){status=code;return this;},json(value){body=value;return this;}};
  await routes.updateNickname({method:'POST',body:{nickname:'  새이름  '}},res);
  assert.equal(body.success,true);assert.equal(writes[0].value.Nickname,'새이름');
  await routes.updateNickname({method:'POST',body:{nickname:'12345678901'}},res);assert.equal(status,400);
  await routes.updateNickname({method:'GET'},res);assert.equal(status,405);
  uid=null;await routes.updateNickname({method:'POST',body:{nickname:'저장불가'}},res);
  assert.equal(writes.length,1);
});
