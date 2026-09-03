const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { emptyIndexes, applyCardChanges } = require('../services/cardIndexBuilder');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function loadModule(file, mocks) {
  const filename = path.join(__dirname, '..', file);
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, Date, Buffer,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return module.exports;
}
const card = (name, number) => ({ info: { 0: [name, 1, { [number]: ['팩', 'N'] }] } });

function fixture() {
  const data = new Map([["system/cardIndexState", { ready: true }]]);
  const indexes = emptyIndexes();
  const versions = { byName: 1, byNumber: 1, cid: 1 };
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
    readIndexFile: async type => ({ data: clone(indexes[type]), generation: versions[type] }),
    readIndexGeneration: async type => versions[type],
    readManifestGeneration: async () => 1,
    writeIndexFile: async (type, value, generation) => {
      if (hook) await hook(type);
      if (failType === type) throw Error('저장 실패');
      if (generation !== versions[type]) throw Error('버전 충돌');
      indexes[type] = clone(value); versions[type]++;
    },
    writeCardManifest: async (names, numbers) => {
      if (failType === 'manifest') throw Error('목록 저장 실패');
      manifest = { names: Object.keys(names), numbers: Object.keys(numbers) };
    }, invalidateCache() {},
  };
  const service = loadModule('services/cardIndexService.js', {
    '../config/firebase': { db, admin: { firestore: { FieldPath: { documentId: () => '__name__' } } } },
    './cardWriteService': { PENDING_COLLECTION: 'pendingCardIndexUpdates' },
    './cardIndexDispatchService': { requestCardIndexWork: async () => ({ scheduled: true }) },
    './cardIndexBuilder': { emptyIndexes, applyCardChanges },
    '../utils/indexStorage': storage,
  });
  const queue = (id, version, value) => { data.set(`cards/${id}`, value); data.set(`pendingCardIndexUpdates/${id}`, { version, queuedAt: Date.now() }); };
  return { service, data, indexes, versions, queue, get manifest() { return manifest; },
    set fail(value) { failType = value; }, set hook(value) { hook = value; } };
}

test('증분 갱신은 옛 이름·번호를 제거하고 다른 카드를 보존한다', () => {
  const indexes = emptyIndexes();
  applyCardChanges(indexes, [{ cid:'1',data:card('이전','OLD') }, {cid:'2',data:card('유지','KEEP')}]);
  applyCardChanges(indexes, [{ cid:'1',data:card('변경','NEW') }]);
  assert.equal(indexes.byName['이전'],undefined);
  assert.equal(indexes.byNumber.OLD,undefined);
  assert.equal(indexes.byNumber.KEEP.cid,'2');
  assert.equal(indexes.byNumber.NEW.cid,'1');
  const once=clone(indexes);
  applyCardChanges(indexes,[{cid:'1',data:card('변경','NEW')}]);
  assert.deepEqual(clone(indexes),once);
  applyCardChanges(indexes,[{cid:'1',data:null}]);
  assert.equal(indexes.cid['1'],undefined);
});

test('정상 처리 후에만 대기 기록을 삭제한다', async () => {
  const f=fixture(); f.queue('1','v1',card('카드','NO'));
  const result=await f.service.processPendingCardIndexes();
  assert.equal(result.processed,1); assert.equal(f.data.has('pendingCardIndexUpdates/1'),false);
  assert.equal(f.indexes.byNumber.NO.cid,'1'); assert.deepEqual(f.manifest.names,['카드']);
});

for (const step of ['byName','byNumber','cid','manifest']) {
  test(`${step} 저장 실패 후 대기 기록 보존 및 재시도`,async()=>{
    const f=fixture(); f.queue('1','v1',card('카드','NO')); f.fail=step;
    await assert.rejects(f.service.processPendingCardIndexes());
    assert.equal(f.data.get('pendingCardIndexUpdates/1').version,'v1');
    f.fail=null; await f.service.processPendingCardIndexes();
    assert.equal(f.data.has('pendingCardIndexUpdates/1'),false);
    assert.equal(f.indexes.byNumber.NO.cid,'1');
  });
}

