'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createMembershipCsvService, createFirestoreMembershipCsvStore } = require('../services/membershipCsvService');
const { createMembershipCsvStore, CONTROL_LIMIT } = require('../services/user-storage/membershipCsvStore');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const { content: entryDigest } = require('../services/userMigrationRehearsal');
const { getMembershipCsvStore } = require('../services/membershipCsvRepository');
const C = require('../services/membershipCsvWriterContract');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { createAdminRouteHandlers } = require('../services/adminPageRuntime');
const environment = f => ({ ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId });
const id = () => randomBytes(16).toString('hex'), hash = value => createHash('sha256').update(value).digest('hex');
const member = number => ({ channelId: 'UC' + String(number).padStart(22,'0'), memberName: '합성 회원', levelName: number%2?'A':'B' });
const migration = { prepareInventoryV2:async()=>{},inventoryMigrationStatus:()=>({status:'complete'}) };
async function setup(options={},runId=id(),runtime=false) {
  const connection=open(runId),db=runtime?{collection:name=>connection.db.collection('unused').firestore.collection(`profileWriterRuns/${runId}/${name}`),runTransaction:action=>connection.db.runTransaction(action)}:connection.db;
  const database=runtime?{ref:name=>connection.database.ref(`profileWriterRuns/${runId}/data/${name}`)}:connection.targetDatabase;
  const binding=createUserInventoryWriterBinding({db,database,bucket:connection.bucket,FieldValue,runId,migration,config:connection.config,...options});
  await binding.initialize();return{...binding,db,database,runId,connection,service:createMembershipCsvService({store:binding.membershipCsv,now:options.csvNow}),close:()=>connection.close()};
}
async function flip(f){const writer=await f.transition.route();await f.transition.copy(writer);await f.transition.drain(writer);return f.transition.activate(writer);}
async function body(f,members){return{members,...await f.service.preview({members}),operationId:id()};}
for(const backend of ['legacy','rtdb'])test(`${backend} CSV 적용·미리보기·중복/관리자 상태 계약과 양방향 전환을 유지한다`,async()=>{
  const f=await setup();try{
    assert.equal((await f.service.summary()).revision,C.legacyRevision([]));if(backend==='rtdb')await flip(f);
    const request=await body(f,[member(1),member(2)]),result=await f.service.apply(request,'synthetic-admin');assert.equal(result.count,2);
    assert.deepEqual(await f.service.apply(request,'synthetic-admin'),result);assert.deepEqual(await f.membershipCsv.readMember(member(1).channelId),member(1));
    await assert.rejects(f.service.status({operationId:request.operationId},'other'),{status:403});await assert.rejects(f.service.apply(request,'other'),{status:409});
    await flip(f);assert.deepEqual((await f.service.status({operationId:request.operationId},'synthetic-admin')).result,result);
    const next=await body(f,[member(3)]);await f.service.apply(next,'synthetic-admin');await flip(f);
    assert.deepEqual((await f.membershipCsv.read()).members,[member(3)]);assert.equal((await f.transition.inspect()).unresolved,0);
  }finally{await f.close();}
});
test('구형 FS 갱신 시각0의 원문은 보존하고 summary null·완료 결과0 응답을 각각 유지한다',async()=>{
  const f=await setup(),store=createFirestoreMembershipCsvStore(f.db),source=createMembershipCsvService({store,now:()=>0});
  try{const request={members:[member(1)],...await source.preview({members:[member(1)]}),operationId:id()};await source.apply(request,'old-admin');
    assert.equal((await source.summary()).updatedAt,null);await flip(f);assert.equal((await f.service.summary()).updatedAt,null);assert.equal((await f.service.status({operationId:request.operationId},'old-admin')).result.updatedAt,0);
    await flip(f);assert.equal((await f.db.collection('membership_csv_state').doc('current').get()).data().updatedAt,0);
  }finally{await f.close();}
});
test('기존 FS fallback·완료·실패·미확정 후보와 공개 revision/결과를 보존한다',async()=>{
  const f=await setup(),source=createFirestoreMembershipCsvStore(f.db),service=createMembershipCsvService({store:source}),pending=id(),failed=id();
  try{await f.db.collection('membership_csv_users').doc(member(9).channelId).set(member(9));
    const old=await f.membershipCsv.read();assert.equal(old.revision,(await source.read()).revision);
    const request={members:[member(1)],...await service.preview({members:[member(1)]}),operationId:id()},result=await service.apply(request,'old-admin');
    const rawPending={binding:hash('synthetic-pending'),actor:'old-admin',startedAt:Date.now()-130000,status:'pending'};
    await f.db.collection('membership_csv_imports').doc(pending).set(rawPending);await f.db.collection('membership_csv_imports').doc(pending).collection('members').doc(member(2).channelId).set(member(2));
    await f.db.collection('membership_csv_imports').doc(failed).set({...rawPending,status:'failed'});
    await flip(f);assert.deepEqual((await f.service.status({operationId:request.operationId},'old-admin')).result,result);
    assert.equal((await f.service.status({operationId:pending},'old-admin')).status,'failed');await flip(f);
    assert.equal((await source.status(pending)).status,'failed');assert.equal((await source.status(failed)).status,'failed');
    assert.deepEqual((await f.db.collection('membership_csv_users').doc(member(9).channelId).get()).data(),member(9));
  }finally{await f.close();}
});
test('구형 합성 회원45명의 updatedAt 원문·공개 revision·조회는 RTDB 왕복과 신규 3필드 적용 뒤에도 보존된다',async()=>{
  const f=await setup(),source=createFirestoreMembershipCsvStore(f.db);
  const members=Array.from({length:45},(_,index)=>({...member(100+index),updatedAt:index===0?0:1700000000000+index}));
  const ordered=members.toSorted((a,b)=>a.channelId.localeCompare(b.channelId));
  try{
    const batch=f.db.collection('membership_csv_users').firestore.batch();
    for(const value of members)batch.create(f.db.collection('membership_csv_users').doc(value.channelId),value);
    await batch.commit();
    const before=await source.read(),summary=await f.service.summary();
    assert.deepEqual(before.members,ordered);assert.equal(before.revision,C.legacyRevision(before.members));assert.equal(before.updatedAt,null);
    assert.deepEqual(await f.membershipCsv.read(),before);
    assert.deepEqual(await f.membershipCsv.readMember(members[0].channelId),members[0]);
    assert.deepEqual(await f.membershipCsv.readMember(members.at(-1).channelId),members.at(-1));
    await flip(f);
    assert.equal((await f.transition.route()).backend,'rtdb');
    assert.deepEqual(await f.membershipCsv.read(),before);assert.deepEqual(await f.service.summary(),summary);
    assert.deepEqual(await f.membershipCsv.readMember(members[0].channelId),members[0]);
    assert.equal(await f.membershipCsv.readMember(member(999).channelId),null);
    assert.deepEqual((await f.csvAdapters.rtdb.read('csv/legacyUsers')).value,ordered);
    const control=(await f.csvAdapters.rtdb.read('csv/control')).value;
    const candidate=(await f.csvAdapters.rtdb.read(`csv/candidate/${control.active.revision}`)).value;
    assert.equal(candidate.legacyList,true);assert.deepEqual(candidate.members,ordered);
    assert.equal(candidate.fingerprint,C.digest(ordered));assert.equal(control.active.publicRevision,before.revision);
    await flip(f);
    assert.equal((await f.transition.route()).backend,'legacy');
    assert.deepEqual(await f.membershipCsv.read(),before);assert.deepEqual(await source.read(),before);
    const physical=(await f.db.collection('membership_csv_users').orderBy('__name__').get()).docs.map(doc=>doc.data());
    assert.deepEqual(physical,ordered);
    // 신규 업로드는 기존 3필드 그대로 stage/commit하고, 보존된 구형 목록의 시각을 덮어쓰지 않는다.
    const fresh=[member(201),member(202)],request=await body(f,fresh),applied=await f.service.apply(request,'synthetic-admin');
    assert.equal(applied.count,2);assert.equal(applied.revision,request.operationId);
    assert.deepEqual((await f.db.collection('membership_csv_imports').doc(request.operationId).collection('members').orderBy('__name__').get()).docs.map(doc=>doc.data()),fresh);
    for(const backend of ['rtdb','legacy']){
      await flip(f);assert.equal((await f.transition.route()).backend,backend);
      assert.deepEqual((await f.membershipCsv.read()).members,fresh);
      assert.deepEqual(await f.membershipCsv.readMember(fresh[0].channelId),fresh[0]);
      assert.deepEqual((await f.service.status({operationId:request.operationId},'synthetic-admin')).result,applied);
      assert.deepEqual((await f.csvAdapters[backend].read('csv/legacyUsers')).value,ordered);
    }
    assert.deepEqual((await f.db.collection('membership_csv_users').orderBy('__name__').get()).docs.map(doc=>doc.data()),ordered);
    assert.equal((await f.transition.inspect()).unresolved,0);
  }finally{await f.close();}
});
for(const invalid of [{updatedAt:-1},{updatedAt:0,unexpected:true}])test(`구형 CSV의 ${Object.hasOwn(invalid,'unexpected')?'알 수 없는 필드':'잘못된 시각'}는 자동 보정 없이 복사를 거부한다`,async()=>{
  const f=await setup(),raw={...member(301),...invalid};
  try{
    await f.db.collection('membership_csv_users').doc(raw.channelId).set(raw);
    await assert.rejects(f.csvAdapters.legacy.read('csv/legacyUsers'));
    await assert.rejects(f.transition.copy(await f.transition.route()));
    assert.deepEqual((await f.db.collection('membership_csv_users').doc(raw.channelId).get()).data(),raw);
    assert.equal((await f.transition.route()).backend,'legacy');
  }finally{await f.close();}
});
for(const backend of ['legacy','rtdb'])test(`${backend} 두 SDK의 동시 관리자와 늦은 만료 작업은 활성 명단을 덮어쓰지 않는다`,async()=>{
  let at=Date.now();const f=await setup({csvNow:()=>at}),other=await setup({csvNow:()=>at},f.runId);
  try{if(backend==='rtdb')await flip(f);const a=await body(f,[member(1)]),b=await body(other,[member(2)]);
    const results=await Promise.allSettled([f.service.apply(a,'left'),other.service.apply(b,'right')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
    const request=await body(f,[member(3)]),before=await f.membershipCsv.read(),binding=C.digest(['admin',request.revision,request.fingerprint]);
    await f.membershipCsv.begin(request.operationId,binding,request.revision,'admin',at);await f.membershipCsv.stage(request.operationId,request.members);at+=120001;
    assert.equal((await f.service.status({operationId:request.operationId},'admin')).status,'failed');
    await assert.rejects(f.membershipCsv.commit(request.operationId,request.revision,{count:1,tiers:[{levelName:'A',count:1}],revision:request.operationId,updatedAt:at}));
    assert.deepEqual(await f.membershipCsv.read(),before);
  }finally{await other.close();await f.close();}
});
for(const backend of ['legacy','rtdb'])test(`${backend} 완료 응답 유실은 native 영수증으로 복구하며 동일 업로드를 다시 적용하지 않는다`,async()=>{
  let lost=false,opId;const f=await setup({onCheckpoint:async(stage,value)=>{if(lost&&stage==='businessCommitted'){lost=false;opId=value;throw new Error('합성 완료 응답 유실');}}});
  try{if(backend==='rtdb')await flip(f);const request=await body(f,[member(1)]),binding=C.digest(['admin',request.revision,request.fingerprint]);
    await f.membershipCsv.begin(request.operationId,binding,request.revision,'admin',Date.now());await f.membershipCsv.stage(request.operationId,request.members);lost=true;
    const result={count:1,tiers:[{levelName:'A',count:1}],revision:request.operationId,updatedAt:Date.now()};await assert.rejects(f.membershipCsv.commit(request.operationId,request.revision,result));
    assert.equal((await f.transition.inspect()).unresolved,1);const fresh=await setup({},f.runId);try{assert.deepEqual(await fresh.transition.recover(opId),result);}finally{await fresh.close();}
    assert.deepEqual(await f.service.apply(request,'admin'),result);await flip(f);assert.deepEqual((await f.service.status({operationId:request.operationId},'admin')).result,result);
  }finally{await f.close();}
});
test('FS 450명 초과 후보는 불변 배치 저장이 완료된 뒤에만 활성화되고 양방향 복원된다',async()=>{
  const f=await setup(),members=Array.from({length:451},(_,i)=>member(i));
  try{const request=await body(f,members);await f.service.apply(request,'admin');assert.equal((await f.db.collection('membership_csv_imports').doc(request.operationId).collection('members').get()).size,451);
    await flip(f);assert.deepEqual((await f.membershipCsv.read()).members,members.sort((a,b)=>a.channelId.localeCompare(b.channelId)));await flip(f);
    assert.equal((await createFirestoreMembershipCsvStore(f.db).read()).members.length,451);
  }finally{await f.close();}
});
test('YouTube 판정과 프로필 완료 사이 명단 전환은 같은 요청 자원을 기다린다',async()=>{
  const f=await setup(),uid='synthetic-youtube';let release,entered;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  try{await f.service.apply(await body(f,[member(1)]),'admin');const next=await body(f,[member(2)]);const at=Date.now(),nonce=hash(id());await f.membership.start(uid,'youtube',{nonceHash:nonce,startedAt:at,expiresAt:at+300000,localOnly:false});
    const pending=f.membership.withVerification(uid,'youtube',async()=>{await f.membership.consume(uid,'youtube',nonce);const csv=await f.membershipCsv.readMember(member(1).channelId);entered();await gate;
      return f.membership.complete(uid,'youtube',nonce,{status:'active',type:'csv',levelName:csv.levelName,userChannelId:member(1).channelId,verificationVersion:2,verificationProvider:'youtube',lastChecked:Date.now()});});
    await ready;let changed=false;const update=f.service.apply(next,'admin').then(()=>{changed=true;});
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(changed,false);release();assert.equal((await pending).stored,true);await update;
    assert.equal((await f.membership.read(uid)).membership.levelName,'A');assert.deepEqual((await f.membershipCsv.read()).members,[member(2)]);
  }finally{release?.();await f.close();}
});
test('명시 selector의 접속/run 변경과 구형 RTDB 제어 writer를 차단한다',async()=>{
  const f=await setup();try{const env={...process.env,USER_PROFILE_WRITER_MODE:'emulator',USER_PROFILE_WRITER_RUN_ID:f.runId},store=getMembershipCsvStore({env,writerBinding:f});
    await store.read();env.FIRESTORE_EMULATOR_HOST='emulators:8081';await assert.rejects(store.read(),{code:'USER_STORAGE_CONFIG_INVALID'});
    await flip(f);const request=await body(f,[member(1)]);await f.service.apply(request,'admin');
    await assert.rejects(createMembershipCsvStore({database:f.database}).begin(id(),hash('synthetic'),request.operationId,'old',Date.now()));
  }finally{await f.close();}
});
for(const backend of ['legacy','rtdb'])test(`${backend} 지연된 활성화 RPC는 새 SDK 영구 취소 뒤 명단을 교체하지 않는다`,async()=>{
  const f=await setup(),fresh=await setup({},f.runId);let release,entered,op;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  try{if(backend==='rtdb')await flip(f);await f.service.apply(await body(f,[member(1)]),'admin');const previous=await f.membershipCsv.read(),request=await body(f,[member(2)]);
    const binding=C.digest(['admin',request.revision,request.fingerprint]);await f.membershipCsv.begin(request.operationId,binding,request.revision,'admin',Date.now());await f.membershipCsv.stage(request.operationId,request.members);
    const adapter=f.csvAdapters[backend],commit=adapter.commit;adapter.commit=async value=>{op=value;entered();await gate;return commit(value);};
    const pending=f.membershipCsv.commit(request.operationId,request.revision,{count:1,tiers:[{levelName:'B',count:1}],revision:request.operationId,updatedAt:Date.now()});await ready;
    assert.equal((await fresh.transition.fenceUncommitted(op.id)).status,'cancelled');release();await assert.rejects(pending,{code:'WRITER_CANCELLED'});
    assert.deepEqual(await f.membershipCsv.read(),previous);await flip(f);assert.deepEqual(await f.membershipCsv.read(),previous);
  }finally{release?.();await fresh.close();await f.close();}
});
for(const backend of ['legacy','rtdb'])test(`${backend} DB 승인 콜백 직전 만료는 준비된 후보를 활성화하지 않는다`,async()=>{
  let at=Date.now();const f=await setup({csvNow:()=>at});
  try{if(backend==='rtdb')await flip(f);const request=await body(f,[member(1)]),bound=C.digest(['admin',request.revision,request.fingerprint]);
    await f.membershipCsv.begin(request.operationId,bound,request.revision,'admin',at);await f.membershipCsv.stage(request.operationId,request.members);
    if(backend==='legacy'){const run=f.db.runTransaction;let once=true;f.db.runTransaction=action=>run(async tx=>{const get=tx.get.bind(tx);tx.get=ref=>{if(once&&ref.path?.includes('/membershipCsvWriterReceipts/')){once=false;at+=120001;}return get(ref);};return action(tx);});}
    else{const ref=f.database.ref;let once=true;f.database.ref=name=>{const target=ref(name),transaction=target.transaction.bind(target);target.transaction=(...args)=>{if(once&&name.startsWith('membershipCsv/control/')){once=false;at+=120001;}return transaction(...args);};return target;};}
    await assert.rejects(f.membershipCsv.commit(request.operationId,request.revision,{count:1,tiers:[{levelName:'A',count:1}],revision:request.operationId,updatedAt:at}),{status:409});assert.equal((await f.service.summary()).count,0);
  }finally{await f.close();}
});
for(const surface of ['adminPages','adminBackend'])test(`HTTP ${surface} CSV와 세션은 같은 전환을 따르고 CSRF·현재 권한·결과 계약을 유지한다`,async()=>{
  const f=await setup();let server,role='admin',cookie='';const uid='synthetic-csv-admin',session='synthetic-csv-cookie';
  try{const handlers=createAdminRouteHandlers({env:environment(f),writerBinding:f,emulatorDependencies:{
      auth:{verifyIdToken:async()=>({uid}),getUser:async()=>({uid,customClaims:{role}}),createSessionCookie:async()=>session,verifySessionCookie:async()=>({uid})},template:async()=>'<html></html>',
      membershipCsv:{summary:async()=>assert.fail('단독/다른 DB의 CSV 서비스 우회 금지')},
    },proxy:()=>assert.fail('운영 proxy 금지'),productionDependencies:()=>assert.fail('운영 의존성 금지')});
    const app=express();app.use(express.json());app.use(handlers[surface]);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    const origin=surface==='adminBackend'?new URL(require('../services/adminTransport').BACKEND_URL).origin:base;
    async function call(route,method='GET',data={},extra={}){const response=await fetch(base+(surface==='adminBackend'?'/adminBackend?route='+encodeURIComponent(route):route),{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},...(['GET','HEAD'].includes(method)?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null};}
    assert.equal((await call('/admin/api/membership-csv')).status,401);assert.equal((await call('/admin/session','POST',{}, {Authorization:'Bearer synthetic-token'})).status,200);
    const preview=await call('/admin/api/membership-csv/preview','POST',{members:[member(1)]});assert.equal(preview.status,200);
    const request={members:[member(1)],revision:preview.body.revision,fingerprint:preview.body.fingerprint,operationId:id()};
    const applied=await call('/admin/api/membership-csv','POST',request);assert.equal(applied.status,200);assert.equal(applied.body.count,1);
    await flip(f);const status=await call('/admin/api/membership-csv/status','POST',{operationId:request.operationId});assert.equal(status.body.status,'completed');assert.equal(status.body.result.count,1);
    assert.equal((await call('/admin/api/membership-csv','POST',request)).status,200);assert.equal((await call('/admin/api/membership-csv','POST',request,{Origin:'https://outside.invalid'})).status,403);
    role='user';assert.equal((await call('/admin/api/membership-csv')).status,401);assert.equal((await f.service.summary()).count,1);
  }finally{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await f.close();}
});
test('별도 writer CSV CLI는 dry-run 무접속·원본 파일 보존과 현재 backend의 적용을 유지한다',{timeout:60000},async()=>{
  const f=await setup({},id(),true),dir=await fs.mkdtemp(path.join(os.tmpdir(),'csv-writer-cli-')),filename=path.join(dir,'synthetic.csv');
  const content='회원,프로필에 연결,현재 등급\n합성 회원,https://youtube.com/channel/'+member(1).channelId+',A\n';
  const script=path.resolve(__dirname,'../../scripts/upload_membership_csv.js');
  async function run(args){const result=await execFile(process.execPath,[script,...args],{env:environment(f),timeout:20000,maxBuffer:32768});assert.equal(result.stdout.includes(member(1).channelId),false);return result;}
  try{await fs.writeFile(filename,content);const before=await f.transition.inspect();await run(['--writer-emulator','--dry-run',filename]);assert.deepEqual(await f.transition.inspect(),before);
    await run(['--writer-emulator',filename]);assert.deepEqual((await f.membershipCsv.read()).members,[member(1)]);assert.equal(await fs.readFile(filename,'utf8'),content);
    await flip(f);await run(['--writer-emulator',filename]);assert.equal((await f.service.summary()).count,1);assert.equal(await fs.readFile(filename,'utf8'),content);await flip(f);
  }finally{await fs.rm(dir,{recursive:true,force:true});await f.close();}
});
for(const backend of ['legacy','rtdb'])test(`${backend} 가득 찬 제어 이력은 확정 작업을 보관한 뒤 제거하고 역전환에서도 결과 조회를 유지한다`,async()=>{
  const f=await setup();
  try{const operations={},physical={};let oldest;
    for(let i=0;i<CONTROL_LIMIT;i++){const operationId=id();oldest ||= operationId;
      operations[operationId]={binding:hash('synthetic-'+i),revision:require('../services/user-storage/membershipCsvStore').EMPTY_REVISION,actor:'admin',startedAt:i,status:'failed'};
      physical[operationId]=C.physicalOperation(operations[operationId]);await f.db.collection('membership_csv_imports').doc(operationId).set(physical[operationId]);}
    const value={active:null,operations,baseRevision:C.legacyRevision([])},entry={key:'csv/control',exists:true,token:'0',value};
    // 과거 이력을 가진 합성 native 견본. 실제 사용자 자료·운영 이전 명령은 실행하지 않는다.
    await f.db.collection('membershipCsvWriterRecords').doc(encodeKey('csv/control')).set({format:1,revision:1,generation:0,exists:true,digest:entryDigest(entry),payload:encodeValue(value),physical:{current:null,operations:physical},ownedOperations:Object.keys(operations)});
    if(backend==='rtdb')await flip(f);const request=await body(f,[member(1)]);
    await f.membershipCsv.begin(request.operationId,C.digest(['admin',request.revision,request.fingerprint]),request.revision,'admin',Date.now());
    assert.equal((await f.membershipCsv.status(oldest)).status,'failed');assert.equal(Object.keys((await f.csvAdapters[backend].read('csv/control')).value.operations).length,CONTROL_LIMIT);
    await flip(f);assert.equal((await f.membershipCsv.status(oldest)).status,'failed');assert.equal((await f.membershipCsv.status(request.operationId)).status,'pending');
  }finally{await f.close();}
});
