'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createProfileWriterBinding } = require('../services/userProfileWriterRepository');
const { createProfileStore } = require('../services/user-storage/profileStore');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { createInventoryStore } = require('../services/user-storage/inventoryStore');
const { encodeKey } = require('../services/user-storage/codec');
const { content } = require('../services/userMigrationRehearsal');
const id = () => randomBytes(16).toString('hex');
async function setup(options = {}, runId = id()) {
  const connection = open(runId);
  const binding = createProfileWriterBinding({ db: connection.db, database: connection.targetDatabase, FieldValue, runId,
    inventoryExists: async (backend, uid) => backend === 'legacy'
      ? (await connection.bucket.file(`users/${uid}/inventory.json`).exists())[0]
      : (await createPartitionedInventoryStore({ database: connection.targetDatabase }).readMetadata(uid)).exists, ...options });
  await binding.initialize();
  return { runId, connection, ...binding, close: () => connection.close() };
}
async function switchTo(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
test('native 프로필 복사·쓰기·역방향 전환은 서버 시각·빈값·회원 원본과 기존 reader 형식을 보존한다', async () => {
  const f = await setup();
  try {
    const original = { Nickname: '기존', createdAt: new Timestamp(1700000000, 123000), null: null, empty: {}, list: [],
      settings: { membership: { active: true, provider: 'youtube', tier: 'A' }, onboarding: { old: true }, isDetailMode: true } };
    await f.connection.db.collection('users').doc('member').set(original);
    const old = await f.transition.route(); await f.transition.copy(old);
    await f.repository.updateSettings('member', { theme: 'dark', onboarding: {} });
    await f.repository.updateNickname('member', '변경');
    await f.transition.drain(old); await f.transition.activate(old);
    const native = await createProfileStore({ database: f.connection.targetDatabase }).read('member');
    assert.equal(native.value.Nickname, '변경'); assert.equal(native.value.createdAt.isEqual(original.createdAt), true);
    assert.deepEqual(native.value.settings.membership, original.settings.membership); assert.deepEqual(native.value.settings.onboarding, {});
    assert.equal(typeof native.value.settings.updatedAt, 'number'); assert.ok(native.value.updatedAt instanceof Timestamp);
    await f.repository.completeRegistration('new', { terms: 't', privacy: 'p' });
    const created = (await f.repository.read('new')).value;
    assert.ok(created.createdAt instanceof Timestamp); assert.ok(created.registration.consent.acceptedAt instanceof Timestamp);
    assert.equal(created.createdAt.isEqual(created.registration.consent.acceptedAt), true);
    await f.repository.updateSettings('member', { theme: 'light' });
    await switchTo(f); const source = (await f.connection.db.collection('users').doc('member').get()).data();
    assert.equal(source.settings.theme, 'light'); assert.equal(source.createdAt.isEqual(original.createdAt), true);
    assert.equal((await f.connection.db.collection('users').doc('new').get()).data().createdAt.isEqual(created.createdAt), true);
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('Firestore와 RTDB 가입은 동시 재요청에서도 최초 서버 시각/동의를 한 번만 만든다', async () => {
  const first = await setup(), second = await setup({}, first.runId);
  try {
    for (const [backend, uid] of [['legacy', 'first'], ['rtdb', 'second']]) {
      if (backend === 'rtdb') await switchTo(first);
      await Promise.all([first.repository.completeRegistration(uid, { terms: 't', privacy: 'p' }), second.repository.completeRegistration(uid, { terms: 't', privacy: 'p' })]);
      const saved = (await first.repository.read(uid)).value;
      assert.ok(saved.createdAt instanceof Timestamp); assert.equal(saved.createdAt.isEqual(saved.registration.consent.acceptedAt), true);
      await second.repository.completeRegistration(uid, { terms: 'different', privacy: 'different' });
      assert.equal((await second.repository.read(uid)).value.createdAt.isEqual(saved.createdAt), true);
      assert.equal((await second.repository.read(uid)).value.registration.consent.terms, 't');
    }
  } finally { await Promise.all([first.close(), second.close()]); }
});
test('인벤토리-only 회원은 어느 backend에서도 프로필/과거 동의를 만들어내지 않는다', async () => {
  const f = await setup();
  try {
    await f.connection.bucket.file('users/legacyOnly/inventory.json').save('{"version":3}', { resumable: false });
    assert.equal(await f.repository.isRegistered('legacyOnly'), true);
    await f.repository.completeRegistration('legacyOnly', { terms: 't', privacy: 'p' });
    assert.equal((await f.repository.read('legacyOnly')).exists, false);
    await switchTo(f);
    await createInventoryStore({ database: f.connection.targetDatabase }).update('rtdbOnly', () => {});
    assert.equal(await f.repository.isRegistered('rtdbOnly'), true);
    await f.repository.completeRegistration('rtdbOnly', { terms: 't', privacy: 'p' });
    assert.equal((await f.repository.read('rtdbOnly')).exists, false);
    assert.equal((await f.transition.inspect()).captured, 0);
  } finally { await f.close(); }
});
test('동시 설정·닉네임 변경은 두 SDK의 프로필 병합과 빈 map 교체를 유지한다', async () => {
  const f = await setup(), other = await setup({}, f.runId);
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    for (const backend of ['legacy', 'rtdb']) {
      if (backend === 'rtdb') await switchTo(f);
      await Promise.all([f.repository.updateSettings('member', { theme: 'dark', onboarding: {} }),
        other.repository.updateSettings('member', { isDetailMode: true }), other.repository.updateNickname('member', '병합')]);
      const value = (await f.repository.read('member')).value;
      assert.equal(value.settings.theme, 'dark'); assert.equal(value.settings.isDetailMode, true);
      assert.equal(value.Nickname, '병합'); assert.deepEqual(value.settings.onboarding, {});
    }
  } finally { await Promise.all([f.close(), other.close()]); }
});
test('서버 시각을 포함한 Firestore native 저장 ACK 유실은 새 연결 receipt로 정확히 재생한다', async () => {
  let f, operation;
  f = await setup({ onCheckpoint: stage => { if (stage === 'businessCommitted') throw new Error('합성 응답 유실'); } });
  const original = f.stores.legacy.commit; f.stores.legacy.commit = async op => { operation = op.id; return original(op); };
  try {
    await assert.rejects(f.repository.completeRegistration('new', { terms: 't', privacy: 'p' }));
    const expected = (await f.connection.db.collection('users').doc('new').get()).data();
    const runId = f.runId; await f.close(); f = await setup({}, runId);
    await f.transition.recover(operation); await f.transition.recover(operation); await switchTo(f);
    const target = (await createProfileStore({ database: f.connection.targetDatabase }).read('new')).value;
    assert.equal(target.createdAt.isEqual(expected.createdAt), true); assert.equal(target.registration.consent.acceptedAt.isEqual(expected.registration.consent.acceptedAt), true);
    assert.equal((await f.transition.inspect()).captured, 1);
  } finally { await f.close(); }
});
test('RTDB native 저장 ACK 유실은 profile+receipt의 같은 서버 시각을 새 연결에서 복구한다', async () => {
  let f = await setup(), operation;
  try {
    await switchTo(f); const original = f.stores.rtdb.commit;
    f.stores.rtdb.commit = async op => { operation = op.id; await original(op); throw new Error('합성 RTDB ACK 유실'); };
    await assert.rejects(f.repository.completeRegistration('new', { terms: 't', privacy: 'p' }));
    const saved = (await createProfileStore({ database: f.connection.targetDatabase }).read('new')).value;
    const runId = f.runId; await f.close(); f = await setup({}, runId); await f.transition.recover(operation); await switchTo(f);
    const source = (await f.connection.db.collection('users').doc('new').get()).data();
    assert.equal(source.createdAt.isEqual(saved.createdAt), true); assert.equal(source.registration.consent.acceptedAt.isEqual(saved.registration.consent.acceptedAt), true);
  } finally { await f.close(); }
});
test('지연 native writer는 전환을 막고 drain 중 새 요청은 다른 backend에 재전송되지 않는다', async () => {
  const f = await setup(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; }), original = f.stores.legacy.commit;
  f.stores.legacy.commit = async op => { entered(); await new Promise(resolve => { release = resolve; }); return original(op); };
  try {
    const pending = f.repository.updateNickname('member', '지연'); await started;
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.repository.updateSettings('member', { theme: 'dark' }), { code: 'WRITER_DRAINING' });
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    release(); await pending; await f.transition.activate(writer);
    assert.equal((await f.repository.read('member')).value.Nickname, '지연');
  } finally { release?.(); await f.close(); }
});
test('native CAS 충돌은 영구 취소 후 재조회로 병합하고 사용자 부모의 인증/잠금 자료를 유지한다', async () => {
  const f = await setup();
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    let injected = false; const original = f.stores.legacy.commit;
    f.stores.legacy.commit = async op => { if (!injected) { injected = true; await f.connection.db.collection('users').doc('member').set({ outside: { retained: true } }, { merge: true }); } return original(op); };
    await f.repository.updateSettings('member', { theme: 'dark' });
    assert.equal((await f.repository.read('member')).value.outside.retained, true);
    await switchTo(f);
    const parent = f.connection.targetDatabase.ref(`users/${encodeKey('member')}`);
    await parent.child('membershipVerifications').set({ synthetic: { preserved: true } }); await parent.child('customClaimsSync').set({ state: 'running' });
    await f.repository.updateNickname('member', '보존');
    assert.deepEqual((await parent.child('membershipVerifications').get()).val(), { synthetic: { preserved: true } });
    assert.equal((await parent.child('customClaimsSync').get()).val().state, 'running');
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('native projection ACK 유실·tombstone·대상 변조는 재개와 대조 경계를 유지한다', async () => {
  let f = await setup();
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    const writer = await f.transition.route(), original = f.stores.rtdb.apply; let failed = false;
    f.stores.rtdb.apply = async (...args) => { const saved = await original(...args); if (!failed) { failed = true; throw new Error('합성 projection ACK 유실'); } return saved; };
    await assert.rejects(f.transition.copy(writer)); const runId = f.runId; await f.close(); f = await setup({}, runId);
    await f.transition.copy(writer); await f.transition.drain(writer);
    await createProfileStore({ database: f.connection.targetDatabase }).update('member', { outside: true });
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_DESTINATION_CHANGED' });
    const tombstoneKey = 'fs/users/tombstone';
    const absent = await f.stores.rtdb.read(tombstoneKey);
    const saved = await f.stores.rtdb.apply(id(), { ...absent, exists: false }, absent);
    assert.equal(saved.exists, false); assert.equal((await createProfileStore({ database: f.connection.targetDatabase }).read('tombstone')).generation, 1);
    const fsAbsent = await f.stores.legacy.read(tombstoneKey);
    const fsSaved = await f.stores.legacy.apply(id(), { ...fsAbsent, exists: false }, fsAbsent);
    assert.equal(fsSaved.exists, false); assert.notEqual(fsSaved.token, '0');
  } finally { await f.close(); }
});

// 실제 라우트/가입 서비스/selector를 연결한다. Auth/App Check·카드/인벤토리/claims는 명시적 합성 경계다.
async function httpHarness(f) {
  const path = require('node:path'), Module = require('node:module'), fs = require('node:fs');
  const load = (relative, mocks, env = {}) => {
    const filename = path.join(__dirname, '..', relative), mod = new Module(filename, module); mod.filename = filename;
    mod.require = name => {
      if (name === '../services/loginUserData') return load('services/loginUserData.js', Object.fromEntries(Object.entries(mocks).map(([key,value]) => [key.replace('../services/', './'), value])), env);
      if (['../services/inventoryRequestTiming', './inventoryRequestTiming'].includes(name)) return require('../services/inventoryRequestTiming');
      if (name === '../services/initialWriterRoute') return require('../services/initialWriterRoute');
      assert.ok(Object.hasOwn(mocks, name), `예상하지 않은 의존성: ${name}`); return mocks[name];
    };
    mod._compile(`const process = { env: ${JSON.stringify(env)} };\n${fs.readFileSync(filename, 'utf8')}`, filename); return mod.exports;
  };
  const selected = load('services/userProfileRepository.js', { './userProfileWriterRuntime': { getProfileWriterRepository: () => f.repository } }, { USER_PROFILE_WRITER_MODE: 'emulator' });
  const registration = load('services/registrationService.js', { './userProfileRepository': selected });
  const auth = { setCors() {}, verifyAppCheck: async () => true,
    verifyUser: async req => /^synthetic:([a-zA-Z0-9_-]+)$/.exec(req.headers.authorization)?.[1],
    async verifyRegisteredUser(req, res) { const uid = await auth.verifyUser(req); if (!uid || !await registration.isRegisteredUser(uid)) {
      res.status(403).json({ success: false, code: 'REGISTRATION_REQUIRED' }); return null; } return uid; },
    getVerifiedAccountRole: async () => 'none' };
  const onRequest = (_options, handler) => handler;
  const reg = load('routes/registration.js', { 'firebase-functions/v2/https': { onRequest }, '../utils/auth': auth,
    '../utils/safeError': { safeErrorSummary: () => ({ type: 'synthetic' }) }, '../services/registrationService': registration });
  const inventory = { version: 3, amount: 0, cards: {}, locations: {}, rarities: {} };
  const user = load('routes/user.js', { 'firebase-functions/v2/https': { onRequest }, '../services/userProfileRepository': selected,
    '../services/membershipPolicy': require('../services/membershipPolicy'), '../services/publicReadTransport': { withPublicReadRequest: handler => handler },
    '../services/userStorageRequestGuard': { withUserStorageRequestGuard: handler => handler }, '../utils/auth': auth,
    '../utils/inventoryStorage': { downloadInventory: async () => ({ data: inventory }) },
    '../services/inventoryMigrationService': { ensureInventoryV2: async () => inventory, inventoryMigrationStatus: () => ({ needsMigration: false }) },
    '../services/membershipClaims': { syncMembershipClaims: async () => ({ status: 'pending' }) },
  }, { USER_STORAGE_BACKEND: 'rtdb' });
  const express = require('express'), app = express(); app.use(express.json());
  const handlers = { getRegistrationStatus: reg.getRegistrationStatus, completeRegistration: reg.completeRegistration,
    updateUserSettings: user.updateUserSettings, updateNickname: user.updateNickname, getUserData: user.getUserData };
  for (const [name, handler] of Object.entries(handlers)) app.all(`/${name}`, (req, res, next) => Promise.resolve(handler(req, res)).catch(next));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  return { async call(name, uid, body, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${name}`, { method, headers: { Authorization: `synthetic:${uid}`, 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) });
    return { status: response.status, body: await response.json() };
  }, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
test('가입·설정·닉네임·프로필 HTTP 계약은 native 전환 전후에도 동일하다', async () => {
  const f = await setup(), app = await httpHarness(f);
  try {
    for (const backend of ['legacy', 'rtdb']) {
      if (backend === 'rtdb') await switchTo(f);
      const uid = `${backend}Http`, status = await app.call('getRegistrationStatus', uid, null, 'GET');
      assert.equal(status.body.registered, false);
      assert.equal((await app.call('updateUserSettings', uid, { settings: { theme: 'dark' } })).status, 403);
      const body = { agreements: { terms: true, privacy: true }, consentVersions: status.body.consentVersions };
      assert.equal((await app.call('completeRegistration', uid, { ...body, consentVersions: { terms: 'old', privacy: 'old' } })).status, 409);
      assert.deepEqual((await app.call('completeRegistration', uid, body)).body, { success: true, registered: true });
      assert.deepEqual((await app.call('updateUserSettings', uid, { uid: 'other', settings: { theme: 'dark', role: 'owner', membership: { active: true } } })).body,
        { success: true, message: '설정이 성공적으로 저장되었습니다.' });
      assert.deepEqual((await app.call('updateNickname', uid, { nickname: '  합성  ' })).body,
        { success: true, message: '닉네임이 성공적으로 변경되었습니다.' });
      const read = await app.call('getUserData', uid, {}, 'GET');
      assert.equal(read.status, 200); assert.equal(read.body.nickname, '합성'); assert.equal(typeof read.body.createdAt, 'number');
      const value = (await f.repository.read(uid)).value; assert.equal(value.settings.theme, 'dark'); assert.equal(value.settings.membership, undefined);
      assert.equal((await f.repository.read('other')).exists, false);
    }
  } finally { await app.close(); await f.close(); }
});
test('HTTP drain 중 쓰기는 기존 실패 응답을 유지하고 전환 후 재요청으로 저장된다', async () => {
  const f = await setup(), app = await httpHarness(f);
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    const rejected = await app.call('updateUserSettings', 'member', { settings: { theme: 'dark' } });
    assert.equal(rejected.status, 500); assert.equal(rejected.body.success, false);
    assert.equal((await f.repository.read('member')).value.settings, undefined);
    await f.transition.activate(writer); assert.equal((await app.call('updateUserSettings', 'member', { settings: { theme: 'dark' } })).status, 200);
    assert.equal((await createProfileStore({ database: f.connection.targetDatabase }).read('member')).value.settings.theme, 'dark');
  } finally { await app.close(); await f.close(); }
});
test('실제 runtime selector는 demo SDK만 열고 고정 실행 설정 변경을 거부한다', async () => {
  const { spawn } = require('node:child_process');
  const runId = id();
  const source = `
    const assert = require('node:assert/strict');
    const repository = require('./functions/services/userProfileRepository').getUserProfileRepository();
    const runtime = require('./functions/services/userProfileWriterRuntime');
    (async () => {
      try {
        await repository.completeRegistration('runtimeSynthetic', {terms:'t',privacy:'p'});
        const binding = runtime.getProfileWriterBinding(), writer = await binding.transition.route();
        await binding.transition.copy(writer); await binding.transition.drain(writer); await binding.transition.activate(writer);
        await repository.updateSettings('runtimeSynthetic',{theme:'dark'});
        assert.equal((await repository.read('runtimeSynthetic')).value.settings.theme,'dark');
        process.env.USER_PROFILE_WRITER_RUN_ID = 'b'.repeat(32);
        assert.throws(()=>runtime.getProfileWriterBinding(),{code:'USER_STORAGE_CONFIG_INVALID'});
        console.log(JSON.stringify({status:'verified'}));
      } finally { await runtime.closeProfileWriterRuntime(); }
    })().catch(()=>{console.error('PROFILE_WRITER_TEST_FAILED');process.exitCode=1;});
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { cwd: require('node:path').resolve(__dirname, '../..'),
      env: { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { status: 'verified' });
});
test('native Firestore/RTDB 취소 fence는 전환 뒤 도착하는 미반영 요청도 차단한다', async () => {
  const f = await setup();
  try {
    for (const backend of ['legacy', 'rtdb']) {
      assert.equal((await f.transition.route()).backend, backend);
      let release, entered, operation;
      const ready = new Promise(resolve => { entered = resolve; }), original = f.stores[backend].commit;
      f.stores[backend].commit = async op => { operation = op.id; entered(); await new Promise(resolve => { release = resolve; }); return original(op); };
      const pending = f.repository.updateNickname(`${backend}Cancelled`, '취소'); await ready;
      const rejected = assert.rejects(pending); // fence 후 저장 재시도의 epoch 거부도 정상 실패다.
      assert.deepEqual(await f.transition.fenceUncommitted(operation), { status: 'cancelled' });
      await switchTo(f); release(); await rejected;
      assert.equal((await f.repository.read(`${backend}Cancelled`)).exists, false);
      f.stores[backend].commit = original;
    }
  } finally { await f.close(); }
});
test('Firestore 버전 영수증은 native 문서 갱신 시각과 독립적으로 실제 저장 내용에 결합된다', async () => {
  const f = await setup();
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    const before = await f.stores.legacy.read('fs/users/member');
    const applied = await f.stores.legacy.apply(id(), before, before), actual = await f.stores.legacy.read(before.key);
    assert.equal(applied.token, actual.token); assert.equal(content(applied), content(actual));
    assert.equal((await f.connection.db.collection('users').doc('member').get()).data().profileWriterVersion, undefined);
    await f.connection.db.collection('users').doc('member').set({ outside: 'changed' }, { merge: true });
    assert.notEqual((await f.stores.legacy.read(before.key)).token, actual.token);
  } finally { await f.close(); }
});
test('명시 native 취소는 accepting 상태에서도 새 작업 ID로 자동 재실행하지 않는다', async () => {
  const f = await setup();
  try {
    for (const backend of ['legacy', 'rtdb']) {
      let release, entered, operation;
      const ready = new Promise(resolve => { entered = resolve; }), original = f.stores[backend].commit;
      f.stores[backend].commit = async op => { operation = op.id; entered(); await new Promise(resolve => { release = resolve; }); return original(op); };
      const pending = f.repository.updateNickname(`${backend}ExplicitCancel`, '취소'); await ready;
      const rejected = assert.rejects(pending, { code: 'WRITER_CANCELLED' });
      assert.deepEqual(await f.transition.fenceUncommitted(operation), { status: 'cancelled' });
      release(); await rejected;
      assert.equal((await f.repository.read(`${backend}ExplicitCancel`)).exists, false);
      assert.equal((await f.transition.inspect()).unresolved, 0);
      f.stores[backend].commit = original; await switchTo(f);
    }
    assert.equal((await f.transition.inspect()).captured, 0);
  } finally { await f.close(); }
});
