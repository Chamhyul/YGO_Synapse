'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture() {
  const events=[], role=deferred(), inventory=deferred(), profile=deferred(), claims=deferred(), conditional=deferred();
  const mocks={
    './membershipPolicy': { normalizeSourceMembership: x=>x || null, resolveEffectiveMembership: (r,x)=>({ role:r, source:x }) },
    './inventoryRequestTiming': { measure: (_n, fn)=>fn() },
    './userProfileRepository': { getUserProfileRepository: ()=>({ read: ()=>{events.push('profile');return profile.promise;} }) },
    '../utils/auth': { getVerifiedAccountRole: ()=>{events.push('role');return role.promise;} },
    '../utils/inventoryStorage': { readInventoryForSync: ()=>{events.push('inventory-check');return conditional.promise;}, downloadInventory: async ()=>({data:{amount:0,cards:{}}}), updateInventoryWithRetry: ()=>assert.fail('unexpected rewrite') },
    './inventoryMigrationService': { ensureInventoryV2: ()=>{events.push('inventory');return inventory.promise;}, inventoryMigrationStatus: ()=>({status:'ready'}) },
    './membershipClaims': { syncMembershipClaims: ()=>{events.push('claims');return claims.promise;},
      readMembershipClaimsAfterVerification: ()=>{events.push('claims-read');return claims.promise;} },
    './user-storage/membershipStore': { membershipPermissionVersion: ()=> 'same' },
  };
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/loginUserData'),'utf8'),{module:mod, exports:mod.exports, require:n=>{assert(n in mocks,n);return mocks[n];}, process:{env:{USER_STORAGE_BACKEND:'rtdb'}}, console:{warn(){}}});
  return {events,role,inventory,profile,claims,conditional,read:mod.exports.readLoginUserData,account:mod.exports.readLoginAccountData};
}
test('역할·인벤토리·프로필·claims를 독립 시작하고 최종 원본 버전을 대조한다',async()=>{
  const f=fixture();const result=f.read({},'synthetic');
  assert.deepEqual(f.events,['role','inventory','profile','claims']);
  f.profile.resolve({exists:true,value:{Nickname:'fixture',settings:{membership:{}}}});await new Promise(setImmediate);
  assert.deepEqual(f.events,['role','inventory','profile','claims']);
  f.claims.resolve({status:'synced',version:'changed'});f.role.resolve('none');
  f.inventory.resolve({amount:2,cards:{'TEST-1':{name:'카드',items:[{qty:2,loc:'A'}]}},rarities:{empty:0,positive:2},locations:{A:2}});
  const data=await result;assert.equal(data.amount,2);assert.equal(data.allCards[0][3],2);
  assert.equal(data.membershipClaims.status,'pending');assert.equal(data.nickname,'fixture');assert.deepEqual(Object.keys(data.rarities),['positive']);
});
test('병렬 분기 실패에도 진행 중인 claims를 끝까지 회수하고 원래 오류를 반환한다',async()=>{
  const f=fixture(), failure=Object.assign(Error('unavailable'),{code:'ACCOUNT_ROLE_UNAVAILABLE'});let ended=false;
  const result=f.read({},'synthetic').then(()=>assert.fail(),e=>{ended=true;assert.equal(e,failure);});
  f.role.reject(failure);f.profile.resolve({exists:false});f.inventory.resolve({cards:{}});
  await new Promise(setImmediate);assert.equal(ended,false);assert(f.events.includes('claims'));
  f.claims.resolve({status:'pending'});await result;assert(ended);
});
test('인벤토리 변환 실패는 기존 fallback·재시도 상태로 반환하며 새 프로필을 만들지 않는다',async()=>{
  const f=fixture(), result=f.read({},'synthetic');f.role.resolve('none');f.profile.resolve({exists:false});f.inventory.reject(Error('migration'));f.claims.resolve({status:'pending'});
  const data=await result;assert.equal(data.inventoryMigration.status,'retryableError');assert.equal(data.createdAt,null);assert.equal(data.nickname,'');
});

test('프로필 실패나 지연이 claims 시작을 막지 않고 모든 분기를 회수한다',async()=>{
 const f=fixture(),failure=Error('profile unavailable');let finished=false;
 const result=f.read({},'synthetic').then(()=>assert.fail(),e=>{assert.equal(e,failure);finished=true;});
 assert(f.events.includes('claims'));f.profile.reject(failure);f.role.resolve('none');f.inventory.resolve({cards:{}});
 await new Promise(setImmediate);assert.equal(finished,false);f.claims.resolve({status:'pending'});await result;
});

test('가입 snapshot은 추가 프로필 조회 없이 사용하고 claims 버전 충돌은 pending으로 유지한다', async () => {
  const f = fixture(), snapshot = { exists: true, value: { Nickname: 'registered', settings: { membership: {} } } };
  const result = f.read({}, 'synthetic', { initialProfile: snapshot });
  assert.deepEqual(f.events, ['role', 'inventory', 'claims']);
  f.role.resolve('none'); f.inventory.resolve({ cards: {} }); f.claims.resolve({ status: 'synced', version: 'changed' });
  const data = await result;
  assert.equal(data.nickname, 'registered'); assert.equal(data.membershipClaims.status, 'pending');
  assert.equal(snapshot.value.Nickname, 'registered');
});

