'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { encodeKey } = require('../services/user-storage/codec');
async function flip(f) {
  const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
}
test('운영 연결 코드의 실제 가입·설정·인벤토리 함수가 같은 전환 상태를 따르고 초기화를 자동 실행하지 않는다', async () => {
  const f = await fixture();
  try {
    const registration = f.load('functions/routes/registration.js'), user = f.load('functions/routes/user.js');
    const before = await call(registration.getRegistrationStatus, { method: 'GET' }); assert.equal(before.statusCode, 503);
    assert.equal((await f.connection.targetDatabase.ref('profileWriterTransitions').get()).exists(), false);
    await f.binding.transition.initialize();
    const status = await call(registration.getRegistrationStatus, { method: 'GET' }); assert.equal(status.body.registered, false);
    const created = await call(registration.completeRegistration, { body: { agreements: { terms: true, privacy: true }, consentVersions: status.body.consentVersions } });
    assert.equal(created.statusCode, 200); assert.equal(created.body.registered, true);
    assert.equal((await f.connection.db.collection('users').doc(f.uid).get()).exists, true);
    await f.connection.db.collection('cards').doc('123').set({ numbers: ['SYN-001'], names: ['합성 카드'], info: { card_type: 'Monster', ko: { name: '합성 카드', packs: { 'SYN-001': ['SR'] } } } });
    assert.equal((await call(user.updateUserSettings, { body: { settings: { theme: 'dark' } } })).statusCode, 200);
    await flip(f);
    const data = await call(user.getUserData, { method: 'GET' }); assert.equal(data.statusCode, 200); assert.equal(Array.isArray(data.body.allCards), true);
    assert.equal((await call(user.updateNickname, { body: { nickname: '합성 닉네임' } })).statusCode, 200);
    assert.equal((await f.binding.repository.read(f.uid)).value.Nickname, '합성 닉네임');
    assert.notEqual((await f.connection.db.collection('users').doc(f.uid).get()).data().Nickname, '합성 닉네임');
    const inventory = f.load('functions/routes/inventory.js');
    const added = await call(inventory.addCards, { body: { rows: [['합성 카드', 'SYN-001', 'SR', 2, '원래', '1', '123']] } });
    assert.equal(added.statusCode, 200); assert.equal(added.body.amount, 2);
    const moved = await call(inventory.moveCards, { body: { moves: [{ cardNo: 'SYN-001', rarity: 'SR', proc: '1', currentLoc: '원래', targetLoc: '새 위치', moveQty: 1 }] } });
    assert.equal(moved.statusCode, 200); assert.equal(moved.body.amount, 2);
    const discarded = await call(inventory.discardCards, { body: { discards: [{ cardNo: 'SYN-001', rarity: 'SR', proc: '1', loc: '새 위치', qty: 1 }] } });
    assert.equal(discarded.statusCode, 200); assert.equal(discarded.body.amount, 1);
    assert.equal((await call(user.clearUserData)).statusCode, 200);
    await flip(f); assert.equal((await f.connection.db.collection('users').doc(f.uid).get()).data().Nickname, '합성 닉네임');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    assert.equal((await f.connection.targetDatabase.ref(`profileWriterTransitions/${encodeKey(f.env.USER_PROFILE_WRITER_RUN_ID)}/head`).get()).val().format, 3);
  } finally { await f.close(); }
});

test('실제 Discord·YouTube 인증 진행/완료와 claims가 같은 전환에 연결된다', async () => {
  const f = await fixture();
  try {
    await f.binding.transition.initialize(); await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const youtubeService = f.load('functions/services/youtubeMembership.js');
    f.mock('functions/services/youtubeMembership.js', { ...youtubeService, createYoutubeMembershipHandlers: options => youtubeService.createYoutubeMembershipHandlers({ ...options,
      fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ id: 'UC' + 'a'.repeat(22) }] }) }) }) });
    const discord = f.load('functions/routes/discordMembership.js'), youtube = f.load('functions/routes/youtubeMembership.js');
    const started = await call(discord.startDiscordMembershipVerification, { body: { redirectUri: 'https://ygo-synapse.web.app/' } });
    assert.equal(started.statusCode, 200); assert.equal(started.body.verificationId.length, 64);
    await flip(f);
    const verified = await call(discord.verifyDiscordMembership, { body: { verificationId: started.body.verificationId, code: 'synthetic-code' } });
    assert.equal(verified.statusCode, 200); assert.equal(verified.body.sourceMembership.verificationProvider, 'discord');
    assert.equal(verified.body.claimsPending, false);
    const yt = await call(youtube.startYoutubeMembershipVerification); assert.equal(yt.statusCode, 200);
    await flip(f);
    const complete = await call(youtube.verifyYoutubeMembership, { body: { verificationId: yt.body.verificationId, accessToken: 'synthetic-token' } });
    assert.equal(complete.statusCode, 200); assert.equal(complete.body.sourceMembership.verificationProvider, 'youtube');
    assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.ygoMembership.provider, 'youtube');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

