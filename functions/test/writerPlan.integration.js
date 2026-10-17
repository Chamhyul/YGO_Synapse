'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createWriterPlanStore } = require('../services/user-storage/writerPlanStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { createUserWriterTransition } = require('../services/userWriterTransition');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
async function setup(options = {}, runId = id()) {
  const connection = open(runId), binding = createUserInventoryWriterBinding({ db: connection.db, database: connection.targetDatabase, bucket: connection.bucket,
    FieldValue, runId, config: connection.config, migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) }, ...options });
  await binding.initialize(); return { ...binding, connection, runId, close: () => connection.close(),
    plans: createWriterPlanStore({ database: connection.targetDatabase, runId }), journal: createWriterJournalStore({ database: connection.targetDatabase, path: 'profileWriterTransitions' }) };
}
async function flip(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
test('native 페이지 수집 중단 후 resume는 원본 epoch를 fence하고 같은 context·보관 이력으로 전환/역전환한다', async () => {
  let once = true; const f = await setup({ onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && once) { once = false; throw Error('합성 수집 중단'); } } }); let other;
  try {
    const batch = f.connection.db.batch(); for (let n = 0; n < 28; n++) batch.set(f.connection.db.collection('users').doc('synthetic-' + String(n).padStart(3, '0')), { Nickname: '합성', settings: { theme: 'light' }, time: new Timestamp(100, 123000) }); await batch.commit();
    const writer = await f.transition.route(); await f.repository.updateSettings('synthetic-000', { onboarding: { complete: true } });
    await assert.rejects(f.transition.copy(writer), /합성 수집 중단/); await f.transition.drain(writer);
    const before = (await f.journal.read(f.runId)).value, resumed = await f.transition.resume(writer, { id: id(), writersDrained: true });
    assert.equal(resumed.backend, 'legacy'); assert.equal(resumed.epoch, 2); assert.deepEqual((await f.journal.read(f.runId)).value.transfer, before.transfer);
    await assert.rejects(f.transition.copy(writer), { code: 'WRITER_FENCED' });
    other = await setup({}, f.runId); await other.repository.updateSettings('synthetic-000', { theme: 'dark' });
    await other.transition.compact(); const held = (await other.journal.read(f.runId)).value;
    assert.ok(held.events.some(event => event.epoch === 1 && !event.changes));
    await other.transition.copy(resumed); const ready = (await other.journal.read(f.runId)).value; assert.equal(ready.transfer.id, before.transfer.id);
    const { fingerprint } = require('../services/userMigrationRehearsal'), captureId = fingerprint({ transferId: before.transfer.id, role: 'baseline' }).slice(0, 32);
    const collections = createRecordStore({ database: other.connection.targetDatabase, path: `profileWriterPlans/${encodeKey(f.runId)}/collections` });
    assert.equal((await collections.read(captureId)).value.context.epoch, 1);
    await other.transition.drain(resumed); const active = await other.transition.activate(resumed); assert.equal(active.backend, 'rtdb'); assert.equal(active.epoch, 3);
    const value = (await other.repository.read('synthetic-000')).value; assert.equal(value.settings.theme, 'dark'); assert.equal(value.time.nanoseconds, 123000);
    await other.repository.updateSettings('synthetic-000', { isDetailMode: true }); await flip(other);
    assert.equal((await other.repository.read('synthetic-000')).value.settings.isDetailMode, true);
  } finally { await other?.close(); await f.close(); }
});
test('native resume 응답 유실은 새 SDK와 실제 CLI에서 같은 ID로 재확인하며 원본 API 저장을 허용한다', async () => {
  let once = true; const f = await setup({ onCheckpoint: async stage => { if (stage === 'writersResumed' && once) { once = false; throw Error('합성 재개 ACK 유실'); } } }); let other;
  try {
    const writer = await f.transition.route(), requestId = id(); await f.transition.drain(writer);
    await assert.rejects(f.transition.resume(writer, { id: requestId, writersDrained: true }), /합성 재개 ACK 유실/);
    other = await setup({}, f.runId); const { main } = require('../../scripts/manage_user_writer.cjs'), output = [];
    const env = { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId };
    const args = ['resume', '--writer-emulator', '--apply', '--backend', 'legacy', '--epoch', '1', '--operation', requestId, '--writers-drained'];
    assert.equal(await main(args, { env, createRuntime: () => ({ getProfileWriterBinding: () => other, closeProfileWriterRuntime: async () => {} }), stdout: v => output.push(v) }), 0);
    assert.equal(JSON.parse(output[0]).epoch, 2); assert.equal(JSON.parse(output[0]).phase, 'accepting');
    await other.repository.completeRegistration('synthetic', { terms: 'synthetic', privacy: 'synthetic' });
    assert.equal((await other.transition.route()).epoch, 2);
    await other.transition.copy(await other.transition.route()); await other.transition.drain(await other.transition.route()); await other.transition.activate(await other.transition.route());
  } finally { await other?.close(); await f.close(); }
});
test('native 재개 후 다시 drain해도 지연된 이전 activate는 새 epoch를 활성화하지 못한다', async () => {
  const f = await setup(); let other, release, pending;
  try {
    await f.connection.db.collection('users').doc('synthetic').set({ Nickname: '합성', settings: {} });
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    let entered; const atRead = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const original = f.stores.rtdb.snapshotPage; let once = true;
    f.stores.rtdb.snapshotPage = async cursor => { const value = await original(cursor); if (once) { once = false; entered(); await gate; } return value; };
    pending = assert.rejects(f.transition.activate(writer), { code: 'WRITER_FENCED' }); await atRead;
    other = await setup({}, f.runId); const resumed = await other.transition.resume(writer, { id: id(), writersDrained: true }); await other.transition.drain(resumed);
    release(); await pending; assert.equal((await other.transition.route()).backend, 'legacy'); assert.equal((await other.transition.route()).epoch, 2);
    await other.transition.copy(resumed); assert.equal((await other.transition.activate(resumed)).backend, 'rtdb');
  } finally { release?.(); await pending?.catch(() => {}); await other?.close(); await f.close(); }
});
test('native 미확정 업무는 resume를 막고 영수증 복구 후에만 원본 쓰기를 재개한다', async () => {
  let once = true; const f = await setup({ onCheckpoint: async stage => { if (stage === 'businessCommitted' && once) { once = false; throw Error('합성 업무 ACK 유실'); } } });
  try {
    const writer = await f.transition.route(), operation = id(), requestId = id();
    await f.transition.prepare(writer, operation, [{ key: 'fs/users/synthetic', exists: true, token: '0', value: { Nickname: '합성', settings: {} } }], null, { details: { kind: 'profile', serverTimestampPaths: [] } });
    await assert.rejects(f.transition.execute(writer, operation), /합성 업무 ACK 유실/); await f.transition.drain(writer);
    await assert.rejects(f.transition.resume(writer, { id: requestId, writersDrained: true }), { code: 'WRITER_NOT_DRAINED' });
    assert.equal((await f.transition.route()).phase, 'draining'); await f.transition.recover(operation);
    const resumed = await f.transition.resume(writer, { id: requestId, writersDrained: true }); await f.repository.updateSettings('synthetic', { theme: 'dark' });
    await f.transition.copy(resumed); await f.transition.drain(resumed); await f.transition.activate(resumed);
    assert.equal((await f.repository.read('synthetic')).value.settings.theme, 'dark');
  } finally { await f.close(); }
});
test('native 제출 전 작업은 CLI로 멱등 취소한 뒤 새 요청 ID로 resume하며 지연 실행을 차단한다', async () => {
  const f = await setup(); try {
    const writer = await f.transition.route(), operation = id();
    await f.transition.prepare(writer, operation, [{ key: 'fs/users/synthetic', exists: true, token: '0', value: { Nickname: '합성', settings: {} } }], null, { details: { kind: 'profile', serverTimestampPaths: [] } }); await f.transition.drain(writer);
    const { main } = require('../../scripts/manage_user_writer.cjs'), env = { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId };
    const args = ['cancel-prepared', '--writer-emulator', '--apply', '--backend', 'legacy', '--epoch', '1', '--operation', operation, '--writers-drained'];
    const dependencies = { env, createRuntime: () => ({ getProfileWriterBinding: () => f, closeProfileWriterRuntime: async () => {} }), stdout: () => {} };
    assert.equal(await main(args, dependencies), 0); assert.equal(await main(args, dependencies), 0);
    await assert.rejects(f.transition.execute(writer, operation), { code: 'WRITER_CANCELLED' }); assert.equal((await f.connection.db.collection('users').doc('synthetic').get()).exists, false);
    const resumed = await f.transition.resume(writer, { id: id(), writersDrained: true }); await f.repository.completeRegistration('synthetic', { terms: 'synthetic', privacy: 'synthetic' });
    await f.transition.copy(resumed); await f.transition.drain(resumed); assert.equal((await f.transition.activate(resumed)).backend, 'rtdb');
  } finally { await f.close(); }
});
test('native 총4MiB 초과 복사/기대값/롤백 원문은 분할 보관하고 작은 hot 참조로 양방향 전환한다', async () => {
  const f = await setup(); try {
    const batch = f.connection.db.batch();
    for (let n = 0; n < 70; n++) batch.set(f.connection.db.collection('users').doc('synthetic-' + String(n).padStart(3, '0')), { body: 'x'.repeat(65536), n, null: null, empty: [], time: Timestamp.fromMillis(1000) });
    await batch.commit(); await flip(f);
    const state = (await f.journal.read(f.runId)).value; assert.ok(!Array.isArray(state.frozen.legacy));
    assert.equal(state.frozen.legacy.count, (await f.stores.legacy.snapshot()).length); assert.ok((await f.transition.historyStatus()).hotBytes < 10000);
    await f.repository.updateSettings('synthetic-001', { theme: 'dark' }); await flip(f);
    assert.equal((await f.repository.read('synthetic-001')).value.settings.theme, 'dark');
    assert.equal((await f.repository.read('synthetic-069')).value.body.length, 65536); assert.equal((await f.repository.read('synthetic-069')).value.time.toMillis(), 1000);
    assert.ok((await f.transition.historyStatus()).hotBytes < 1000000);
  } finally { await f.close(); }
});
test('본문 chunk는 Unicode/시각/배열을 보존하며 목록 페이지/본문 손상·누락은 거부한다', async () => {
  const f = await setup(); try {
    const source = [{ key: 'fs/users/합성', exists: true, token: '0', value: { body: '가😀'.repeat(60000), null: null, empty: [], time: Timestamp.fromMillis(1), negative: -0 } }];
    const ref = await f.plans.save(source); const result = []; for await (const item of f.plans.scan(ref)) result.push(item.entry);
    assert.deepEqual(result, source);
    const pages = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}/pages/${ref.id}`), original = (await pages.get()).val();
    await pages.remove(); await assert.rejects(f.plans.verify(ref), { code: 'WRITER_PLAN_CONFLICT' }); await pages.set(original);
    const chunks = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}/chunks/${ref.id}`), raw = (await chunks.get()).val();
    await chunks.remove(); await assert.rejects(f.plans.verify(ref), { code: 'WRITER_PLAN_CONFLICT' }); await chunks.set(raw);
    await f.plans.verify(ref);
  } finally { await f.close(); }
});
test('계획 게시/기대값 checkpoint 승인 유실은 새 SDK에서 native projection을 중복 적용하지 않고 재개한다', async () => {
  let fail = 'planPrepared'; const f = await setup({ onCheckpoint: async stage => { if (stage === fail) { fail = ''; throw Error('synthetic plan ack loss'); } } });
  try {
    await f.connection.db.collection('users').doc('synthetic').set({ preserve: [] }); const writer = await f.transition.route();
    await assert.rejects(f.transition.copy(writer)); assert.equal((await f.journal.read(f.runId)).value.transfer.baseline, null);
    fail = 'planCheckpointed'; await assert.rejects(f.transition.copy(writer));
    assert.equal((await f.journal.read(f.runId)).value.transfer.baseCursor, 0);
    const other = await setup({}, f.runId); try { await other.transition.copy(writer); await other.transition.drain(writer); await other.transition.activate(writer);
      assert.deepEqual((await other.repository.read('synthetic')).value.preserve, []);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
test('복사 중 변경/새 키·대상 우회 수정과 frozen 손상은 자료를 덮어쓰지 않고 전환을 막는다', async () => {
  const f = await setup(); try {
    await f.repository.updateSettings('old', { theme: 'dark' }); const writer = await f.transition.route(); await f.transition.copy(writer);
    await f.repository.updateSettings('old', { theme: 'light' }); await f.repository.updateSettings('new', { theme: 'dark' });
    await f.transition.replay(writer); await f.transition.drain(writer); await f.transition.activate(writer);
    assert.equal((await f.repository.read('old')).value.settings.theme, 'light'); assert.equal((await f.repository.read('new')).value.settings.theme, 'dark');
    const state = (await f.journal.read(f.runId)).value;
    const unsafe = createUserWriterTransition({ journal: f.journal, history: { get: async () => {}, put: async () => {} }, stores: f.stores, runId: f.runId, checkKey: () => {} });
    await assert.rejects(unsafe.route(), { code: 'WRITER_PLAN_STORE_REQUIRED' });
    const manifest = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}/manifests/${encodeKey(state.frozen.legacy.id)}`);
    const original = (await manifest.get()).val(); await manifest.remove(); await assert.rejects(f.transition.copy(await f.transition.route()), { code: 'WRITER_PLAN_CONFLICT' }); await manifest.set(original);
    await f.connection.db.collection('users').doc('old').set({ altered: true });
    await assert.rejects(f.transition.copy(await f.transition.route()), { code: 'WRITER_DESTINATION_CHANGED' });
  } finally { await f.close(); }
});
test('두 SDK의 계획/재생 경합과 늦은 baseline 응답은 새 epoch와 최신 자료를 되돌리지 않는다', async () => {
  let release, entered, once = false;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await setup({ onCheckpoint: async stage => { if (once && stage === 'planCheckpointed') { once = false; entered(); await gate; } } });
  let other;
  try {
    await f.repository.updateSettings('synthetic', { theme: 'dark' }); const writer = await f.transition.route(); once = true;
    const pending = f.transition.copy(writer).then(value => ({ value }), error => ({ error })); await ready;
    other = await setup({}, f.runId); await other.transition.copy(writer); await other.transition.drain(writer); await other.transition.activate(writer);
    await other.repository.updateSettings('synthetic', { theme: 'light' }); release(); assert.equal((await pending).error.code, 'WRITER_FENCED');
    assert.equal((await other.repository.read('synthetic')).value.settings.theme, 'light'); assert.equal((await other.transition.route()).epoch, 2);
  } finally { release?.(); await other?.close(); await f.close(); }
});

test('원본 페이지 진행점에서 새 SDK로 재개하고 앞쪽 신규·수정·삭제도 변경 기록으로 보존한다', async () => {
  let interrupted = false;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && !interrupted) { interrupted = true; throw Error('synthetic capture stop'); } } });
  let other;
  try {
    const batch = f.connection.db.batch();
    for (let n = 0; n < 63; n++) batch.set(f.connection.db.collection('users').doc('synthetic-' + String(n).padStart(3, '0')), { n, body: '합성🙂'.repeat(100), null: null, empty: [], time: Timestamp.fromMillis(1000) });
    await batch.commit(); const writer = await f.transition.route();
    let oldArrayCalls = 0; for (const store of Object.values(f.stores)) store.snapshot = async () => { oldArrayCalls++; throw Error('전체 배열 수집 금지'); };
    await assert.rejects(f.transition.copy(writer), /synthetic capture stop/);
    const before = (await f.journal.read(f.runId)).value.transfer;
    assert.equal(before.collectionMode, 'paged'); assert.equal(before.baseline, null);
    await f.repository.updateSettings('synthetic-000', { theme: 'dark' });
    await f.repository.updateSettings('aaa-new', { theme: 'light' });
    // 이미 수집된 삭제도 변경 기록에서 재생한다.
    const key = 'fs/users/synthetic-001', observed = await f.stores.legacy.read(key), opId = id();
    await f.transition.prepare(writer, opId, [{ key, exists: false, token: observed.token }], null, { details: { kind: 'profile', serverTimestampPaths: [] } });
    await f.transition.execute(writer, opId);
    other = await setup({}, f.runId); const positions = [];
    for (const [backend, store] of Object.entries(other.stores)) {
      const page = store.snapshotPage; store.snapshot = async () => { oldArrayCalls++; throw Error('전체 배열 수집 금지'); };
      store.snapshotPage = async cursor => { positions.push({ backend, cursor }); return page(cursor); };
    }
    await other.transition.copy(writer); assert.equal((await other.journal.read(f.runId)).value.transfer.id, before.id);
    assert.equal(positions[0].backend, 'legacy'); assert.deepEqual(positions[0].cursor, { source: 0, after: 'synthetic-024' });
    await other.transition.drain(writer); await other.transition.activate(writer);
    assert.equal((await other.repository.read('synthetic-000')).value.settings.theme, 'dark');
    assert.equal((await other.repository.read('aaa-new')).value.settings.theme, 'light');
    assert.equal((await other.repository.read('synthetic-001')).exists, false);
    assert.equal((await other.repository.read('synthetic-062')).value.time.toMillis(), 1000);
    await other.repository.updateSettings('synthetic-000', { theme: 'light' });
    await other.transition.copy(await other.transition.route()); await other.transition.drain(await other.transition.route()); await other.transition.activate(await other.transition.route());
    assert.equal((await other.repository.read('synthetic-000')).value.settings.theme, 'light'); assert.equal(oldArrayCalls, 0);
  } finally { await other?.close(); await f.close(); }
});

test('수집 페이지 ACK 유실 뒤 원본은 재조회하지 않고 저장된 페이지를 대조해 재개한다', async () => {
  let interrupted = false;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'sourcePageSaved' && !interrupted) { interrupted = true; throw Error('synthetic page ack loss'); } } });
  let other;
  try {
    await f.connection.db.collection('users').doc('synthetic').set({ null: null, empty: [] }); const writer = await f.transition.route();
    await assert.rejects(f.transition.copy(writer), /synthetic page ack loss/);
    other = await setup({}, f.runId); const original = other.stores.legacy.snapshotPage, positions = [];
    other.stores.legacy.snapshotPage = async cursor => { positions.push(cursor); return original(cursor); };
    await other.transition.copy(writer); assert.ok(positions[0]); assert.equal(positions[0].source, 1);
    await other.transition.drain(writer); await other.transition.activate(writer);
    assert.deepEqual((await other.repository.read('synthetic')).value, { null: null, empty: [] });
  } finally { await other?.close(); await f.close(); }
});

test('수집 위치 변조와 확정 페이지 누락은 대상 업무 반영 전에 거부하고 복원 후 같은 작업으로 이어간다', async () => {
  let interrupted = false;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && !interrupted) { interrupted = true; throw Error('synthetic checkpoint stop'); } } });
  try {
    await f.connection.db.collection('users').doc('synthetic').set({ preserve: [] }); const writer = await f.transition.route();
    await assert.rejects(f.transition.copy(writer)); const transfer = (await f.journal.read(f.runId)).value.transfer;
    const captureId = require('../services/userMigrationRehearsal').fingerprint({ transferId: transfer.id, role: 'baseline' }).slice(0, 32);
    const progress = createRecordStore({ database: f.connection.targetDatabase, path: `profileWriterPlans/${encodeKey(f.runId)}/collections` });
    const original = await progress.read(captureId); await progress.compareAndSet(captureId, original.revision, { ...original.value, cursor: { source: 2, after: null } });
    await assert.rejects(f.transition.copy(writer), { code: 'WRITER_PLAN_CONFLICT' });
    assert.equal((await f.stores.rtdb.read('fs/users/synthetic')).exists, false);
    const now = await progress.read(captureId); await progress.compareAndSet(captureId, now.revision, original.value);
    const page = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}/collectionPages/${captureId}/${encodeKey('0'.repeat(32))}`), saved = (await page.get()).val();
    await page.remove(); await assert.rejects(f.transition.copy(writer), { code: 'WRITER_PLAN_CONFLICT' }); await page.set(saved);
    await f.transition.copy(writer); assert.equal((await f.journal.read(f.runId)).value.transfer.id, transfer.id);
    await f.transition.drain(writer); await f.transition.activate(writer); assert.deepEqual((await f.repository.read('synthetic')).value.preserve, []);
  } finally { await f.close(); }
});

test('Storage 다음 페이지와 인벤토리-only 사용자도 배열 수집 없이 보존하며 RTDB 페이지로 역전환한다', async () => {
  const f = await setup();
  try {
    const inventory = { version: 3, updatedAt: '2020-01-01T00:00:00.000Z', amount: 0, cards: {}, locations: {}, rarities: {} };
    for (let n = 0; n < 27; n++) await f.connection.bucket.file(`users/storage-only-${String(n).padStart(2, '0')}/inventory.json`).save(JSON.stringify(inventory), { resumable: false, contentType: 'application/json' });
    const calls = [];
    for (const [backend, store] of Object.entries(f.stores)) { const page = store.snapshotPage;
      store.snapshot = async () => { throw Error('전체 배열 수집 금지'); };
      store.snapshotPage = async cursor => { const value = await page(cursor); assert.ok(value.size <= 50); calls.push({ backend, cursor, count: value.size }); return value; };
    }
    await flip(f);
    assert.equal((await f.repository.read('storage-only-26')).exists, false); assert.equal(await f.repository.isRegistered('storage-only-26'), true);
    assert.equal((await f.inventoryRepository.downloadInventory('storage-only-26')).data.updatedAt, inventory.updatedAt);
    assert.ok(calls.some(call => call.backend === 'legacy' && call.cursor?.source === 4 && call.cursor.after !== null));
    await flip(f); assert.equal((await f.inventoryRepository.downloadInventory('storage-only-26')).data.updatedAt, inventory.updatedAt);
    assert.ok(calls.some(call => call.backend === 'rtdb' && call.cursor?.source === 1 && call.cursor.after !== null));
  } finally { await f.close(); }
});

test('수집 위치 앞쪽의 미참여 writer 변경은 마지막 전체 대조에서 전환을 막고 원본을 보존한다', async () => {
  let interrupted = false;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'sourcePageCheckpointed' && !interrupted) { interrupted = true; throw Error('synthetic stop'); } } });
  try {
    const batch = f.connection.db.batch(); for (let n = 0; n < 26; n++) batch.set(f.connection.db.collection('users').doc(`synthetic-${String(n).padStart(2, '0')}`), { n }); await batch.commit();
    const writer = await f.transition.route(); await assert.rejects(f.transition.copy(writer));
    // 공통 경계를 우회한 변경은 이벤트로 간주하거나 자동으로 덮어쓰지 않는다.
    await f.connection.db.collection('users').doc('aaa-direct').set({ outsideWriter: true });
    await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_COMPARE_FAILED' });
    assert.equal((await f.transition.route()).backend, 'legacy'); assert.equal((await f.transition.route()).epoch, 1);
    assert.equal((await f.connection.db.collection('users').doc('aaa-direct').get()).data().outsideWriter, true);
    assert.equal((await f.stores.rtdb.read('fs/users/aaa-direct')).exists, false);
  } finally { await f.close(); }
});