test('프로필 없는 기존 회원 snapshot도 조회나 생성 없이 기존 기본값으로 반환한다', async () => {
  const f = fixture(), result = f.read({}, 'synthetic', { initialProfile: { exists: false } });
  f.role.resolve('none'); f.inventory.resolve({ cards: {} }); f.claims.resolve({ status: 'pending' });
  const data = await result;
  assert.equal(data.nickname, ''); assert.equal(data.createdAt, null); assert(!f.events.includes('profile'));
});


test('계정 요약은 인벤토리·claims를 호출하거나 빈 인벤토리 필드를 반환하지 않는다', async () => {
  const f=fixture(), snapshot={exists:true,value:{Nickname:'fixture',settings:{theme:'dark',membership:{}}}};
  const pending=f.account({},'synthetic',{initialProfile:snapshot});
  assert.deepEqual(f.events,['role']);f.role.resolve('none');const data=await pending;
  assert.equal(data.success,true);assert.equal(data.nickname,'fixture');assert.equal(data.settings.theme,'dark');
  for(const key of ['allCards','amount','locations','rarities','membershipClaims'])assert(!Object.hasOwn(data,key));
});
test('계정 요약은 역할 실패 시 성공하지 않으며 시작한 프로필 조회를 회수한다', async () => {
  const f=fixture();let done=false;const failure=Object.assign(Error('role'),{code:'ACCOUNT_ROLE_UNAVAILABLE'});
  const pending=f.account({},'synthetic').then(()=>assert.fail(),e=>{assert.equal(e,failure);done=true;});
  f.role.reject(failure);await new Promise(setImmediate);assert(!done);f.profile.resolve({exists:false});await pending;
  assert.deepEqual(f.events,['role','profile']);
});

for (const status of ['pending', 'synced']) test(`재인증 후 전체 조회는 ${status}에서 claims 쓰기를 시작하지 않고 인벤토리 계약을 유지한다`, async () => {
  const f = fixture(), pending = f.read({}, 'synthetic', { membershipClaimsReadOnly: true });
  assert.deepEqual(f.events, ['role', 'inventory', 'profile', 'claims-read']);
  f.role.resolve('none'); f.inventory.resolve({ amount: 1, cards: { TEST: { name: '합성 카드', items: [{ qty: 1 }] } } });
  f.profile.resolve({ exists: true, value: { settings: { membership: {} } } });
  f.claims.resolve({ status, ...(status === 'synced' ? { version: 'same' } : {}) });
  const data = await pending;
  assert.equal(data.membershipClaims.status, status); assert.equal(data.amount, 1); assert.equal(data.allCards.length, 1);
});

test('읽기 전용 재인증 조회도 프로필과 claims 버전이 다르면 synced를 반환하지 않는다', async () => {
  const f = fixture(), pending = f.read({}, 'synthetic', { membershipClaimsReadOnly: true });
  f.role.resolve('none'); f.inventory.resolve({ cards: {} }); f.profile.resolve({ exists: false });
  f.claims.resolve({ status: 'synced', version: 'stale' });
  assert.equal((await pending).membershipClaims.status, 'pending');
});


test('조건부 인벤토리 일치도 현재 역할·프로필·claims를 확인하고 인벤토리 필드를 생략한다', async () => {
  const f = fixture(), pending = f.read({}, 'synthetic', { inventoryConditional: true, inventoryToken: 'synthetic' });
  f.conditional.resolve({ unchanged: true, token: 'synthetic' });
  f.role.resolve('none'); f.profile.resolve({ exists: true, value: { Nickname: '현재 이름', settings: {} } });
  f.claims.resolve({ status: 'pending' }); const data = await pending;
  assert.equal(data.nickname, '현재 이름'); assert.equal(data.inventorySync.status, 'unchanged');
  assert.equal(data.membershipClaims.status, 'pending'); assert(!f.events.includes('inventory'));
  for (const key of ['allCards','amount','locations','rarities','names','inventoryVersion']) assert(!Object.hasOwn(data,key));
});
test('조건부 목록이 같아도 현재 권한 조회 실패를 성공으로 바꾸지 않는다', async () => {
  const f = fixture(), error = Object.assign(Error('unavailable'), { code: 'ACCOUNT_ROLE_UNAVAILABLE' });
  const pending = f.read({}, 'synthetic', { inventoryConditional: true });
  f.conditional.resolve({ unchanged: true, token: 'synthetic' }); f.role.reject(error);
  f.profile.resolve({ exists: false }); f.claims.resolve({ status: 'pending' }); await assert.rejects(pending, error);
});
test('조건부 조회 미지원이면 기존 전체 이관을 실행하고 API 필드를 유지한다', async () => {
  const f = fixture(), pending = f.read({}, 'synthetic', { inventoryConditional: true });
  f.conditional.resolve(undefined); f.inventory.resolve({ cards: {}, amount: 0 });
  f.role.resolve('none'); f.profile.resolve({ exists: false }); f.claims.resolve({ status: 'pending' });
  const data = await pending; assert.equal(data.inventorySync.status, 'full'); assert(Array.isArray(data.allCards));
  assert(f.events.includes('inventory')); assert(!Object.hasOwn(data.inventorySync,'token'));
});