test('실제 관리자 페이지의 세션·활동·로그아웃은 전환/역전환 뒤에도 같은 저장소 선택을 따른다', async () => {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    const pages = f.load('functions/routes/admin/pages.js'), headers = { host: 'synthetic.invalid', origin: 'https://synthetic.invalid', 'content-type': 'application/json' };
    const login = await call(pages.adminPages, { url: '/admin/session', token: 'owner', headers });
    assert.equal(login.statusCode, 200); assert.equal(login.body.role, 'owner');
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    const key = require('node:crypto').createHash('sha256').update(decodeURIComponent(cookie.slice(10))).digest('hex');
    assert.equal((await f.binding.adminSessions.get(key)).uid, f.owner);
    await flip(f);
    assert.equal((await f.binding.adminSessions.get(key)).uid, f.owner);
    const activity = await call(pages.adminPages, { url: '/admin/session/activity', token: 'owner', body: { uid: f.owner }, headers: { ...headers, cookie } });
    assert.equal(activity.statusCode, 204);
    await flip(f);
    const logout = await call(pages.adminPages, { url: '/admin/session/logout', token: 'owner', headers: { ...headers, cookie } });
    assert.equal(logout.statusCode, 204); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('실제 관리자 함수·envelope와 CSV는 공통 writer를 사용하고 권한 거부·역전환을 유지한다', async () => {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    const access = f.load('functions/routes/admin/access.js'), actions = f.load('functions/routes/admin/actions.js');
    assert.equal((await call(access.checkAdminAccess)).statusCode, 403);
    assert.equal((await call(access.checkAdminAccess, { token: 'owner' })).body.role, 'owner');
    const integrated = f.load('functions/routes/integration.js');
    const body = { members: [{ channelId: 'UC' + 'a'.repeat(22), levelName: '일반', memberName: '합성' }] };
    const preview = await require('../services/membershipCsvService').createMembershipCsvService({ store: f.binding.membershipCsv }).preview(body);
    const csv = await call(integrated.uploadMembershipCsv, { token: 'owner', body: { ...body, ...preview } }); assert.equal(csv.statusCode, 200);
    await flip(f);
    const envelope = await call(actions.adminHandleOperationRequest, { token: 'owner', body: { operation: 'checkAdminAccess', method: 'POST', body: {}, query: {} } });
    assert.equal(envelope.statusCode, 200); assert.equal(envelope.body.role, 'owner');
    const role = await call(f.load('functions/routes/admin/notices.js').manageAdminRole, { token: 'owner', body: { action: 'setAdmin', targetUid: f.uid, isAdmin: true } });
    assert.equal(role.statusCode, 200); assert.equal((await f.connection.auth.getUser(f.uid)).customClaims.role, 'admin');
    await flip(f); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('실제 카드 API의 키·쿼터·CORS 요청이 종료 승인까지 보호되고 카드 원본 조회는 유지된다', async () => {
  const f = await fixture();
  try {
    await f.binding.transition.initialize(); await f.connection.db.collection('cards').doc('123').set({ info: { ko: { name: '합성 카드' } } });
    const key = require('../services/cardApiAccess').newKey();
    const api = f.load('functions/services/cardApiAccessRepository.js').getCardApiAccess();
    await api.register(key, { label: 'synthetic', origins: ['https://synthetic.invalid'], minuteLimit: 10, dayLimit: 100, expiresAt: null });
    const handler = f.load('functions/routes/cardInfo.js').getCardInfo;
    const request = { method: 'GET', query: { cid: '123' }, headers: { 'x-api-key': key.token, origin: 'https://synthetic.invalid' } };
    const before = await call(handler, request); assert.equal(before.statusCode, 200); assert.equal(before.body.cid, '123');
    await flip(f); const after = await call(handler, request); assert.equal(after.statusCode, 200); assert.equal(after.body.cid, '123');
    assert.equal(after.headers['Access-Control-Allow-Origin'], 'https://synthetic.invalid');
    await api.disable(key.id); assert.equal((await call(handler, request)).statusCode, 403);
    await flip(f); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

test('관리 CLI의 운영 선택 코드도 공통 키·CSV·claims·상태 경로를 사용하고 원본 파일을 보존한다', async () => {
  const f = await fixture(), fs = require('node:fs'), filename = require('node:path').join(require('node:os').tmpdir(), `synthetic-${f.env.USER_PROFILE_WRITER_RUN_ID}.csv`);
  try {
    await f.binding.transition.initialize(); await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const key = require('../services/cardApiAccess').newKey(); await f.binding.apiAccess.register(key, { label: 'synthetic', origins: [], minuteLimit: 10, dayLimit: 100, expiresAt: null });
    await flip(f);
    let closed = 0; f.runtime.closeProfileWriterRuntime = async () => { closed++; };
    const management = f.load('scripts/manage_card_api_keys.js'); await management.main(['disable', '--writer-production', '--id', key.id, '--apply']);
    await assert.rejects(f.binding.apiAccess.authenticate(key.token), { status: 403 });
    fs.writeFileSync(filename, '회원,프로필에 연결,현재 등급\n합성,https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa,일반\n');
    await f.load('scripts/upload_membership_csv.js').main(['--writer-production', filename]); assert.equal(fs.existsSync(filename), true);
    const out = [], err = [], claims = f.load('scripts/reconcile_membership_claims.cjs');
    assert.equal(await claims.main(['--writer-production', '--uid', f.uid], { env: f.env, stdout: s => out.push(s), stderr: s => err.push(s) }), 0);
    assert.equal(err.length, 0); assert.equal(JSON.stringify(out).includes(f.uid), false);
    const status = f.load('scripts/manage_user_writer.cjs');
    assert.equal(await status.main(['status', '--writer-production'], { env: f.env, stdout: s => out.push(s), stderr: s => err.push(s) }), 0);
    assert.equal(JSON.parse(out.at(-1)).backend, 'rtdb'); assert.equal(closed, 4);
  } finally { if (fs.existsSync(filename)) fs.unlinkSync(filename); await f.close(); }
});
