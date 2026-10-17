'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../services/membershipCsvWriterContract');
const {parseArgs,validateTarget}=require('../../scripts/upload_membership_csv');
test('CSV 공통 논리 자료는 후보 변조·알 수 없는 원본 필드와 자원 키 저장을 거부한다',()=>{
  const member={channelId:'UC'+'a'.repeat(22),memberName:'합성',levelName:'A'},value={members:[member],fingerprint:C.digest([member])};
  assert.equal(C.candidateValue(value).members[0].levelName,'A');assert.throws(()=>C.candidateValue({...value,members:[{...member,levelName:'B'}]}));
  assert.throws(()=>C.fromLegacyOperation({actor:'admin',binding:'a'.repeat(64),status:'pending',startedAt:0,unexpected:true}));
  assert.throws(()=>C.checkCsvKey('csvRequest/'+'a'.repeat(32)));assert.throws(()=>C.checkCsvCommand({changes:[{key:'csv/legacyUsers',exists:true,value:[]}],details:{kind:'membershipCsv',action:'stage',businessId:'a'.repeat(32),controlToken:'0'}}));
});
test('기존 pending 작업의 기대 revision을 추측하지 않고 failed 전이만 수용한다',()=>{
  const raw={actor:'admin',binding:'a'.repeat(64),status:'pending',startedAt:0},record=C.fromLegacyOperation(raw);
  assert.equal(record.revision,null);assert.equal(C.operationValue({...record,status:'failed'}).legacySource.status,'pending');
  assert.equal(C.inactive({details:{action:'commit',businessId:'a'.repeat(32)}},{operations:{['a'.repeat(32)]:record}},()=>1),true);
});
test('CSV writer CLI는 독립 명시 대상·demo run/SDK 경계를 유지한다',()=>{
  assert.equal(parseArgs(['--writer-emulator','--dry-run','/synthetic.csv']).writerEmulator,true);
  assert.throws(()=>parseArgs(['--writer-emulator','--rtdb-emulator','/synthetic.csv']));assert.throws(()=>validateTarget(parseArgs(['--writer-emulator','/synthetic.csv']),{}));
});
test('구형 회원 목록의 updatedAt만 무손실 허용하고 신규 후보의 3필드 계약은 유지한다',()=>{
  const member={channelId:'UC'+'b'.repeat(22),memberName:'합성 회원',levelName:'A'};
  const original=[member],normal={members:original,fingerprint:C.digest(original)};
  assert.deepEqual(C.valueFor('csv/legacyUsers',original),original);
  assert.deepEqual(C.candidateValue(normal),normal);
  assert.equal(C.legacyRevision(original),'legacy-'+require('node:crypto').createHash('sha256').update(JSON.stringify(original)).digest('hex'));
  for(const updatedAt of [0,1700000000000,Number.MAX_SAFE_INTEGER]){
    const members=[{...member,updatedAt}],before=structuredClone(members);
    const legacy={members,fingerprint:C.digest(members),legacyList:true};
    assert.deepEqual(C.valueFor('csv/legacyUsers',members),before);
    assert.deepEqual(C.candidateValue(legacy),{members:before,fingerprint:legacy.fingerprint});
    assert.deepEqual(members,before);
    assert.throws(()=>C.candidateValue({members,fingerprint:C.digest(members)}));
    assert.throws(()=>C.candidateValue({...legacy,fingerprint:C.digest(original)}));
  }
  for(const updatedAt of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'0',null,NaN,Infinity]){
    const members=[{...member,updatedAt}];
    assert.throws(()=>C.valueFor('csv/legacyUsers',members));
    assert.throws(()=>C.candidateValue({members,fingerprint:C.digest(members),legacyList:true}));
  }
  for(const changed of [{...member,updatedAt:0,unexpected:true},{...member,memberName:' 합성 회원 ',updatedAt:0},{...member,channelId:'invalid',updatedAt:0}]){
    const members=[changed];
    assert.throws(()=>C.valueFor('csv/legacyUsers',members));
    assert.throws(()=>C.candidateValue({members,fingerprint:C.digest(members),legacyList:true}));
  }
});
