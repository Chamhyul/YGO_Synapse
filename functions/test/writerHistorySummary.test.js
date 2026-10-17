'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSummaryCodec } = require('../services/user-storage/writerHistorySummary');
const { encodeKey, encodeValue } = require('../services/user-storage/codec');
const { fingerprint } = require('../services/userMigrationRehearsal');
const { analyze } = require('../services/user-storage/writerHistoryPayload');
const id = 'a'.repeat(32), path = 'synthetic/summaries/operations', options = { basePath: `${path}/${encodeKey(id)}/payload` };
const codec = createSummaryCodec({ path, kind: 'operations' });
function envelope(kind = 'operations', status = 'completed') {
  const value = { id, kind, status, digest: 'b'.repeat(64), bytes: 1234, backend: 'legacy', epoch: 0, capturedSequence: 0 };
  return { format: 1, kind, value, digest: fingerprint(value) };
}
test('요약 v2는 주소의 ID/종류를 복원하고0·확정 순번·기존 응답/지문을 보존한다', () => {
  const e = envelope(), raw = codec.encode(e, options);
  assert.deepEqual(codec.decode(raw, options), e); assert.equal(raw.v, 2);
  assert.equal('id' in raw, false); assert.equal('kind' in raw, false);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < Buffer.byteLength(JSON.stringify(encodeValue(e))));
  const minimal = envelope(); delete minimal.value.backend; delete minimal.value.epoch; delete minimal.value.capturedSequence;
  minimal.digest = fingerprint(minimal.value); assert.deepEqual(codec.decode(codec.encode(minimal, options), options), minimal);
});
test('이전 범용 요약과 external 복구 종료/복구 ID도 원래 값으로 읽는다', () => {
  const e = envelope(); assert.deepEqual(codec.decode(encodeValue(e), options), e);
  const p = 'synthetic/summaries/external', c = createSummaryCodec({ path: p, kind: 'external' });
  const o = { basePath: `${p}/${encodeKey(id)}/payload` }, x = envelope('external', 'recovered');
  x.value.recoveryId = 'c'.repeat(32); x.digest = fingerprint(x.value);
  assert.deepEqual(c.decode(c.encode(x, o), o), x);
});
test('주소 변경·종류 혼동·알 수 없는 필드·위조 순번/상태/지문은 요약 조회 전에 거부한다', () => {
  const e = envelope(), raw = codec.encode(e, options);
  assert.throws(() => codec.decode(raw, { basePath: `${path}/${encodeKey('d'.repeat(32))}/payload` }), { code: 'WRITER_HISTORY_CONFLICT' });
  assert.throws(() => codec.decode(raw, { basePath: `${path}/extra/${encodeKey(id)}/payload` }), { code: 'WRITER_HISTORY_CONFLICT' });
  for (const change of [{ extra: true }, { q: 1 }, { s: 2 }, { t: 3 }, { h: '0'.repeat(64) }, { b: -1 }, { e: 0.5 }]) {
    assert.throws(() => codec.decode({ ...raw, ...change }, options), { code: 'WRITER_HISTORY_CONFLICT' });
  }
  assert.throws(() => codec.encode(envelope('external'), options), { code: 'WRITER_HISTORY_CONFLICT' });
});
test('한 번 인코딩한 원문의 지문/크기는 기존 typed fingerprint·JSON과 일치한다', () => {
  const { Timestamp } = require('firebase-admin/firestore');
  for (const value of [envelope(), { x: new Timestamp(123, 456), y: new Date(123), z: -0, a: [null, , []] }, Object.assign(Object.create(null), { x: '🙂' })]) {
    const stats = analyze(value);
    assert.equal(stats.digest, fingerprint(value)); assert.equal(stats.bytes, Buffer.byteLength(JSON.stringify(encodeValue(value))));
  }
});
