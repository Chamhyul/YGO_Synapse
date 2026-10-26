'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMembershipWriterRepository } = require('../services/userMembershipWriterRepository');
const state = { nonceHash: 'a'.repeat(64), startedAt: 10, expiresAt: 300010, consumed: false, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' };
function fixture(fused) {
  let contexts = 0; const writer = { backend: 'rtdb', epoch: 1 }, op = { id: 'operation' };
  const adapter = { context: async () => { contexts++; return { nonce: { key: 'verification/discord/u', exists: false, token: '0' }, profile: { token: '0' }, generation: 0 }; }, cancellationReason: async value => { assert.equal(value, op); return 'expired'; } };
  const transition = { route: async () => writer, prepare: async () => op, execute: async () => state };
  if (fused) transition.prepareAndExecuteWithReceipt = fused;
  const repository = createMembershipWriterRepository({ transition, adapters: { rtdb: adapter }, profiles: {}, initialize: async () => writer });
  return { repository, transition, op, contexts: () => contexts };
}
test('멤버십은 합성 실행 결과만 반환하고 호환 prepare/execute도 유지한다', async () => {
  let count = 0; const f = fixture(async (writer, id, changes, result, options) => { count++; assert.equal(options.details.kind, 'membership'); options.onPrepared({ id }); return { result, receipt: { private: 'not returned' } }; });
  f.transition.prepare = f.transition.execute = () => assert.fail('분리 실행 금지');
  const saved = await f.repository.start('u', 'discord', state); assert.equal(saved.nonceHash, state.nonceHash); assert.equal(saved.receipt, undefined); assert.equal(count, 1);
  assert.deepEqual(await fixture().repository.start('u', 'discord', state), state);
});
test('합성 실행의 준비 ACK 이후 취소는 해당 영수증으로 만료를 판정하고 모호한 오류는 재시도하지 않는다', async () => {
  const f = fixture(); f.transition.prepareAndExecuteWithReceipt = async (w, id, c, r, o) => { o.onPrepared(f.op); throw Object.assign(Error(), { code: 'WRITER_CANCELLED' }); };
  await assert.rejects(f.repository.start('u', 'discord', state), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' }); assert.equal(f.contexts(), 1);
  f.transition.prepareAndExecuteWithReceipt = async (w, id, c, r, o) => { o.onPrepared(f.op); throw Object.assign(Error(), { code: 'WRITER_RESOURCE_BUSY' }); };
  await assert.rejects(f.repository.start('u', 'discord', state), { code: 'WRITER_RESOURCE_BUSY' }); assert.equal(f.contexts(), 2);
});
