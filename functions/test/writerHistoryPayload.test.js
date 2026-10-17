'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { pack, unpack, decodeBody } = require('../services/user-storage/writerHistoryPayload');
const { fingerprint } = require('../services/userMigrationRehearsal');
function envelope(value) { const p = pack(value); return { ...p, format: 2, digest: fingerprint(value) }; }
const body = () => ({ text: '한글🙂'.repeat(100), timestamp: new Timestamp(123, 456), date: new Date(1000), zero: -0,
  holes: [null, , []], prototype: Object.assign(Object.create(null), JSON.parse('{"__proto__":"plain"}')) });
test('요청/확정 본문과 큰 반환값의 공유는 버전·시각·빈값·원형·사용자 참조 모양을 보존한다', async () => {
  const value = { changes: [{ token: 'old', value: body() }], receipt: { changes: [{ token: 'new', value: body() }] },
    result: { historyBody: '사용자 값', text: 'x'.repeat(1000) } };
  value.receipt.result = value.result;
  const e = envelope(value), calls = [];
  const restored = await unpack(e, async digest => { calls.push(digest); return e.bodies.get(digest); });
  assert.equal(e.bodies.size, 2); assert.equal(e.refs.length, 4); assert.equal(calls.length, 2);
  assert.deepEqual(restored, value); assert.equal(Object.is(restored.changes[0].value.zero, -0), true);
  assert.equal(1 in restored.changes[0].value.holes, false);
  restored.changes[0].value.text = 'changed'; assert.equal(restored.receipt.changes[0].value.text, value.receipt.changes[0].value.text);
});
test('서버 확정 시각이 바뀐 본문은 공유하지 않고 원래 요청과 실제 결과를 각각 복원한다', async () => {
  const before = body(), after = { ...before, timestamp: new Timestamp(124, 999) };
  const value = { changes: [{ value: before }], receipt: { changes: [{ value: after }] } }, e = envelope(value);
  assert.equal(e.bodies.size, 2); assert.deepEqual(await unpack(e, async digest => e.bodies.get(digest)), value);
});
test('인벤토리 준비 본문도 같은 내용을 참조하되 내용 순서가 다른 객체는 별도로 보존한다', async () => {
  const a = { first: 'x'.repeat(1000), second: 1 }, b = { second: 1, first: a.first };
  const value = { changes: [{ value: a }], receipt: { changes: [{ value: b }] }, details: { blobs: [{ hash: 'keep', value: a }] } }, e = envelope(value);
  assert.equal(e.bodies.size, 2); assert.equal(e.refs.length, 3);
  assert.deepEqual(await unpack(e, async digest => e.bodies.get(digest)), value);
});
test('누락/손상/중복/임의 경로/인라인 치환/본문 지문 변경은 복원 전에 거부한다', async () => {
  const value = { changes: [{ value: body() }], result: null }, e = envelope(value), load = async digest => e.bodies.get(digest);
  await assert.rejects(unpack(e, async () => undefined), { code: 'WRITER_HISTORY_CONFLICT' });
  await assert.rejects(unpack(e, async digest => ({ ...e.bodies.get(digest), encoded: '{}' })), { code: 'WRITER_HISTORY_CONFLICT' });
  await assert.rejects(unpack({ ...e, refs: [...e.refs, e.refs[0]] }, load), { code: 'WRITER_HISTORY_CONFLICT' });
  await assert.rejects(unpack({ ...e, refs: [{ ...e.refs[0], path: ['__proto__', 'value'] }] }, load), { code: 'WRITER_HISTORY_CONFLICT' });
  await assert.rejects(unpack({ ...e, value, refs: e.refs }, load), { code: 'WRITER_HISTORY_CONFLICT' });
  await assert.rejects(unpack({ ...e, digest: '0'.repeat(64) }, load), { code: 'WRITER_HISTORY_CONFLICT' });
  assert.throws(() => decodeBody({ ...e.bodies.values().next().value, extra: true }, e.refs[0].digest), { code: 'WRITER_HISTORY_CONFLICT' });
});
