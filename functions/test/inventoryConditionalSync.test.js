'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createInventorySyncReader, snapshotToken } = require('../services/inventoryConditionalSync');
const writer = { backend: 'rtdb', epoch: 2, phase: 'accepting' }, record = { exists: true, revision: 8, generation: 3,
  value: { version: 3, locations: {}, rarities: {}, cards: {} } };
const migration = {pendingCount:0,unresolvedCount:0,nextRetryAt:0,retryAt:0,retryableError:false};
function setup() {
  const count = { metadata: 0, snapshot: 0, route: 0 }, state = { writer, record, metadata: { ...record, value: undefined, storageFormat: 'parts', syncMigration: migration } };
  const read = createInventorySyncReader({ now: () => state.now ?? Date.now(), route: async () => { count.route++; return state.route ? state.route() : state.writer; },
    metadata: async () => { count.metadata++; if (state.failure) throw state.failure; return state.metadata; },
    snapshot: async () => { count.snapshot++; return state.record; }, migrationStatus: () => ({ status: state.incomplete ? 'pending' : 'complete', unresolvedCount: state.unresolved ? 1 : 0 }) });
  return { count, state, read };
}
test('같은 head는 본문/이관을 읽지 않으며 UID·epoch·revision·generation이 다르면 전체 snapshot이다', async () => {
  const f = setup(), token = snapshotToken('synthetic', writer, record);
  assert.deepEqual(await f.read('synthetic', token), { unchanged: true, token });
  assert.deepEqual(f.count, { metadata: 1, snapshot: 0, route: 2 });
  for (const change of [{ revision: 9 }, { generation: 4 }, { exists: false }]) {
    f.state.metadata = { ...f.state.metadata, ...change };
    assert.equal((await f.read('synthetic', token)).unchanged, undefined);
  }
  assert.equal((await f.read('other', token)).unchanged, undefined);
  f.state.writer = { ...writer, epoch: 3 }; assert.equal((await f.read('synthetic', token)).unchanged, undefined);
});
test('형식 버전3은 변경 버전이 아니며 full 결과의 정확한 revision으로만 token을 발급한다', async () => {
  const f = setup(), result = await f.read('synthetic');
  assert.equal(result.token, snapshotToken('synthetic', writer, record)); assert.equal(result.data, record.value);
  f.state.record = { ...record, revision: 9 }; assert.notEqual((await f.read('synthetic')).token, result.token);
  assert.equal(f.count.metadata, 0); // 전체 읽기 뒤의 다른 head를 이전 본문에 붙이지 않는다.
});
test('legacy·drain은 전체 호환 경로로 넘기며 깨진/구형 metadata를 unchanged로 인정하지 않는다', async () => {
  for (const writerPatch of [{ backend: 'legacy' }, { phase: 'draining' }]) {
    const f = setup(); f.state.writer = { ...writer, ...writerPatch }; assert.equal(await f.read('synthetic'), undefined);
    assert.equal(f.count.snapshot, 0);
  }
  const f = setup(), token = snapshotToken('synthetic', writer, record); f.state.metadata.storageFormat = 'legacy';
  assert.equal((await f.read('synthetic', token)).unchanged, undefined);
  f.state.failure = Error('synthetic unavailable'); await assert.rejects(f.read('synthetic', token));
});
test('변경 조회 도중 전환 epoch·phase가 바뀌면 cached 성공이나 새 token을 반환하지 않는다', async () => {
  for (const token of [undefined, snapshotToken('synthetic', writer, record)]) {
    const f = setup(); f.state.route = () => f.count.route === 1 ? writer : { ...writer, epoch: 3 };
    await assert.rejects(f.read('synthetic', token), { code: 'WRITER_FENCED' });
  }
});
test('미완료 이관·구형 집계·부재 인벤토리는 재사용 token을 제공하지 않는다', async () => {
  for (const mode of ['pending', 'arrays', 'absent', 'unprepared']) {
    const f = setup();
    if (mode === 'pending') f.state.incomplete = true;
    if (mode === 'unprepared') f.state.record = { ...record, value: { ...record.value, cards: { N: { cid: null, items: [] } } } };
    if (mode === 'arrays') f.state.record = { ...record, value: { ...record.value, locations: [] } };
    if (mode === 'absent') f.state.record = { ...record, exists: false };
    assert.equal((await f.read('synthetic')).token, undefined);
  }
});

test('미확정 CID도 검증된 기한 전까지 재사용하고 정확한 만료 시점부터 전체 snapshot이다', async () => {
 const f=setup(), now=Date.now(), due=now+1000; f.state.now=now;
 f.state.record={...record,value:{...record.value,cards:{N:{cid:null,cidCheckedAt:due-86400000,items:[]}}}};
 f.state.unresolved=true;f.state.metadata.syncMigration={...migration,unresolvedCount:1,nextRetryAt:due};
 const first=await f.read('synthetic');assert(first.token);
 f.state.now=due-1;assert.equal((await f.read('synthetic',first.token)).unchanged,true);
 f.state.now=due;assert.equal((await f.read('synthetic',first.token)).unchanged,undefined);assert.equal(f.count.snapshot,2);
 f.state.now=due+1;assert.equal((await f.read('synthetic')).token,undefined);
});
test('기한 결측·손상·미완료·오류는 재사용하지 않고 전환 조회 대기 중 만료도 전체 준비한다',async()=>{
 for(const patch of [undefined,{...migration,pendingCount:1},{...migration,retryableError:true},{...migration,unresolvedCount:1,nextRetryAt:0},{...migration,nextRetryAt:1},{...migration,retryAt:10}]){
  const f=setup();f.state.metadata.syncMigration=patch;assert.equal((await f.read('synthetic',snapshotToken('synthetic',writer,record))).unchanged,undefined);
 }
 const f=setup(),now=Date.now();f.state.now=now;f.state.metadata.syncMigration={...migration,unresolvedCount:1,nextRetryAt:now+1};
 f.state.route=()=>{if(f.count.route===2)f.state.now=now+1;return writer;};
 assert.equal((await f.read('synthetic',snapshotToken('synthetic',writer,record))).unchanged,undefined);assert.equal(f.count.snapshot,1);
});

test('저장된 CID 요약은 태그·타입·기한을 엄격히 읽고 결측·손상은 전체 조회 대상으로 둔다',()=>{
 const {readSyncMigration}=require('../services/user-storage/inventoryApiSummary');const {encodeValue}=require('../services/user-storage/codec');
 const future={...migration,unresolvedCount:1,nextRetryAt:Date.now()+10000};assert.deepEqual(readSyncMigration(encodeValue(future).value),future);
 for(const value of [undefined,null,{}, {t:'object'},encodeValue({...future,nextRetryAt:'later'}).value,encodeValue({...future,pendingCount:1}).value,encodeValue({...future,nextRetryAt:Date.now()-1}).value,encodeValue({...future,extra:true}).value])assert.equal(readSyncMigration(value),undefined);
});
