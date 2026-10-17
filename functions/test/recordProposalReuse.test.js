'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeValue, decodeValue } = require('../services/user-storage/codec');
function fixture(hook, options = {}) {
  const initial = { format: 1, revision: 1, generation: 0, tombstone: false, payload: encodeValue({ body: '합성'.repeat(4000) }) };
  let raw = structuredClone(initial), callbacks = 0, decodes = 0, encodes = 0;
  const snapshot = value => ({ val: () => structuredClone(value) });
  const database = { ref: () => ({
    on: (_event, cb) => cb(snapshot(raw)), off: () => {},
    transaction: async cb => {
      let proposal;
      for (let n = 0; n < 3; n++) { callbacks++; proposal = cb(hook ? hook(structuredClone(raw), n) : structuredClone(raw)); }
      if (proposal === undefined) return { committed: false, snapshot: snapshot(raw) };
      raw = structuredClone(proposal); return { committed: true, snapshot: snapshot(raw) };
    },
  }) };
  const store = createRecordStore({ database, path: 'synthetic', recordCodec: {
    decode: raw => { decodes++; return raw; }, encode: raw => { encodes++; return raw; },
  }, ...options });
  return { store, get raw() { return raw; }, get counts() { return { callbacks, decodes, encodes }; }, initial };
}
test('같은 원문인 SDK 재콜백은 제안을 한 번 변환하고 서버 확정 snapshot을 반환한다', async () => {
  const f = fixture(), value = { n: 2 };
  const result = await f.store.compareAndSet('item', 1, value);
  assert.deepEqual(result.value, value); assert.equal(result.revision, 2);
  assert.deepEqual(f.counts, { callbacks: 3, decodes: 3, encodes: 1 });
  result.value.n = 99; value.n = 100; assert.equal(decodeValue(f.raw.payload).n, 2);
});
test('같은 revision이어도 원문이 다르면 기존 형식 검증을 생략하지 않는다', async () => {
  const f = fixture(raw => ({ ...raw, unexpected: true }));
  await assert.rejects(f.store.compareAndSet('item', 1, { n: 2 }), { code: 'USER_STORAGE_INVALID_RECORD' });
  assert.deepEqual(f.raw, f.initial);
});
test('다른 writer revision과 최초 null 콜백은 기존 CAS 충돌로 거부한다', async () => {
  for (const hook of [raw => ({ ...raw, revision: 2 }), () => null]) {
    const f = fixture(hook); await assert.rejects(f.store.compareAndSet('item', 1, { n: 2 }), { code: 'USER_STORAGE_CONFLICT' });
    assert.deepEqual(f.raw, f.initial);
  }
});
test('사용자 validateCurrent가 있으면 매 SDK 콜백의 원본 검증을 유지한다', async () => {
  const f = fixture(); let checked = 0;
  await f.store.compareAndSet('item', 1, { n: 2 }, { validateCurrent: current => { checked++; assert.equal(current.revision, 1); } });
  assert.equal(checked, 3); assert.equal(f.counts.encodes, 3);
});
