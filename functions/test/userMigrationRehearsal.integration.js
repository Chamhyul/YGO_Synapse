'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setup, changes } = require('../../integration/user-migration/scenario.cjs');
const { createFirestoreMembershipCsvStore } = require('../services/membershipCsvService');
const { createCardApiAccess } = require('../../card-service/src/services/cardApiAccess');
const { createRtdbUserProfileRepository } = require('../services/userProfileRepository');
const { fingerprint } = require('../services/userMigrationRehearsal');
const contexts = [];
async function ready(options) { const context = await setup(options); contexts.push(context); return context; }
after(() => Promise.all(contexts.map(context => context.close())));
test('실제 Firestore/Storage 전체 원본을 RTDB에 이전하고 시각·null·빈값·위치·CSV 이력·계정/파일을 보존한다', async () => {
  const c = await ready(), before = await c.retained(), source = await c.source.snapshot();
  const result = await c.tool.copy(c.runId); assert.equal(result.mismatches, 0); assert.ok(result.sourceRecords > 15);
  assert.equal((await c.tool.activate(c.runId, { writersDrained: true })).phase, 'active');
  const profile = (await c.runtime.profile.read(c.fixture.uid)).value;
  const originalProfile = source.find(item => item.key === `fs/users/${c.fixture.uid}`).value;
  assert.equal(profile.createdAt.nanoseconds, originalProfile.createdAt.nanoseconds);
  assert.equal(profile.registration.consent.acceptedAt.nanoseconds, originalProfile.registration.consent.acceptedAt.nanoseconds);
  assert.deepEqual(profile.settings.nested, { empty: {}, array: [null, 'A'], missing: null });
  assert.deepEqual((await c.runtime.inventory.read(c.fixture.uid)).value, c.fixture.inventory);
  assert.equal((await c.runtime.sessions.get(c.fixture.session)).uid, c.fixture.owner);
  assert.deepEqual(await c.runtime.csv.status({ operationId: c.fixture.csvId }, c.fixture.owner),
    await require('../services/membershipCsvService').createMembershipCsvService({ store: createFirestoreMembershipCsvStore(c.connection.db) }).status({ operationId: c.fixture.csvId }, c.fixture.owner));
  assert.equal(await c.runtime.api.allowsPreflight('https://synthetic.invalid'), true);
  assert.equal((await c.runtime.api.authenticate(c.fixture.key.token)).secretHash, c.fixture.key.secretHash);
  assert.equal(await c.retained(), before); assert.equal(fingerprint(await c.source.snapshot()), fingerprint(source));
  const registration = createRtdbUserProfileRepository({ storage: { profile: c.runtime.profile, inventory: c.runtime.inventory } });
  assert.equal(await registration.isRegistered(c.fixture.other), true);
  assert.equal((await c.runtime.profile.read(c.fixture.other)).exists, false);
  assert.equal(await registration.isRegistered(c.fixture.authOnly), false);
  assert.equal((await c.runtime.inventory.read(c.fixture.other)).value.version, 1);
});
test('전환 뒤 프로필/새 사용자·인벤토리 추가/초기화·인증·세션·키/사용량/CORS·CSV 변경을 역변환한다', async () => {
  const c = await ready(), before = await c.retained(); await c.tool.copy(c.runId); await c.tool.activate(c.runId, { writersDrained: true });
  const keys = await changes(c); const expected = await c.target.snapshot();
  assert.equal((await c.tool.rollback(c.runId, { writersDrained: true })).mismatches, 0);
  const actual = new Map((await c.source.snapshot()).map(item => [item.key, item]));
  for (const item of expected) assert.equal(fingerprint(actual.get(item.key)?.value ?? null), fingerprint(item.exists ? item.value : null));
  assert.equal((await c.connection.db.collection('users').doc(c.fixture.uid).get()).data().Nickname, '수정된 합성');
  assert.equal((await c.source.read(`inventory/${c.fixture.other}`)).exists, false);
  const access = createCardApiAccess(c.connection.db, () => c.fixture.now);
  await assert.rejects(access.authenticate(c.fixture.key.token), { code: 'API_KEY_INVALID' });
  assert.equal((await access.authenticate(keys.rotated.token)).id, c.fixture.key.id);
  assert.equal((await access.consume(keys.rotated.token, 'https://synthetic.invalid')).dayRemaining, 94);
  assert.equal(await access.allowsPreflight('https://new.synthetic.invalid'), true);
  assert.equal((await createFirestoreMembershipCsvStore(c.connection.db).read()).members[0].levelName, '새 등급');
  assert.equal(await c.retained(), before);
  assert.equal((await c.connection.auth.getUser(c.fixture.uid)).customClaims.ygoMembership.provider, 'youtube');
});
test('복사 도중 중단 후 같은 run을 재개하고 원본 변경 시 전환을 거부한다', async () => {
  let interrupted = false;
  const c = await ready({ onCheckpoint: async phase => { if (phase === 'copy' && !interrupted) { interrupted = true; throw new Error('합성 중단'); } } });
  await assert.rejects(c.tool.copy(c.runId)); assert.equal((await c.tool.copy(c.runId)).mismatches, 0);
  await c.connection.db.collection('users').doc(c.fixture.uid).set({ Nickname: '원본에서 변경' }, { merge: true });
  await assert.rejects(c.tool.activate(c.runId, { writersDrained: true }), { code: 'MIGRATION_SOURCE_CHANGED' });
});
test('롤백 중단을 새 연결 상태로 재개하고 새 원본 쓰기는 덮어쓰지 않는다', async () => {
  let interrupted = false;
  const c = await ready({ onCheckpoint: async phase => { if (phase === 'rollback' && !interrupted) { interrupted = true; throw new Error('합성 중단'); } } });
  await c.tool.copy(c.runId); await c.tool.activate(c.runId, { writersDrained: true }); await changes(c);
  await assert.rejects(c.tool.rollback(c.runId, { writersDrained: true }));
  await c.close();
  const resumed = await setup({}, { runId: c.runId, fixture: c.fixture }); contexts.push(resumed);
  assert.equal((await resumed.tool.rollback(resumed.runId, { writersDrained: true })).phase, 'rolledBack');
  const second = await ready(); await second.tool.copy(second.runId); await second.tool.activate(second.runId, { writersDrained: true });
  await second.connection.db.collection('users').doc(second.fixture.uid).set({ Nickname: '새 원본 작업' }, { merge: true });
  await assert.rejects(second.tool.rollback(second.runId, { writersDrained: true }), { code: 'MIGRATION_SOURCE_CHANGED' });
  assert.equal((await second.connection.db.collection('users').doc(second.fixture.uid).get()).data().Nickname, '새 원본 작업');
});
test('Firestore·Storage 반영 뒤 응답 유실을 저장 영수증으로 대조하고 중복 재생하지 않는다', async () => {
  for (const storageFailure of [false, true]) {
    const c = await ready(); await c.tool.copy(c.runId); await c.tool.activate(c.runId, { writersDrained: true }); await changes(c);
    const write = c.source.write.bind(c.source); let lost = false;
    c.source.write = async (entry, options) => {
      const receipt = await write(entry, options);
      if (!lost && entry.key.startsWith(storageFailure ? 'inventory/' : 'fs/')) { lost = true; throw new Error('합성 승인 응답 유실'); }
      return receipt;
    };
    await assert.rejects(c.tool.rollback(c.runId, { writersDrained: true }));
    assert.equal((await c.tool.rollback(c.runId, { writersDrained: true })).mismatches, 0);
  }
});
test('미지원 인벤토리와 target 변조는 성공으로 덮어쓰지 않는다', async () => {
  const c = await ready(); await c.tool.copy(c.runId);
  await c.runtime.profile.update(c.fixture.uid, { Nickname: '별도 대상 작업' });
  await assert.rejects(c.tool.activate(c.runId, { writersDrained: true }), { code: 'MIGRATION_COMPARE_FAILED' });
  assert.equal((await c.runtime.profile.read(c.fixture.uid)).value.Nickname, '별도 대상 작업');
  const second = await ready();
  await second.connection.bucket.file(`users/${second.fixture.uid}/inventory.json`).save('{"version":99,"cards":{}}', { resumable: false });
  await assert.rejects(second.tool.copy(second.runId), { code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION' });
  assert.equal((await second.source.read(`inventory/${second.fixture.uid}`)).value.version, 99);
});
test('해결되지 않은 claims writer가 있으면 전환을 막고 잠금을 보존한다', async () => {
  const c = await ready(); await c.tool.copy(c.runId);
  const operation = await c.runtime.customClaims.acquire(c.fixture.uid);
  await assert.rejects(c.tool.activate(c.runId, { writersDrained: true }), { code: 'MIGRATION_AUTH_WRITE_UNRESOLVED' });
  assert.equal((await c.runtime.customClaims.inspect(c.fixture.uid)).operationId, operation);
});
test('이전 직후 실제 사용자 HTTP 조회·설정 API의 7열·시각·혜택·설정 계약을 유지한다', async () => {
  const c = await ready(); await c.tool.copy(c.runId); await c.tool.activate(c.runId, { writersDrained: true });
  const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
  const express = require('express'), repository = createRtdbUserProfileRepository({ storage: { profile: c.runtime.profile, inventory: c.runtime.inventory } });
  const { resolveAccountRole } = require('../services/membershipPolicy');
  const filename = path.resolve(__dirname, '../routes/user.js'), loaded = new Module(filename, module);
  const mocks = {
    '../services/membershipPolicy': require('../services/membershipPolicy'),
    'firebase-functions/v2/https': { onRequest: (_, handler) => handler },
    '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler },
    '../services/userProfileRepository': { getUserProfileRepository: () => repository },
    '../utils/auth': { setCors() {}, verifyAppCheck: async () => true,
      verifyRegisteredUser: async () => (await repository.isRegistered(c.fixture.uid)) ? c.fixture.uid : null,
      getVerifiedAccountRole: async () => resolveAccountRole((await c.connection.auth.getUser(c.fixture.uid)).customClaims) },
    '../utils/inventoryStorage': { downloadInventory: async uid => ({ data: (await c.runtime.inventory.read(uid)).value }),
      updateInventoryWithRetry: () => assert.fail('조회에서 새 카드 접근 금지'), deleteInventory: uid => c.runtime.inventory.clear(uid) },
    '../services/inventoryMigrationService': { ensureInventoryV2: async uid => (await c.runtime.inventory.read(uid)).value,
      inventoryMigrationStatus: (() => {
        const file = path.resolve(__dirname, '../services/inventoryMigrationService.js'), isolated = new Module(file, module);
        const dependencies = { './inventoryCardLookup': {}, '../utils/common': {}, 'node:timers': require('node:timers') };
        isolated.require = name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; };
        isolated._compile(fs.readFileSync(file, 'utf8'), file); return isolated.exports.inventoryMigrationStatus;
      })() },
    '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
  };
  loaded.require = name => { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const app = express(); app.use(express.json()); app.get('/user', loaded.exports.getUserData); app.post('/settings', loaded.exports.updateUserSettings);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${url}/user`), body = await response.json(); assert.equal(response.status, 200);
    assert.deepEqual(body.allCards, [['합성 카드', 'KOREA-A01', '레어.★', 2, '상자.[A]', '01', null]]);
    assert.equal(body.createdAt, 1700000000123); assert.equal(body.nickname, '합성'); assert.equal(body.settings.membership.type, 'discord');
    const update = await fetch(`${url}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { theme: 'light', membership: { status: 'none' } } }) });
    assert.equal(update.status, 200); const profile = (await c.runtime.profile.read(c.fixture.uid)).value;
    assert.equal(profile.settings.theme, 'light'); assert.equal(profile.settings.membership.status, 'active');
    await c.tool.rollback(c.runId, { writersDrained: true });
    assert.equal((await c.connection.db.collection('users').doc(c.fixture.uid).get()).data().settings.theme, 'light');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); }
});
test('독립 CLI 프로세스가 전체 합성 리허설을 수행하고 집계만 보고한다', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/rehearse_user_migration.cjs', '--synthetic', '--run'], { env: process.env });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('리허설 CLI 제한 시간')); }, 60000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.rolledBack.mismatches, 0); assert.equal(report.retainedUnchanged, true);
  assert.doesNotMatch(result.stdout, /Nickname|secretHash|memberName|discordId|nonceHash|synthetic-/);
});
