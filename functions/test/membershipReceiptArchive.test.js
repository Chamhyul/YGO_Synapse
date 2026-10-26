'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { checkReference, isReference, createMembershipReceiptArchive } = require('../services/membershipReceiptArchive');
const hash = 'a'.repeat(64), compact = value => Buffer.from(value, 'hex').toString('base64url');
test('작은 참조는 형식·digest·정규 base64와 허용 필드를 엄격히 대조한다', () => {
  const reference = { v: 1, d: compact(hash), h: compact(hash) };
  checkReference(reference, hash); assert(isReference(reference)); assert(!isReference({ id: 'x', digest: hash, kind: 'write' }));
  for (const raw of [{ ...reference, extra: 1 }, { ...reference, v: 2 }, { ...reference, d: compact('b'.repeat(64)) },
    { ...reference, h: 'a'.repeat(42) }, { ...reference, h: '_'.repeat(43) }]) assert.throws(() => checkReference(raw, hash), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
});
test('일반 영수증은 추가 보관 조회 없이 반환하며 미확정·구형·취소·투영은 보관하지 않는다', async () => {
  const archive = createMembershipReceiptArchive({ database: { ref() { assert.fail('불필요한 DB 접근'); } }, access: {}, history: { get() { assert.fail('이력 접근'); } } });
  const raw = { id: 'x', digest: hash, kind: 'write' }; assert.equal(await archive.resolve('unused', 'unused', hash, raw), raw);
  const result = await archive.archiveConfirmed([{ backend: 'legacy', status: 'completed' }, { backend: 'rtdb', status: 'executing' },
    { backend: 'rtdb', status: 'cancelled' }, { backend: 'rtdb', status: 'completed', details: { kind: 'projection' } }]);
  assert.deepEqual(result, { eligible: 0, moved: 0, alreadyArchived: 0, missing: 0, beforeBytes: 0, afterBytes: 0 });
});
test('중복 ID·위조 완료 원문·배치 상한 위반은 사용자 부모에 접근하기 전에 거부한다', async () => {
  const archive = createMembershipReceiptArchive({ database: { ref() { assert.fail('사용자 DB 접근'); } }, access: {}, history: { get: async () => undefined } });
  const op = { id: 'b'.repeat(32), digest: hash, backend: 'rtdb', status: 'completed', details: { kind: 'membership' } };
  await assert.rejects(archive.archiveConfirmed([op]), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
  await assert.rejects(archive.archiveConfirmed(Array.from({ length: 129 })), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
});
