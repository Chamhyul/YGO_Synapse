'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { syncMembershipClaims, updateAccountClaims, recoverMembershipClaims, membershipClaim, inspectMembershipClaims } = require('../services/membershipClaims');
const { createDiscordMembershipHandlers } = require('../services/discordMembership');
const { createYoutubeMembershipHandlers } = require('../services/youtubeMembership');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
async function setup(options = {}, runId = id()) {
  const connection = open(runId), f = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase,
    bucket: connection.bucket, FieldValue, runId, config: connection.config, migration, ...options });
  await f.initialize(); return { ...f, connection, runId, close: () => connection.close() };
}
async function switchTo(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
function state(provider, localOnly = false, nonceHash = hash(id())) { const startedAt = Date.now(); return { nonceHash, startedAt,
  expiresAt: startedAt + 300000, consumed: false, localOnly, ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}) }; }
function member(provider) { return { status: 'active', type: provider === 'discord' ? 'discord' : 'csv', levelName: '합성 회원',
  verificationVersion: 2, verificationProvider: provider, lastChecked: Date.now(),
  ...(provider === 'discord' ? { discordId: '123456789012345678' } : { userChannelId: 'UC' + 'x'.repeat(22) }) }; }
async function verified(f, uid, provider = 'discord', localOnly = false) {
  const s = state(provider, localOnly); await f.membership.start(uid, provider, s); await f.membership.consume(uid, provider, s.nonceHash);
  return f.membership.complete(uid, provider, s.nonceHash, member(provider));
}
function claimsOptions(f, auth = f.connection.auth, extra = {}) { return { storage: f.claimsStorage, auth, allowEmulator: true, env: process.env, ...extra }; }
for (const provider of ['discord', 'youtube']) test(`${provider} 진행 중 nonce와 프로필·멤버십은 양방향으로 보존된다`, async () => {
  const f = await setup();
  try {
    await f.repository.updateSettings('u', { theme: 'dark', empty: [], null: null });
    const s = state(provider); await f.membership.start('u', provider, s);
    await assert.rejects(f.membership.start('u', provider, s), { code: 'MEMBERSHIP_TOO_MANY_REQUESTS' });
    await switchTo(f); await f.membership.consume('u', provider, s.nonceHash);
    await assert.rejects(f.membership.consume('u', provider, s.nonceHash), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    await switchTo(f); const saved = await f.membership.complete('u', provider, s.nonceHash, member(provider));
    assert.equal(saved.stored, true); assert.equal(saved.membership.verificationProvider, provider);
    const profile = (await f.repository.read('u')).value;
    assert.equal(profile.settings.theme, 'dark'); assert.deepEqual(profile.settings.empty, []); assert.equal(profile.settings.null, null);
    await assert.rejects(f.membership.complete('u', provider, s.nonceHash, member(provider)), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    await switchTo(f); assert.deepEqual((await f.membership.read('u')).membership, saved.membership);
    const raw = (await f.connection.targetDatabase.ref(`users/${encodeKey('u')}`).get()).val();
    assert.equal(raw.verification[provider].completed, true);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} localOnly 완료는 프로필을 만들지 않고 만료·nonce 교체를 거부한다`, async () => {
  const f = await setup();
  try {
    if (backend === 'rtdb') await switchTo(f);
    assert.equal((await verified(f, 'local', 'youtube', true)).stored, false);
    assert.equal((await f.repository.read('local')).exists, false); assert.equal(await f.repository.isRegistered('local'), false);
    const expired = state('discord'); expired.startedAt -= 300001; expired.expiresAt -= 300001;
    await f.membership.start('expired', 'discord', expired);
    await assert.rejects(f.membership.consume('expired', 'discord', expired.nonceHash), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    const older = state('discord'); older.startedAt -= 4000; older.expiresAt -= 4000;
    await f.membership.start('changed', 'discord', older); await f.membership.consume('changed', 'discord', older.nonceHash);
    await f.membership.start('changed', 'discord', state('discord'));
    await assert.rejects(f.membership.complete('changed', 'discord', older.nonceHash, member('discord')), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 완료 응답 유실은 프로필·nonce 같은 transaction의 영수증으로 복구된다`, async () => {
  let lost = false, operationId;
  const f = await setup({ onCheckpoint: async (stage, value) => { if (lost && stage === 'businessCommitted') { lost = false; operationId = value; throw new Error('합성 승인 유실'); } } });
  try {
    if (backend === 'rtdb') await switchTo(f);
    const s = state('discord'); await f.membership.start('u', 'discord', s); await f.membership.consume('u', 'discord', s.nonceHash);
    lost = true; await assert.rejects(f.membership.complete('u', 'discord', s.nonceHash, member('discord')));
    assert.equal((await f.transition.inspect()).unresolved, 1);
    assert.equal((await f.membership.read('u')).membership.status, 'active');
    assert.equal((await f.transition.recover(operationId)).stored, true);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    await assert.rejects(f.membership.complete('u', 'discord', s.nonceHash, member('discord')), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    await switchTo(f);
  } finally { await f.close(); }
});
test('두 SDK의 같은 nonce 소비는 하나만 성공한다', async () => {
  const f = await setup(), other = await setup({}, f.runId);
  try {
    const s = state('discord'); await f.membership.start('u', 'discord', s);
    const outcomes = await Promise.allSettled([f.membership.consume('u', 'discord', s.nonceHash), other.membership.consume('u', 'discord', s.nonceHash)]);
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'MEMBERSHIP_VERIFICATION_EXPIRED');
  } finally { await other.close(); await f.close(); }
});
test('외부 인증이 지연되면 drain은 기다리고 기존 epoch에서 인증 완료를 허용한다', async () => {
  const f = await setup(); let release, entered; const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try {
    const s = state('youtube'); await f.membership.start('u', 'youtube', s);
    const pending = f.membership.withVerification('u', 'youtube', async () => {
      await f.membership.consume('u', 'youtube', s.nonceHash); entered(); await gate;
      return f.membership.complete('u', 'youtube', s.nonceHash, member('youtube'));
    });
    await ready; const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    release(); assert.equal((await pending).stored, true); await f.transition.activate(writer);
    assert.equal((await f.membership.read('u')).membership.verificationProvider, 'youtube');
  } finally { release?.(); await f.close(); }
});
test('실제 demo Auth 동기화와 관리자 권한 변경은 다른 claims를 보존하고 전환을 막지 않는다', async () => {
  const f = await setup(), uid = 'claims-' + id();
  try {
    await f.connection.auth.createUser({ uid }); await f.connection.auth.setCustomUserClaims(uid, { role: 'owner', admin: true, custom: 'preserved' });
    await verified(f, uid);
    assert.equal((await syncMembershipClaims(uid, claimsOptions(f))).status, 'synced');
    assert.deepEqual((await f.connection.auth.getUser(uid)).customClaims.ygoMembership, membershipClaim(await f.membership.read(uid)));
    await switchTo(f);
    assert.equal((await updateAccountClaims(uid, { role: 'admin', admin: true }, claimsOptions(f))).status, 'synced');
    const claims = (await f.connection.auth.getUser(uid)).customClaims;
    assert.equal(claims.custom, 'preserved'); assert.equal(claims.role, 'admin');
    assert.equal((await f.transition.inspect()).externalUnresolved, 0); await switchTo(f);
  } finally { await f.close(); }
});
test('Auth 시간초과·늦은 쓰기는 전환을 막으며 drain과 명시 복구 뒤에만 해제한다', async () => {
  const f = await setup(), uid = 'uncertain-' + id(); let release; const gate = new Promise(resolve => { release = resolve; });
  try {
    await f.connection.auth.createUser({ uid }); await f.connection.auth.setCustomUserClaims(uid, { role: 'owner', admin: true, custom: 'preserved' });
    await verified(f, uid);
    let late;
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: (...args) => late = (async () => { await gate; return f.connection.auth.setCustomUserClaims(...args); })() };
    assert.equal((await syncMembershipClaims(uid, claimsOptions(f, auth, { timeoutMs: 1500 }))).status, 'pending');
    const lock = await f.claimsStorage.customClaims.inspect(uid); assert.equal(lock.state, 'uncertain');
    assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    await assert.rejects(recoverMembershipClaims(uid, lock.operationId, claimsOptions(f, f.connection.auth, { writersDrained: true })), { code: 'WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED' });
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    release(); await late;
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    const recovered = await recoverMembershipClaims(uid, lock.operationId, claimsOptions(f, f.connection.auth, { writersDrained: true }));
    assert.equal(recovered.status, 'synced'); assert.equal((await f.transition.inspect()).externalUnresolved, 0);
    await f.transition.activate(writer); assert.equal((await f.connection.auth.getUser(uid)).customClaims.role, 'owner');
    await assert.rejects(f.transition.endExternal(lock.operationId), { code: 'WRITER_OUTCOME_UNRESOLVED' });
  } finally { release?.(); await f.close(); }
});
for (const provider of ['discord', 'youtube']) test(`HTTP ${provider}는 공통 native 경계에서 응답·설정·claims 호환을 유지한다`, async () => {
  const f = await setup(), uid = 'http-' + id();
  try {
    await f.connection.auth.createUser({ uid }); await f.repository.updateSettings(uid, { theme: 'dark' }); await switchTo(f);
    const forbidden = () => assert.fail('운영 또는 legacy 우회 금지');
    const storage = { ...f.claimsStorage, membershipCsv: { readMember: async () => ({ levelName: '합성 회원' }) } };
    const env = { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId };
    const common = { storage, env, rtdbTestDependencies: true, auth: f.connection.auth,
      db: { collection: forbidden }, isLocal: forbidden, forward: forbidden, verifyAppCheck: async () => true,
      verifyRegisteredUser: async () => uid, setCors() {}, syncClaims: () => syncMembershipClaims(uid, claimsOptions(f)) };
    const handlers = provider === 'discord'
      ? createDiscordMembershipHandlers({ ...common, clientId: 'synthetic-client', guildId: 'synthetic-guild', getClientSecret: () => 'synthetic-only', getMembership: async () => ({ discordId: member('discord').discordId, roles: ['1462257396020809800'] }) })
      : createYoutubeMembershipHandlers({ ...common, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ id: member('youtube').userChannelId }] }) }) });
    async function call(name, body) {
      let output, status = 200; const res = { set() {}, status(value) { status = value; return this; }, json(value) { output = value; }, send() {} };
      await handlers[name]({ method: 'POST', body, headers: {}, query: {} }, res); assert.equal(status, 200); return output;
    }
    const title = provider === 'discord' ? 'Discord' : 'Youtube';
    const started = await call(`start${title}MembershipVerification`, provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {});
    const saved = await call(`verify${title}Membership`, { verificationId: started.verificationId, ...(provider === 'discord' ? { code: 'synthetic-only' } : { accessToken: 'synthetic-only' }) });
    assert.equal(saved.success, true); assert.equal(saved.uid, uid); assert.equal(saved.isMemberActive, true); assert.equal(saved.claimsPending, false);
    assert.equal(saved.sourceMembership.verificationProvider, provider); assert.equal((await f.repository.read(uid)).value.settings.theme, 'dark');
    assert.equal((await f.transition.inspect()).unresolved, 0); await switchTo(f);
    assert.doesNotMatch(JSON.stringify(await f.stores.legacy.snapshot()), /synthetic-only|verificationId/);
  } finally { await f.close(); }
});