test('native 미참조 지난 계획만 정리하고 양쪽 frozen·원본·영수증·다음 역전환을 보존한다', async () => {
  const f = await setup();
  try {
    await f.connection.db.collection('users').doc('synthetic-cleanup').set({ body: 'x'.repeat(8192), null: null, empty: [] });
    await f.repository.updateSettings('synthetic-cleanup', { theme: 'dark' });
    await flip(f); await flip(f); await flip(f);
    const writer = await f.transition.route(), state = (await f.journal.read(f.runId)).value;
    const root = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}`);
    const before = JSON.stringify((await root.get()).val()).length;
    const receiptBefore = (await f.connection.db.collection('userProfileWriterReceipts').get()).docs.map(doc => [doc.id, doc.data()]);
    const preview = await f.transition.previewPlanCleanup(writer, { beforeEpoch: writer.epoch, limit: 32 }); assert.ok(preview.selected > 0);
    const report = await f.transition.cleanupPlans(writer, { id: id(), beforeEpoch: writer.epoch, writersDrained: true }); assert.ok(report.removed > 0);
    assert.ok(JSON.stringify((await root.get()).val()).length < before);
    for (const ref of Object.values(state.frozen)) await f.plans.verify(ref);
    assert.deepEqual((await f.connection.db.collection('userProfileWriterReceipts').get()).docs.map(doc => [doc.id, doc.data()]), receiptBefore);
    assert.equal((await f.repository.read('synthetic-cleanup')).value.settings.theme, 'dark');
    assert.equal((await f.transition.route()).phase, 'accepting'); await flip(f);
    assert.equal((await f.repository.read('synthetic-cleanup')).value.body.length, 8192);
  } finally { await f.close(); }
});

test('native 정리 삭제 ACK 유실은 새 SDK·같은 작업 ID로 재개하고 현재 writer를 차단한다', async () => {
  let once = true, removed = 0;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'planScopeRemoved' && ++removed === 8 && once) { once = false; throw Error('synthetic cleanup ack loss'); } } });
  let other;
  try {
    await f.repository.updateSettings('synthetic-cleanup', { theme: 'dark' }); await flip(f); await flip(f);
    const writer = await f.transition.route(), jobId = id();
    await assert.rejects(f.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }), /synthetic cleanup ack loss/);
    assert.equal((await f.transition.route()).phase, 'draining'); await assert.rejects(f.transition.copy(writer), { code: 'WRITER_PLAN_MAINTENANCE' });
    await f.close(); other = await setup({}, f.runId);
    const report = await other.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }); assert.ok(report.removed > 0);
    assert.deepEqual(await other.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }), report);
    assert.equal((await other.repository.read('synthetic-cleanup')).value.settings.theme, 'dark'); await flip(other);
  } finally { await other?.close(); await f.close(); }
});

test('native 정리 목록의 보호 참조 주입은 삭제 전에 거부하고 작업 기록 복원 뒤 재개한다', async () => {
  let once = true;
  const f = await setup({ onCheckpoint: async stage => { if (stage === 'planCleanupLocked' && once) { once = false; throw Error('synthetic cleanup pause'); } } });
  try {
    await f.repository.updateSettings('synthetic-cleanup', { theme: 'light' }); await flip(f); await flip(f);
    const writer = await f.transition.route(), jobId = id(); await assert.rejects(f.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }));
    const state = (await f.journal.read(f.runId)).value, pinned = state.frozen.legacy;
    const jobs = createRecordStore({ database: f.connection.targetDatabase, path: `profileWriterPlans/${encodeKey(f.runId)}/cleanupJobs` }), saved = await jobs.read(jobId);
    const collections = createRecordStore({ database: f.connection.targetDatabase, path: `profileWriterPlans/${encodeKey(f.runId)}/collections` }), context = (await collections.read(pinned.id)).value.context;
    await jobs.compareAndSet(jobId, saved.revision, { ...saved.value, items: [{ id: pinned.id, context }, ...saved.value.items.slice(1)] });
    await assert.rejects(f.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }), { code: 'WRITER_PLAN_CLEANUP_CONFLICT' }); await f.plans.verify(pinned);
    const current = await jobs.read(jobId); await jobs.compareAndSet(jobId, current.revision, saved.value);
    await f.transition.cleanupPlans(writer, { id: jobId, beforeEpoch: writer.epoch, writersDrained: true }); await f.plans.verify(pinned); await flip(f);
  } finally { await f.close(); }
});

test('native 제한 병합은 여러 페이지의 중복 참조와 기대값 우선순위·시각을 보존한다', async () => {
  const f = await setup();
  try {
    const stats = [], plans = createWriterPlanStore({ database: f.connection.targetDatabase, runId: f.runId, pageSize: 4,
      sortOptions: { maxEntries: 8, maxBytes: 2048, fanIn: 2, onStats: value => stats.push(value) } });
    const rows = Array.from({ length: 80 }, (_, n) => ({ key: `fs/users/synthetic-${String(n).padStart(3, '0')}`, exists: true, token: '0', value: { n, at: new Timestamp(123, 456), zero: -0 } })).reverse();
    const captureId = id(), transferId = id();
    const ref = await plans.collect(captureId, { transferId, backend: 'legacy', epoch: 1, role: 'sourceAudit', layout: 'a'.repeat(64) }, async cursor => {
      const from = cursor?.source ?? 0, slice = rows.slice(from, from + 10); return { entries: slice, done: from + 10 >= rows.length, cursor: from + 10 >= rows.length ? null : { source: from + 10, after: null } };
    });
    for (const n of [2, 30, 79]) { const key = `fs/users/synthetic-${String(n).padStart(3, '0')}`, prior = (await plans.expected(transferId, ref, key)).entry;
      await plans.checkpoint(transferId, ref, id(), { ...prior, token: '1', value: { ...prior.value, edited: true } }, prior); }
    const sealed = await plans.sealExpected(transferId, ref); assert.equal(sealed.count, 80); const edited = await plans.entry(sealed, 'fs/users/synthetic-030');
    assert.equal(edited.value.edited, true); assert.equal(edited.value.at.nanoseconds, 456); assert.equal(Object.is(edited.value.zero, -0), true);
    assert.ok(stats.every(value => value.maxBufferedEntries <= 8 && value.maxBufferedBytes <= 2048 && value.maxMergeReaders <= 2 && value.cleaned));
    assert.ok(stats.some(value => value.mergePasses > 1));
  } finally { await f.close(); }
});

test('계획 정리 CLI는 실제 SDK에서 읽기 전용 후보와 명시 적용을 구분하고 원문을 출력하지 않는다', async () => {
  const f = await setup();
  try {
    await f.repository.updateSettings('synthetic-private-profile', { theme: 'dark' }); await flip(f); await flip(f); const writer = await f.transition.route();
    const main = require('../../scripts/manage_user_writer.cjs').main, env = { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId };
    const output = [], errors = [], calls = [], runtime = { getProfileWriterBinding: () => f, closeProfileWriterRuntime: async () => calls.push('close') };
    const args = ['plan-cleanup', '--writer-emulator', '--backend', writer.backend, '--epoch', String(writer.epoch), '--before-epoch', String(writer.epoch), '--operation', id()];
    const dependencies = { env, createRuntime: () => runtime, stdout: value => output.push(value), stderr: value => errors.push(value) };
    assert.equal(await main(args, dependencies), 0); assert.equal(JSON.parse(output[0]).applied, false);
    assert.equal(await main([...args, '--apply', '--writers-drained'], dependencies), 0); assert.ok(JSON.parse(output[1]).removed > 0);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private-profile|theme/); assert.deepEqual(errors, []); assert.equal(calls.length, 2);
    assert.equal((await f.transition.route()).phase, 'accepting'); await flip(f);
  } finally { await f.close(); }
});

test('native 정리 후보의 25개 페이지와 작은 삭제 배치는 보호 자료를 누락하지 않고 끝까지 진행한다', async () => {
  const f = await setup();
  try {
    await f.repository.updateSettings('synthetic-cleanup-pages', { theme: 'dark' }); for (let n = 0; n < 6; n++) await flip(f);
    const root = f.connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(f.runId)}/collections`); assert.ok(Object.keys((await root.get()).val()).length > 25);
    const writer = await f.transition.route(), before = (await f.journal.read(f.runId)).value, all = await f.transition.previewPlanCleanup(writer, { beforeEpoch: writer.epoch, limit: 32 });
    let removed = 0, batches = 0;
    while (true) { const preview = await f.transition.previewPlanCleanup(writer, { beforeEpoch: writer.epoch, limit: 2 }); if (!preview.selected) break;
      const report = await f.transition.cleanupPlans(writer, { id: id(), beforeEpoch: writer.epoch, limit: 2, writersDrained: true }); assert.ok(report.removed <= 2); removed += report.removed; if (++batches > 32) assert.fail('배치 정리 무진행'); }
    assert.equal(removed, all.selected); for (const ref of Object.values(before.frozen)) await f.plans.verify(ref);
    assert.equal((await f.repository.read('synthetic-cleanup-pages')).value.settings.theme, 'dark'); await flip(f);
  } finally { await f.close(); }
});
