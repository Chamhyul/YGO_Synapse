'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { checkKey } = require('../../integration/user-migration/adapters.cjs');
const { createWriterAdapters, createStorageCapture } = require('../../integration/user-migration/writer-adapters.cjs');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { createUserWriterTransition, createTransitionWriter } = require('../services/userWriterTransition');
const { content } = require('../services/userMigrationRehearsal');
const id = () => randomBytes(16).toString('hex');
const row = (key, value, token = '0') => ({ key, exists: value !== undefined, token, ...(value !== undefined ? { value } : {}) });
async function setup(options = {}, runId = id()) {
  const connection = open(runId), stores = createWriterAdapters(connection);
  const journal = createRecordStore({ database: connection.targetDatabase, path: 'writerJournal', maxAttempts: 10 });
  const tool = createUserWriterTransition({ journal, stores, runId, checkKey, ...options });
  return { runId, connection, stores, tool, close: () => connection.close() };
}
async function write(f, writer, key, value, operationId = id(), result = null) {
  const before = (await f.stores[writer.backend].snapshot()).find(item => item.key === key);
  return createTransitionWriter(f.tool, writer).write(operationId, [row(key, value, before?.token || '0')], result);
}
test('Firestore→RTDB 포착·재생·writer 전환과 역방향 전환에서 모든 논리 영역을 보존한다', async () => {
  let f, injected = false;
  f = await setup({ onCheckpoint: async stage => {
    if (stage === 'snapshotCaptured' && !injected) { injected = true; await write(f, old, 'fs/users/member', { Nickname: '복사 중 변경', settings: { theme: 'dark' } }); }
  } });
  const old = await f.tool.initialize();
  const rows = [
    row('fs/users/member', { registration: { completed: true }, settings: {}, when: new Timestamp(1700000000, 123000) }),
    row('inventory/member', { version: 3, locations: { 7: '상자.A' }, cards: [{ cid: null, quantities: [2, 3], rarities: ['★'] }] }),
    row('fs/discord_membership_verifications/nonceHash', { consumed: false, localOnly: true, expiresAt: 1700000050 }),
    row('fs/youtube_membership_verifications/nonceHash', { consumed: true, completed: { active: true } }),
    row('fs/AdminWebSessions/sessionHash', { uid: 'member', role: 'admin', lastActive: 1 }),
    row('fs/cardApiKeys/keyHash', { enabled: true, minute: 'unlimited', origins: ['https://synthetic.invalid'] }),
    row('fs/cardApiUsage/keyHash', { day: 4, month: 7 }), row('fs/cardApiConfig/current', { allowOrigins: [] }),
    row('fs/membership_csv_users/member', { tier: 'A' }), row('fs/membership_csv_state/current', { activeVersion: 'v1' }),
    row('fs/membership_csv_imports/v1', { status: 'completed' }), row('fs/membership_csv_imports/v1/members/member', { tier: 'A' }),
  ];
  try {
    for (const item of rows) await f.stores.legacy.seed(item);
    await f.tool.copy(old);
    await write(f, old, 'inventory/member', undefined);
    await write(f, old, 'inventory/member', { version: 3, locations: { 9: '새 상자' }, quantities: [5] });
    await write(f, old, 'fs/AdminWebSessions/sessionHash', undefined);
    await write(f, old, 'fs/cardApiUsage/keyHash', { day: 5, month: 8 });
    await f.tool.replay(old); await f.tool.drain(old); const active = await f.tool.activate(old);
    assert.equal(active.backend, 'rtdb');
    await assert.rejects(write(f, old, 'fs/users/member', {}), { code: 'WRITER_FENCED' });
    const response = { success: true, version: 3, inventory: { count: 9 } };
    assert.deepEqual(await write(f, active, 'inventory/member', { quantities: [9], locations: { 9: '새 상자' } }, id(), response), response);
    await write(f, active, 'fs/users/new', { registration: { completed: true, consent: { terms: 'test', acceptedAt: null } } });
    await write(f, active, 'fs/cardApiKeys/keyHash', { enabled: false });
    await write(f, active, 'fs/membership_csv_state/current', { activeVersion: 'v2' });
    await f.tool.copy(active); await f.tool.drain(active); const back = await f.tool.activate(active);
    assert.equal(back.backend, 'legacy'); assert.equal(back.epoch, 3);
    const source = await f.stores.legacy.snapshot(), destination = await f.stores.rtdb.snapshot();
    assert.deepEqual(source.map(content), destination.map(content));
    assert.equal(source.find(item => item.key.endsWith('sessionHash')).exists, false);
  } finally { await f.close(); }
});
test('Firestore 업무 transaction 승인 응답 유실을 새 SDK 연결의 영수증으로 복구한다', async () => {
  let f = await setup(); const writer = await f.tool.initialize(), operation = id(), original = f.stores.legacy.commit;
  f.stores.legacy.commit = async op => { await original(op); throw new Error('합성 응답 유실'); };
  try {
    await assert.rejects(write(f, writer, 'fs/users/member', { settings: { theme: 'dark' } }, operation));
    const runId = f.runId; await f.close(); f = await setup({}, runId);
    await f.tool.copy(writer); await f.tool.drain(writer);
    await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    await f.tool.recover(operation); await f.tool.recover(operation); await f.tool.activate(writer);
    assert.equal((await f.tool.inspect()).captured, 1);
  } finally { await f.close(); }
});
test('RTDB 업무 transaction+영수증 승인 유실을 복구하고 역방향 변경을 한 번만 재생한다', async () => {
  const f = await setup();
  try {
    const old = await f.tool.initialize(); await f.tool.copy(old); await f.tool.drain(old);
    const writer = await f.tool.activate(old), operation = id(), original = f.stores.rtdb.commit;
    f.stores.rtdb.commit = async op => { await original(op); throw new Error('합성 RTDB 응답 유실'); };
    await assert.rejects(write(f, writer, 'inventory/new', { quantities: [1] }, operation));
    await f.tool.recover(operation); await f.tool.copy(writer); await f.tool.drain(writer);
    await f.tool.activate(writer); assert.equal((await f.tool.inspect()).captured, 1);
    assert.deepEqual((await f.stores.legacy.snapshot())[0].value, { quantities: [1] });
  } finally { await f.close(); }
});
test('진행 중 지연 RPC·중복 실행과 drain 사이 경합에서 이전 writer를 유지한다', async () => {
  const f = await setup(); let release, started;
  const entered = new Promise(resolve => { started = resolve; }), original = f.stores.legacy.commit;
  f.stores.legacy.commit = async op => { started(); await new Promise(resolve => { release = resolve; }); return original(op); };
  try {
    const writer = await f.tool.initialize(), operation = id();
    const pending = write(f, writer, 'fs/users/member', { a: 1 }, operation); await entered;
    await f.tool.copy(writer); await f.tool.drain(writer);
    await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    await assert.rejects(f.tool.execute(writer, operation), { code: 'WRITER_OUTCOME_UNRESOLVED' });
    release(); await pending; await f.tool.activate(writer);
    assert.equal((await f.stores.rtdb.snapshot())[0].value.a, 1);
  } finally { release?.(); await f.close(); }
});
test('복수 SDK writer의 동일 자원 등록에서 하나만 승인하고 대상 CAS 변조를 차단한다', async () => {
  const f = await setup(), second = await setup({}, f.runId);
  try {
    const writer = await f.tool.initialize();
    const registrations = await Promise.allSettled([
      f.tool.prepare(writer, id(), [row('fs/users/member', { a: 1 })]),
      second.tool.prepare(writer, id(), [row('fs/users/member', { a: 2 })]),
    ]);
    assert.equal(registrations.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(registrations.find(result => result.status === 'rejected').reason.code, 'WRITER_RESOURCE_BUSY');
    const op = registrations.find(result => result.status === 'fulfilled').value;
    await f.tool.execute(writer, op.id); await f.tool.copy(writer); await f.tool.drain(writer);
    const target = (await f.stores.rtdb.snapshot())[0];
    await f.stores.rtdb.apply(id(), row(target.key, { external: true }, target.token), target);
    await assert.rejects(f.tool.activate(writer), { code: 'WRITER_DESTINATION_CHANGED' });
  } finally { await Promise.all([f.close(), second.close()]); }
});
test('재생 ACK 유실과 새 연결 재개에서 projection receipt로 중복/삭제 부활을 막는다', async () => {
  let f = await setup(); const writer = await f.tool.initialize(), original = f.stores.rtdb.apply;
  let failed = false;
  try {
    await write(f, writer, 'fs/users/member', { a: 1 });
    f.stores.rtdb.apply = async (...args) => { const saved = await original(...args); if (!failed) { failed = true; throw new Error('합성 재생 ACK 유실'); } return saved; };
    await assert.rejects(f.tool.copy(writer)); const runId = f.runId; await f.close(); f = await setup({}, runId);
    await f.tool.copy(writer); await write(f, writer, 'fs/users/member', undefined);
    await f.tool.replay(writer); await f.tool.replay(writer); await f.tool.drain(writer); await f.tool.activate(writer);
    assert.equal((await f.stores.rtdb.snapshot())[0].exists, false);
  } finally { await f.close(); }
});
test('Storage upload ACK 유실은 객체 generation+metadata 영수증으로 포착한다', async () => {
  const f = await setup(), selected = 'inventory/fileOnly', capture = createStorageCapture(f.connection, selected);
  f.stores.legacy = capture;
  const original = capture.commit; capture.commit = async op => { await original(op); throw new Error('합성 파일 응답 유실'); };
  try {
    const writer = await f.tool.initialize(), operation = id();
    await assert.rejects(write(f, writer, selected, { version: 3, locations: { 9: '상자' }, cards: [] }, operation));
    await f.tool.recover(operation); assert.equal((await f.tool.inspect()).captured, 1);
    assert.equal((await capture.snapshot())[0].value.version, 3);
  } finally { await f.close(); }
});
test('Storage 삭제와 영수증 사이 중단은 본문 부재로 성공을 추정하지 않고 전환을 막는다', async () => {
  const f = await setup(), selected = 'inventory/deleteGap', capture = createStorageCapture(f.connection, selected);
  f.stores.legacy = capture;
  try {
    const writer = await f.tool.initialize(); await write(f, writer, selected, { version: 3, cards: [] });
    const operation = id(); await assert.rejects(write(f, writer, selected, undefined, operation), { code: 'WRITER_STORAGE_DELETE_UNRESOLVED' });
    assert.deepEqual(await capture.snapshot(), []);
    await assert.rejects(f.tool.recover(operation), { code: 'WRITER_RECEIPT_REQUIRED' });
    await assert.rejects(f.tool.fenceUncommitted(operation), { code: 'WRITER_FENCE_UNSUPPORTED' });
    await f.tool.drain(writer); await assert.rejects(f.tool.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    assert.equal((await f.tool.inspect()).backend, 'legacy');
  } finally { await f.close(); }
});
test('Firestore 취소 fence와 늦은 SDK commit 경합에서 취소된 요청은 이전 저장소를 변경하지 않는다', async () => {
  const f = await setup(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), original = f.stores.legacy.commit;
  f.stores.legacy.commit = async op => { entered(); await new Promise(resolve => { release = resolve; }); return original(op); };
  try {
    const writer = await f.tool.initialize(), operation = id();
    const pending = write(f, writer, 'fs/users/member', { a: 1 }, operation); await ready;
    assert.deepEqual(await f.tool.fenceUncommitted(operation), { status: 'cancelled' });
    await f.tool.copy(writer); await f.tool.drain(writer); await f.tool.activate(writer);
    release(); await assert.rejects(pending, { code: 'WRITER_CANCELLED' });
    assert.deepEqual(await f.stores.legacy.snapshot(), []); assert.deepEqual(await f.stores.rtdb.snapshot(), []);
  } finally { release?.(); await f.close(); }
});
test('이미 반영된 RTDB 요청은 취소 fence를 요청해도 완료 영수증을 포착하여 보존한다', async () => {
  const f = await setup();
  try {
    const old = await f.tool.initialize(); await f.tool.copy(old); await f.tool.drain(old);
    const writer = await f.tool.activate(old), operation = id(), original = f.stores.rtdb.commit;
    f.stores.rtdb.commit = async op => { await original(op); throw new Error('합성 승인 유실'); };
    await assert.rejects(write(f, writer, 'fs/users/new', { settings: {} }, operation));
    assert.deepEqual(await f.tool.fenceUncommitted(operation), { status: 'completed' });
    assert.equal((await f.tool.inspect()).captured, 1); assert.equal((await f.stores.rtdb.snapshot())[0].exists, true);
  } finally { await f.close(); }
});