test('공통 claims 복구 CLI는 같은 journal을 읽고 drain 없이 복구하지 않는다', async () => {
  const f = await setup(), uid = 'cli-' + id();
  try {
    await f.connection.auth.createUser({ uid }); await verified(f, uid);
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: async () => { throw Object.assign(new Error('합성 응답 유실'), { code: 'auth/internal-error' }); } };
    assert.equal((await syncMembershipClaims(uid, claimsOptions(f, auth))).status, 'pending');
    const lock = await f.claimsStorage.customClaims.inspect(uid), cli = require('../../scripts/reconcile_membership_claims.cjs');
    let output = '', errors = '';
    const options = { env: { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId },
      createStorage: () => ({ ...f.claimsStorage, close: async () => {} }), createAuth: () => ({ auth: f.connection.auth, close: async () => {} }),
      stdout: value => { output += value; }, stderr: value => { errors += value; } };
    const before = (await f.connection.targetDatabase.ref(`profileWriterTransitions/${encodeKey(f.runId)}`).get()).val();
    assert.equal(await cli.main(['--uid', uid], options), 0); assert.equal(JSON.parse(output).state, 'uncertain');
    assert.deepEqual((await f.connection.targetDatabase.ref(`profileWriterTransitions/${encodeKey(f.runId)}`).get()).val(), before);
    const args = ['--uid', uid, '--operation', lock.operationId, '--recover', '--writers-drained'];
    assert.equal(await cli.main(args, options), 1); assert.match(errors, /WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED/);
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    output = ''; assert.equal(await cli.main(args, options), 0); assert.equal(JSON.parse(output).matches, true);
    await f.transition.activate(writer); assert.doesNotMatch(output + errors, new RegExp(uid));
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 인증 완료의 늦은 commit은 같은 DB 취소 영수증을 우회하지 못한다`, async () => {
  const f = await setup(), other = await setup({}, f.runId); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    if (backend === 'rtdb') await switchTo(f);
    const s = state('discord'); await f.membership.start('u', 'discord', s); await f.membership.consume('u', 'discord', s.nonceHash);
    const adapter = f.membershipAdapters[backend], commit = adapter.commit; let opId;
    adapter.commit = async op => { opId = op.id; entered(); await gate; return commit(op); };
    const pending = f.membership.complete('u', 'discord', s.nonceHash, member('discord'));
    await ready; assert.equal((await other.transition.fenceUncommitted(opId)).status, 'cancelled');
    await switchTo(f); release(); await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
    assert.equal((await f.membership.read('u')).membership, undefined);
    const nonce = await f.membershipAdapters[(await f.transition.route()).backend].read('verification/discord/u');
    assert.equal(nonce.value.completed, false);
  } finally { release?.(); await other.close(); await f.close(); }
});

test('복구 등록 뒤 UID 잠금 이동 실패는 동일 복구 ID로 재개하며 장벽을 잃지 않는다', async () => {
  const f = await setup(), uid = 'handoff-' + id();
  try {
    await f.connection.auth.createUser({ uid }); await verified(f, uid);
    const auth = { getUser: (...args) => f.connection.auth.getUser(...args), setCustomUserClaims: async () => { throw new Error('합성 응답 유실'); } };
    await syncMembershipClaims(uid, claimsOptions(f, auth)); const lock = await f.claimsStorage.customClaims.inspect(uid);
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    const database = f.connection.targetDatabase, original = database.ref; let failOnce = true;
    database.ref = path => { const ref = original(path), transaction = ref.transaction.bind(ref);
      ref.transaction = (...args) => { if (failOnce && path.startsWith('customClaimsSync/')) { failOnce = false; throw new Error('합성 잠금 이동 전 장애'); } return transaction(...args); }; return ref; };
    await assert.rejects(recoverMembershipClaims(uid, lock.operationId, claimsOptions(f, f.connection.auth, { writersDrained: true })));
    database.ref = original; assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    assert.equal((await f.claimsStorage.customClaims.inspect(uid)).operationId, lock.operationId);
    assert.equal((await recoverMembershipClaims(uid, lock.operationId, claimsOptions(f, f.connection.auth, { writersDrained: true }))).status, 'synced');
    assert.equal((await f.transition.inspect()).externalUnresolved, 0); await f.transition.activate(writer);
  } finally { await f.close(); }
});
test('native 프로필 세대가 달라지는 계정 삭제 계열 자료는 nonce 이전을 조용히 완료하지 않는다', async () => {
  const f = await setup();
  try {
    await switchTo(f); const writer = await f.transition.route(), op = id();
    await f.transition.prepare(writer, op, [{ key: 'fs/users/u', exists: false, token: '0' }], null,
      { details: { kind: 'profile', serverTimestampPaths: [] } }); await f.transition.execute(writer, op);
    await f.repository.updateSettings('u', { theme: 'dark' }); await f.membership.start('u', 'discord', state('discord'));
    await assert.rejects(f.transition.copy(writer), { code: 'MEMBERSHIP_WRITER_GENERATION_MIGRATION_REQUIRED' });
    assert.equal((await f.transition.route()).backend, 'rtdb');
  } finally { await f.close(); }
});

test('멤버십 원본 조회는 인증 이력·UID 전체를 읽지 않고 현재 profile만 조회한다', async () => {
  const f = await setup();
  try {
    await f.repository.updateSettings('u', { theme: 'dark' }); await switchTo(f);
    const database = f.connection.targetDatabase, original = database.ref, reads = [];
    function watch(ref) { const get = ref.get.bind(ref), child = ref.child.bind(ref);
      ref.get = () => { reads.push(ref.toString()); return get(); }; ref.child = path => watch(child(path)); return ref; }
    database.ref = path => watch(original(path));
    assert.equal((await f.membership.read('u')).version, '0'); database.ref = original;
    const userReads = reads.filter(path => path.includes('/users/'));
    assert.equal(userReads.length, 1); assert.ok(userReads[0].endsWith('/profile'));
  } finally { await f.close(); }
});

test('Auth와 UID 잠금은 완료됐지만 공통 종료 기록이 유실돼도 명시 복구할 수 있다', async () => {
  const f = await setup(), uid = 'finish-gap-' + id();
  try {
    await f.connection.auth.createUser({ uid }); await verified(f, uid);
    const end = f.transition.endExternal; let once = true;
    f.transition.endExternal = async (...args) => { if (once) { once = false; throw new Error('합성 공통 종료 전 장애'); } return end(...args); };
    assert.equal((await syncMembershipClaims(uid, claimsOptions(f))).status, 'pending');
    f.transition.endExternal = end;
    const lock = await f.claimsStorage.customClaims.inspect(uid); assert.equal(lock.state, 'idle');
    const report = await inspectMembershipClaims(uid, claimsOptions(f)); assert.equal(report.matches, true); assert.equal(report.writer.unresolved, 1);
    assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    assert.equal((await recoverMembershipClaims(uid, lock.operationId, claimsOptions(f, f.connection.auth, { writersDrained: true }))).status, 'synced');
    await f.transition.activate(writer); assert.equal((await f.transition.inspect()).externalUnresolved, 0);
  } finally { await f.close(); }
});

for (const backend of ['legacy', 'rtdb']) test(`${backend} 멤버십 정상 저장은 합성 실행과 확정 영수증으로 별도 조회 없이 완료한다`, async () => {
  const f = await setup();
  try {
    if (backend === 'rtdb') await switchTo(f);
    const adapter = f.membershipAdapters[backend], read = adapter.receipt; let lookups = 0, fused = 0;
    adapter.receipt = async (...args) => { lookups++; return read(...args); };
    const execute = f.transition.prepareAndExecuteWithReceipt;
    f.transition.prepareAndExecuteWithReceipt = async (...args) => { fused++; return execute(...args); };
    f.transition.prepare = f.transition.execute = () => assert.fail('분리 실행 경로 사용 금지');
    const saved = await verified(f, 'fusion');
    assert.equal(saved.stored, true); assert.equal(fused, 3); assert.equal(lookups, 0);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    assert.equal((await f.repository.read('fusion')).value.settings.membership.verificationProvider, 'discord');
    await switchTo(f);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 전달된 영수증 변조는 성공으로 처리하지 않고 영구 영수증으로 복구한다`, async () => {
  const f = await setup();
  try {
    if (backend === 'rtdb') await switchTo(f);
    const s = state('youtube'); await f.membership.start('receipt', 'youtube', s); await f.membership.consume('receipt', 'youtube', s.nonceHash);
    const adapter = f.membershipAdapters[backend], commit = adapter.commit; let operation;
    adapter.commit = (op, confirmed) => { operation = op; return commit(op, value => confirmed({ ...value, digest: '0'.repeat(64) })); };
    await assert.rejects(f.membership.complete('receipt', 'youtube', s.nonceHash, member('youtube')), { code: 'WRITER_RECEIPT_REQUIRED' });
    assert.equal((await f.transition.inspect()).unresolved, 1);
    adapter.commit = commit;
    assert.equal((await f.transition.recover(operation.id)).stored, true);
    assert.equal((await f.transition.inspect()).unresolved, 0);
    await assert.rejects(f.membership.complete('receipt', 'youtube', s.nonceHash, member('youtube')), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
  } finally { await f.close(); }
});
