const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipCsvParseMembers, membershipCsvValidateMembers, createMembershipCsvService, createFirestoreMembershipCsvStore } = require('../services/membershipCsvService');
const channel = letter => 'UC' + letter.repeat(22);
const member = (letter, levelName = '등급 A') => ({ channelId: channel(letter), memberName: '합성 회원 ' + letter, levelName });
const csv = '회원,프로필에 연결,현재 등급,가격\r\n"합성, ""회원""\n이름",https://www.youtube.com/channel/' + channel('a') + ',등급 A,"1,000"\r\n';

// 실제 Firestore나 인증정보에 연결하지 않는 배치·트랜잭션 모형.
function database(initial = [member('a')]) {
  const records = new Map(initial.map(item => ['membership_csv_users/' + item.channelId, item]));
  let queue = Promise.resolve(), stageFailure = false, stageHook = async () => {}, commitLost = false, time = 123456;
  const snap = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const document = path => ({ path, get: async () => snap(path), collection: name => collection(path + '/' + name) });
  const collection = path => ({ doc: id => document(path + '/' + id), get: async () => ({ docs: [...records.keys()]
    .filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(snap) }) });
  const db = {
    collection,
    batch() { const changes = []; return { set(ref, data) { changes.push([ref.path, data]); }, async commit() {
      await stageHook(); if (stageFailure) throw Error('private-stage-error'); changes.forEach(([path, data]) => records.set(path, structuredClone(data)));
    } }; },
    runTransaction(callback) {
      const task = queue.then(async () => {
        const changes = [], tx = { get: async ref => snap(ref.path), set: (ref, value) => changes.push([ref.path, value]),
          update: (ref, value) => changes.push([ref.path, { ...records.get(ref.path), ...value }]) };
        const result = await callback(tx);
        changes.forEach(([path, value]) => records.set(path, structuredClone(value)));
        if (commitLost && changes.some(([path]) => path === 'membership_csv_state/current')) { commitLost = false; throw Error('lost response'); }
        return result;
      }); queue = task.catch(() => {}); return task;
    }
  };
  const store = createFirestoreMembershipCsvStore(db), service = createMembershipCsvService({store, now:()=>time});
  return {records,db,store,service, advance(ms){time+=ms;}, failStage(){stageFailure=true;}, hook(fn){stageHook=fn;}, loseCommit(){commitLost=true;}};
}
async function request(service, members, id = '1'.repeat(32)) {
  return { members, ...await service.preview({members}), operationId: id };
}
test('BOM·인용 쉼표·큰따옴표·개행·추가 열을 보존하고 열 순서 변경을 허용한다', () => {
  assert.deepEqual(membershipCsvParseMembers('\uFEFF' + csv), [{channelId:channel('a'),memberName:'합성, "회원"\n이름',levelName:'등급 A'}]);
  assert.equal(membershipCsvParseMembers('현재 등급,회원,프로필에 연결\n등급 A,합성,https://youtube.com/channel/'+channel('b')).length,1);
});
test('빈 목록·중복 채널·누락/중복 헤더·잘못된 열 수·깨진 인용·잘못된 URL을 모두 거부한다', () => {
  const valid = `회원,프로필에 연결,현재 등급\n합성,https://youtube.com/channel/${channel('a')},등급 A`;
  for (const input of ['', '회원,프로필에 연결,현재 등급', valid+'\n'+valid.split('\n')[1], valid.replace('회원,프로필에 연결','회원,회원'),
    valid.replace(',등급 A', ''), valid+'"', valid.replace('youtube.com','youtube.com.attacker.invalid'), valid.replace('https:','http:'),
    valid.replace(channel('a'), 'UCshort'), valid.replace(',등급 A',','), valid.replace('합성,','"합성,')]) {
    assert.throws(() => membershipCsvParseMembers(input), error => error.status===400 && !error.message.includes(channel('a')));
  }
  assert.throws(()=>membershipCsvParseMembers('a'.repeat(1024*1024+1)));
  assert.throws(()=>membershipCsvValidateMembers([{...member('a'),channelId:[channel('a')]}]));
});
test('미리보기는 저장하지 않고 추가·제외·등급 변경 및 가격과 무관한 등급별 수를 반환한다',async()=>{
  const f=database([member('a'),member('b')]), size=f.records.size;
  const result=await f.service.preview({members:[member('b','등급 B'),member('c','등급 B')]});
  assert.equal(f.records.size,size);assert.deepEqual([result.previousCount,result.count,result.added,result.removed,result.changed],[2,2,1,1,1]);
  assert.deepEqual(result.tiers,[{levelName:'등급 B',count:2}]);assert.ok(!JSON.stringify(result).includes('합성 회원'));
});
test('모든 배치 저장 완료 전에는 기존 목록을 유지하고 완료 후 같은 목록으로 회원을 확인한다',async()=>{
  const f=database();
  f.hook(async()=>{assert.equal((await f.store.readMember(channel('a'))).levelName,'등급 A');assert.equal(await f.store.readMember(channel('b')),null);});
  const result=await f.service.apply(await request(f.service,[member('b')]),'admin-a');
  assert.equal(result.updatedAt,123456);assert.equal(result.count,1);
  assert.equal(await f.store.readMember(channel('a')),null);assert.equal((await f.store.readMember(channel('b'))).levelName,'등급 A');
  assert.equal((await f.service.summary()).count,1);assert.ok(f.records.has('membership_csv_users/'+channel('a')));
});
test('저장 실패는 기존 목록을 유지하고 실패 상태를 조회할 수 있다',async()=>{
  const f=database(), body=await request(f.service,[member('b')]);f.failStage();
  await assert.rejects(f.service.apply(body,'admin-a'));
  assert.equal((await f.store.readMember(channel('a'))).levelName,'등급 A');assert.equal(f.records.has('membership_csv_state/current'),false);
  assert.equal((await f.service.status({operationId:body.operationId},'admin-a')).status,'failed');
});
test('같은 요청 재전송·완료 응답 유실은 중복 적용하지 않으며 작업 번호와 조회자를 검증한다',async()=>{
  const f=database(), body=await request(f.service,[member('b')]);f.loseCommit();
  const result=await f.service.apply(body,'admin-a');
  assert.deepEqual(await f.service.apply(body,'admin-a'),result);
  await assert.rejects(f.service.apply(body,'admin-b'),e=>e.status===409);
  await assert.rejects(f.service.status({operationId:body.operationId},'admin-b'),e=>e.status===403);
  assert.equal((await f.service.status({operationId:body.operationId},'admin-a')).status,'completed');
  assert.equal((await f.service.status({operationId:'f'.repeat(32)},'admin-a')).status,'unknown');
});
test('미리보기 뒤 다른 관리자가 적용하거나 동시에 요청하면 하나만 전환한다',async()=>{
  const f=database(), first=await request(f.service,[member('b')]), second=await request(f.service,[member('c')],'2'.repeat(32));
  let count=0, release;const gate=new Promise(resolve=>release=resolve);f.hook(async()=>{if(++count===2)release();await gate;});
  const results=await Promise.allSettled([f.service.apply(first,'admin-a'),f.service.apply(second,'admin-b')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await f.service.summary()).count,1);
  await assert.rejects(f.service.apply({...first,operationId:'3'.repeat(32)},'admin-a'),e=>e.status===409);
});
test('활성 목록 상태가 손상되면 예전 목록으로 대체하지 않고 확인 실패로 처리한다',async()=>{
  const f=database();f.records.set('membership_csv_state/current',{revision:'bad',count:1});
  await assert.rejects(f.store.readMember(channel('a')),e=>e.status===503);
  await assert.rejects(f.service.summary(),e=>e.status===503);
});
test('빈 목록·지문 변조·불완전 회원 배열은 쓰기 전에 거부한다',async()=>{
  const f=database(), body=await request(f.service,[member('b')]), size=f.records.size;
  for(const invalid of [{...body,members:[]},{...body,fingerprint:'fake'},{...body,members:[{channelId:channel('b')}]}]) {
    await assert.rejects(f.service.apply(invalid,'admin-a'),e=>e.status===400);
  }
  assert.equal(f.records.size,size);
});
test('두 번째 배치가 실패해도 부분 저장된 새 목록을 활성화하지 않는다',async()=>{
  const f=database();let batches=0;f.hook(async()=>{if(++batches===2)f.failStage();});
  const members=Array.from({length:451},(_,i)=>({channelId:'UC'+String(i).padStart(22,'0'),memberName:'합성 회원',levelName:'등급 A'}));
  await assert.rejects(f.service.apply(await request(f.service,members),'admin-a'));
  assert.equal(batches,2);assert.equal((await f.service.summary()).count,1);
  assert.equal(await f.store.readMember(members[0].channelId),null);
});
test('진행 중인 같은 요청은 중복 저장하지 않고 pending으로 확인한다',async()=>{
  const f=database(),body=await request(f.service,[member('b')]);let release,started;
  const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let batches=0;
  f.hook(async()=>{batches++;started();await gate;});
  const pending=f.service.apply(body,'admin-a');await entered;
  assert.equal((await f.service.status({operationId:body.operationId},'admin-a')).status,'pending');
  await assert.rejects(f.service.apply(body,'admin-a'),e=>e.code==='MEMBERSHIP_CSV_PROCESSING');
  release();await pending;assert.equal(batches,1);
});
test('기존 업로드 HTTP 함수도 같은 활성 목록을 전환하고 잘못된 입력은 교체하지 않는다',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),f=database(),exports={};
  const dependencies={
    '../services/adminActionTransport':{forwardAdminRequest:async()=>false},
    'firebase-functions/v2/https':{onRequest:(_,handler)=>handler},'../config/firebase':{db:f.db},
    '../utils/auth':{setCors(){},verifyAdmin:async()=>({uid:'admin-a',role:'admin'})},
    '../utils/safeError':{safeErrorSummary:()=>({code:'UNAVAILABLE'})},'../integrations/googleSheets':{},
    'node:crypto':require('node:crypto'),'../services/membershipCsvService':require('../services/membershipCsvService')};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/integration.js'),'utf8'),{exports,console:{error(){}},require:name=>{
    assert.ok(Object.hasOwn(dependencies,name));return dependencies[name];}});
  const call=async body=>{const res={code:200,set(){},status(code){this.code=code;return this;},json(data){this.body=data;return this;}};
    await exports.uploadMembershipCsv({method:'POST',body},res);return res;};
  assert.equal((await call({csvText:csv})).code,200);const revision=(await f.service.summary()).revision;
  assert.equal((await call({members:[]})).code,400);assert.equal((await f.service.summary()).revision,revision);
  assert.equal((await call({members:[member('b')]})).code,200);assert.equal(await f.store.readMember(channel('a')),null);
});
test('중단된 작업은 2분 뒤 결과 조회에서 실패로 확정하고 늦은 저장을 차단한다',async()=>{
  const f=database(),body=await request(f.service,[member('b')]);let release,entered;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.hook(async()=>{entered();await gate;});const pending=f.service.apply(body,'admin-a');await started;
  f.advance(120001);assert.equal((await f.service.status({operationId:body.operationId},'admin-a')).status,'failed');
  release();await assert.rejects(pending,e=>e.status===409);
  assert.equal((await f.service.summary()).count,1);assert.equal(await f.store.readMember(channel('b')),null);
});
test('CLI도 같은 목록을 사용하고 DB 적용 성공 뒤에만 원본 CSV를 보관한다',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  for(const fail of [false,true]) {
    const f=database();if(fail)f.failStage();const files=[];let finish;
    const done=new Promise(resolve=>finish=resolve);
    const dependencies={fs:{existsSync:()=>true,readFileSync:()=>Buffer.from(csv),copyFileSync:()=>files.push('copy'),unlinkSync:()=>files.push('unlink')},
      path,'./cloud_credentials':{initializeDataToolFirebaseApp(){}},'../functions/node_modules/firebase-admin':{firestore:()=>f.db},
      'node:crypto':require('node:crypto'),'../functions/services/membershipCsvService':require('../services/membershipCsvService')};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../scripts/upload_membership_csv.js'),'utf8'),{
      TextDecoder,console:{log(){},error(){},warn(){}},process:{argv:['node','script','/synthetic/2026.10.9 12_1.csv'],exit:finish},
      require:name=>{assert.ok(Object.hasOwn(dependencies,name));return dependencies[name];}});
    assert.equal(await done,fail?1:0);assert.deepEqual(files,fail?[]:['copy','unlink']);
    assert.equal((await f.service.summary()).count,1);assert.equal(f.records.has('membership_csv_state/current'),!fail);
  }
});
