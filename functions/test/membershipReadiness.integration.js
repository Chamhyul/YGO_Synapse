'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const target = process.env.READINESS_TARGET;
const targets = target ? [target] : ['getUserData', 'verifyYoutubeMembership', 'verifyDiscordMembership', 'startYoutubeMembershipVerification'];
assert(targets.every(t => ['getUserData', 'verifyYoutubeMembership', 'verifyDiscordMembership', 'startYoutubeMembershipVerification'].includes(t)));
const request = { warmup: 'true', membershipPrepare: true, ssId: null };
async function setup(rtdb = true) {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    if (rtdb) { const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w); }
    f.handlers = { ...f.load('functions/routes/user.js'), ...f.load('functions/routes/youtubeMembership.js'), ...f.load('functions/routes/discordMembership.js') };
    return f;
  } catch (error) { await f.close(); throw error; }
}
async function snapshot(f) {
  return { journal: await f.binding.transition.inspect(), rtdb: (await f.connection.targetDatabase.ref().get()).val(),
    auth: (await f.connection.auth.getUser(f.uid)).customClaims || {} };
}
for (const rtdb of [false, true]) test(`${rtdb ? 'RTDB' : 'legacy'} 함수4개의 준비는 native 데이터·journal·Auth를 쓰지 않는다`, async () => {
  const f = await setup(rtdb);
  try {
    const before = await snapshot(f);
    for (const target of targets) {
      const res = await call(f.handlers[target], { body: request });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true, membershipPreparation: { version: 1, target, ready: true } });
    }
    assert.deepEqual(await snapshot(f), before);
  } finally { await f.close(); }
});
if (!target || target === 'getUserData') test('진행 중 claims 잠금을 준비 요청이 해제하거나 권한 완료로 반환하지 않는다', async () => {
  const f = await setup();
  try {
    await f.binding.claimsStorage.customClaims.acquire(f.uid);
    const before = await snapshot(f), res = await call(f.handlers.getUserData, { body: request });
    assert.equal(res.statusCode, 200); assert.equal(res.body.membershipClaims, undefined);
    assert.deepEqual(await snapshot(f), before);
    const read = f.load('functions/services/membershipClaims.js');
    assert.equal((await read.readMembershipClaimsAfterVerification(f.uid)).status, 'pending');
    assert.deepEqual(await snapshot(f), before);
  } finally { await f.close(); }
});
if (!target || target === 'verifyYoutubeMembership' || target === 'startYoutubeMembershipVerification') test('준비 뒤 drain이 시작되면 이전 준비 상태로 실제 인증 쓰기를 우회하지 않는다', async () => {
  const f = await setup();
  try {
    assert.equal((await call(f.handlers[target || 'verifyYoutubeMembership'], { body: request })).statusCode, 200);
    await f.binding.transition.drain(await f.binding.transition.route());
    const before = await snapshot(f);
    const res = await call(f.handlers.startYoutubeMembershipVerification);
    assert.equal(res.statusCode, 503); assert.equal(res.body.success, false);
    assert.deepEqual(await snapshot(f), before);
  } finally { await f.close(); }
});
test('준비 응답·업무 인수 혼합은 nonce 소비나 인벤토리 조회를 시작하지 않는다', async () => {
  const f = await setup();
  try {
    const before = await snapshot(f);
    for (const target of targets) {
      const res = await call(f.handlers[target], { body: { ...request, membershipClaimsOnly: true, verificationId: 'synthetic' } });
      assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'MEMBERSHIP_PREPARATION_INVALID');
    }
    assert.deepEqual(await snapshot(f), before);
  } finally { await f.close(); }
});
