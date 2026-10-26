'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { encodeKey } = require('../services/user-storage/codec');
const { createProfilePayloadCodec } = require('../services/user-storage/profileCodec');
const { syncProviderMembershipClaims } = require('../services/membershipProviderRuntime');
const codec = createProfilePayloadCodec(), key = encodeKey('synthetic-followup');
const record = (time, theme = 'dark') => ({ format: 1, revision: time, generation: 0, tombstone: false,
  payload: codec.encode({ settings: { theme, membership: { status: 'none', type: 'discord', levelName: '일반',
    discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord', lastChecked: time } } }) });
const event = (before = record(1), after = record(2)) => ({ params: { userKey: key },
  instance: 'synthetic', location: 'asia-southeast1', data: { before: { val: () => before }, after: { val: () => after } } });
function fixture({ results = [{ status: 'synced' }], phase = 'accepting' } = {}) {
  const calls = [], logs = [], waits = [];
  const runtime = { storage: { writerTransition: { route: async () => ({ phase }) } },
    config: { mode: 'production', instanceId: 'synthetic', location: 'asia-southeast1' } };
  const handler = createMembershipClaimsFollowup({ select: () => runtime,
    sync: async (uid, value) => { calls.push({ uid, value }); return results[Math.min(calls.length - 1, results.length - 1)]; },
    wait: async ms => { waits.push(ms); }, emit: v => logs.push(v) });
  return { handler, calls, logs, waits, runtime };
}
test('저장 이벤트의 중복·과거 전달도 현재 원본의 동기화만 요청하며 개인 정보는 계측하지 않는다', async () => {
  const f = fixture(); await f.handler(event()); await f.handler(event(record(3), record(1)));
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].uid, 'synthetic-followup');
  assert.equal(f.calls[0].value, f.runtime); assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-followup|123456789012345678|payload/);
});
test('멤버십이 같은 일반 프로필 변경은 Auth·writer를 호출하지 않는다', async () => {
  const f = fixture(); await f.handler(event(record(1), record(1, 'light'))); assert.equal(f.calls.length, 0);
});
test('원본 삭제는 현재 원본 재대조를 요청하고 과거 자격을 다시 쓰지 않는다', async () => {
  const f = fixture(); await f.handler(event(record(1), null)); assert.equal(f.calls.length, 1);
});
test('경합·미확정 작업은 기존 동기화 판정으로 대기하고 완료 실패를 영속 배달에 돌려준다', async () => {
  const f = fixture({ results: [{ status: 'pending' }, { status: 'synced' }] }); await f.handler(event());
  assert.deepEqual(f.waits, [250]); assert.equal(f.logs[0].attempts, 2);
  const pending = fixture({ results: [{ status: 'pending' }] });
  await assert.rejects(pending.handler(event()), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });
  assert.equal(pending.calls.length, 4); assert.equal(pending.logs[0].status, 'pending');
});
test('다른 DB·리전·비운영 연결과 drain은 claims를 수정하지 않는다', async () => {
  for (const change of ['instance', 'location', 'mode', 'drain']) {
    const f = fixture({ phase: change === 'drain' ? 'draining' : 'accepting' }), e = event();
    if (change === 'mode') f.runtime.config.mode = 'emulator';
    else if (change !== 'drain') e[change] = 'other';
    await assert.rejects(f.handler(e), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' }); assert.equal(f.calls.length, 0);
  }
});
test('별도 후속 작업 모드에서는 claims 완료를 응답 대기하지 않고 구형 모드는 그대로 동기화한다', async () => {
  let calls = 0; const sync = async () => { calls++; return { status: 'synced', version: 'synthetic' }; };
  let backend = 'rtdb';
  const runtime = { config: { mode: 'production' }, deferClaims: true,
    storage: { membership: { writerLease: () => ({ writer: { backend } }) } } };
  assert.equal((await syncProviderMembershipClaims('a', runtime, {}, sync)).claimsPending, true); assert.equal(calls, 0);
  backend = 'legacy';
  assert.equal((await syncProviderMembershipClaims('a', runtime, {}, sync)).membershipClaims.status, 'synced'); assert.equal(calls, 1);
});
