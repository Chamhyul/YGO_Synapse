'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { measure, withMembershipRequestTiming, MAX_SPANS } = require('../services/inventoryRequestTiming');
const { getDiscordMembershipWithCode } = require('../integrations/discordMembership');
test('Discord 단계 계측은 응답·부모 관계를 유지하고 인증값·본문·URL을 수집하지 않는다', async () => {
  const logs = [], res = Object.assign(new EventEmitter(), { statusCode: 200 }); let calls = 0;
  const handler = withMembershipRequestTiming('verifyDiscordMembership', async () => {
    const output = await measure('discord.provider', () => getDiscordMembershipWithCode({ code: 'PRIVATE_CODE', redirectUri: 'PRIVATE_URI', clientId: 'PRIVATE_CLIENT', clientSecret: 'PRIVATE_SECRET', guildId: 'PRIVATE_GUILD' }, async () => {
      const values = [{ access_token: 'PRIVATE_TOKEN', scope: 'identify guilds.members.read', token_type: 'Bearer' }, { id: '123456789012345678' }, { roles: [] }];
      return { ok: true, status: 200, json: async () => values[calls++] };
    }));
    res.emit('finish'); res.emit('close'); return output;
  }, { emit: line => logs.push(JSON.parse(line)) });
  assert.deepEqual(await handler({ method: 'POST', body: { verificationId: 'PRIVATE' } }, res), { discordId: '123456789012345678', roles: [] });
  assert.equal(logs.length, 1); const record = logs[0];
  assert.equal(record.event, 'membership_request_timing'); assert.equal(record.completed, true);
  assert.deepEqual(record.spans.map(s => s.name), ['discord.provider', 'discord.token', 'discord.user', 'discord.member']);
  assert(record.spans.slice(1).every(s => s.parent === record.spans[0].id && s.ok && s.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|123456789012345678|discord.com/);
});
test('OPTIONS 제외·오류 원형·출력 실패·계측 상한은 기존 업무를 바꾸지 않는다', async () => {
  const logs = []; const run = withMembershipRequestTiming('startDiscordMembershipVerification', async () => {
    for (let i = 0; i < MAX_SPANS + 3; i++) await measure('membership.start', () => true);
    return 7;
  }, { emit: x => logs.push(JSON.parse(x)) });
  assert.equal(await run({ method: 'OPTIONS' }, {}), 7); assert.equal(logs.length, 0);
  assert.equal(await run({ method: 'POST' }, {}), 7); assert.equal(logs[0].spans.length, MAX_SPANS); assert.equal(logs[0].droppedSpans, 3);
  const error = Error('PRIVATE_ERROR');
  await assert.rejects(withMembershipRequestTiming('verifyDiscordMembership', () => measure('discord.token', () => Promise.reject(error)), { emit() { throw Error('observer'); } })({ method: 'POST' }, {}), e => e === error);
  assert.throws(() => withMembershipRequestTiming('unknown', () => {}));
});

test('저장 내부 계측은 고정 단계·실행 시간만 기록하고 callback 재시도를 각각 구분한다', async () => {
  const logs = [];
  await withMembershipRequestTiming('verifyYoutubeMembership', () => measure('membership.storage_transaction', async () => {
    for (let i = 0; i < 2; i++) measure('membership.storage_callback', () => measure('membership.storage_encode', () => ({ private: 'PRIVATE_PAYLOAD' })));
    measure('membership.storage_snapshot', () => 'PRIVATE_SNAPSHOT');
  }), { emit: line => logs.push(JSON.parse(line)) })({ method: 'POST' }, {});
  assert.equal(logs[0].spans.filter(s => s.name === 'membership.storage_callback').length, 2);
  assert(logs[0].spans.every(s => s.ok));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});