test('처리 도중 들어온 최신 변경은 이전 작업이 삭제하지 않는다',async()=>{
  const f=fixture();f.queue('1','v1',card('이전','OLD'));
  f.hook=async type=>{if(type==='byName'){f.hook=null;f.queue('1','v2',card('최신','NEW'));}};
  await f.service.processPendingCardIndexes();
  assert.equal(f.data.get('pendingCardIndexUpdates/1').version,'v2');
  await f.service.processPendingCardIndexes();
  assert.equal(f.indexes.byNumber.OLD,undefined);assert.equal(f.indexes.byNumber.NEW.cid,'1');
});

test('활성 잠금 중에는 다른 작업이 파일을 쓰지 않는다',async()=>{
  const f=fixture();f.queue('1','v1',card('카드','NO'));
  f.data.set('system/cardIndexWriter',{owner:'other',expiresAt:Date.now()+60000});
  const result=await f.service.processPendingCardIndexes();assert.equal(result.busy,true);
  assert.equal(f.versions.byName,1);assert.equal(f.data.has('pendingCardIndexUpdates/1'),true);
});

test('파일 버전 충돌을 강제 덮어쓰지 않는다',async()=>{
  const f=fixture();f.queue('1','v1',card('카드','NO'));
  f.hook=async type=>{f.hook=null;f.versions[type]++;};
  await assert.rejects(f.service.processPendingCardIndexes(),/버전 충돌/);
  assert.equal(f.data.has('pendingCardIndexUpdates/1'),true);
});

test('전체 복구는 동일한 생성 규칙을 사용하고 대기 기록을 유지한다',async()=>{
  const f=fixture();f.queue('1','v1',card('카드','NO'));
  f.indexes.byName['잔재']={cid:'ghost'};
  const result=await f.service.rebuildAllCardIndexes();assert.equal(result.totalCards,1);
  assert.equal(f.indexes.byName['잔재'],undefined);assert.equal(f.data.has('pendingCardIndexUpdates/1'),true);
  const full=clone(f.indexes);await f.service.processPendingCardIndexes();assert.deepEqual(clone(f.indexes),full);
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
  const helper=source.slice(source.indexOf('async function callApi('),source.indexOf('// 검색 시 최신 공통 목록'));
  const sandbox={location:{hostname:'localhost'}};vm.createContext(sandbox);vm.runInContext(config+helper,sandbox);
  await assert.rejects(sandbox.callApi('missing'),/등록되지 않은/);
});

test('Storage 저장은 SDK에 버전 조건을 전달하고 실패를 그대로 전파한다',async()=>{
  const calls=[];
  const storage=loadModule('utils/indexStorage.js',{'../config/firebase':{getBucket:()=>({file:name=>({save:async(body,opts)=>{
    calls.push({name,opts});throw Object.assign(Error('충돌'),{code:412});
  }})})}});
  await assert.rejects(storage.writeIndexFile('byName',{},'123'),/충돌/);
  await assert.rejects(storage.writeCardManifest({}, {}, '456'),/충돌/);
  assert.equal(calls[0].opts.preconditionOpts.ifGenerationMatch,'123');
  assert.equal(calls[1].opts.preconditionOpts.ifGenerationMatch,'456');
  assert.equal(calls.length,2); // 실패 후 무조건 덮어쓰는 재시도가 없어야 합니다.
});

test('닉네임 라우트는 인증된 사용자만 저장하고 잘못된 입력을 거절한다',async()=>{
  const writes=[];let uid='user-1';
  const routes=loadModule('routes/user.js',{
    'firebase-functions/v2/https':{onRequest:(_,fn)=>fn},
    '../config/firebase':{db:{collection:name=>({doc:id=>({set:async value=>writes.push({name,id,value})})})},FieldValue:{serverTimestamp:()=> 'time'}},
    '../utils/common':{},'../utils/packsStorage':{},'../utils/inventoryStorage':{},
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


test('준비 상태와 기존 인덱스가 없어도 대기 카드로 파일을 생성한다', async () => {
  const f = fixture();
  f.data.delete('system/cardIndexState');
  for (const type of ['byName', 'byNumber', 'cid']) f.versions[type] = 0;
  f.queue('1', 'v1', card('카드', 'NO'));
  const result = await f.service.processPendingCardIndexes();
  assert.equal(result.processed, 1);
  assert.equal(f.data.has('pendingCardIndexUpdates/1'), false);
  for (const type of ['byName', 'byNumber', 'cid']) assert.equal(f.versions[type], 1);
  assert.ok(f.manifest);
});
