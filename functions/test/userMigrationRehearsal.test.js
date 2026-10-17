'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserMigrationRehearsal, content } = require('../services/userMigrationRehearsal');
const { validate } = require('../../integration/user-migration/connection.cjs');
const { checkKey } = require('../../integration/user-migration/adapters.cjs');
const id = 'a'.repeat(32);
function fixture() {
  let revision = 0, run;
  const src = new Map([['profile/a', { key: 'profile/a', exists: true, token: '1', value: { name: '합성', null: null, settings: {} } }]]), dst = new Map(), receipts = new Map();
  let checkpoint, missingAck = false;
  const source = { snapshot: async () => structuredClone([...src.values()]),
    hasReceipt: async (key, runId, digest, token) => receipts.get(key)?.runId === runId && receipts.get(key).digest === digest && receipts.get(key).token === token,
    async write(entry, { runId, expected }) {
      const before = src.get(entry.key) || { exists: false, token: '0' };
      if (receipts.get(entry.key)?.digest === content(entry) && content(before) === content(entry)) return { token: before.token };
      if (before.token !== expected.token || content(before) !== content(expected)) throw Object.assign(new Error(), { code: 'MIGRATION_SOURCE_CHANGED' });
      const saved = { ...structuredClone(entry), token: `${Number(before.token) + 1}` }; src.set(entry.key, saved);
      receipts.set(entry.key, { runId, digest: content(entry), token: saved.token });
      if (missingAck) { missingAck = false; throw new Error('합성 응답 유실'); }
      return { token: saved.token };
    } };
  const target = { snapshot: async () => structuredClone([...dst.values()]), async write(entry) {
    const prior = dst.get(entry.key);
    if (prior && content(prior) !== content(entry)) throw Object.assign(new Error(), { code: 'MIGRATION_TARGET_CONFLICT' });
    dst.set(entry.key, { ...structuredClone(entry), token: '1' }); return { digest: content(entry) };
  } };
  const journal = { read: async () => ({ exists: !!run, revision, value: run }),
    async compareAndSet(_id, expected, value) {
      assert.equal(expected, revision); run = structuredClone(value); revision++;
      return { exists: true, revision, value: run };
    } };
  return { src, dst, receipts, set missingAck(v) { missingAck = v; }, set checkpoint(v) { checkpoint = v; },
    tool: createUserMigrationRehearsal({ source, target, journal, onCheckpoint: (...args) => checkpoint?.(...args) }) };
}
test('복사 중단 후 영수증으로 재개하고 전환 뒤 추가/변경을 롤백한다', async () => {
  const f = fixture(); f.checkpoint = () => { throw new Error('중단'); };
  await assert.rejects(f.tool.copy(id)); f.checkpoint = undefined;
  assert.equal((await f.tool.copy(id)).mismatches, 0); await f.tool.activate(id, { writersDrained: true });
  f.dst.set('profile/a', { key: 'profile/a', exists: true, token: '2', value: { name: '변경', settings: {} } });
  f.dst.set('profile/b', { key: 'profile/b', exists: true, token: '1', value: { name: '신규' } });
  assert.equal((await f.tool.rollback(id, { writersDrained: true })).phase, 'rolledBack');
  assert.equal(f.src.get('profile/a').value.name, '변경'); assert.equal(f.src.get('profile/b').value.name, '신규');
});
test('전환과 롤백은 기존 writer 종료 확인 없이 수행하지 않는다', async () => {
  const f = fixture(); await f.tool.copy(id);
  await assert.rejects(f.tool.activate(id), { code: 'MIGRATION_WRITERS_NOT_DRAINED' });
  await assert.rejects(f.tool.rollback(id), { code: 'MIGRATION_WRITERS_NOT_DRAINED' });
});
test('복사 중 원본 변경·기존 대상 충돌·정합성 손상은 전환을 막는다', async () => {
  const f = fixture(); f.checkpoint = () => { f.src.get('profile/a').token = '2'; };
  await assert.rejects(f.tool.copy(id), { code: 'MIGRATION_SOURCE_CHANGED' });
  const second = fixture(); second.dst.set('profile/a', { key: 'profile/a', exists: true, token: '1', value: { name: '별도 변경' } });
  await assert.rejects(second.tool.copy(id), { code: 'MIGRATION_TARGET_CONFLICT' });
  const third = fixture(); await third.tool.copy(id); third.dst.get('profile/a').value.name = '손상';
  await assert.rejects(third.tool.activate(id, { writersDrained: true }), { code: 'MIGRATION_COMPARE_FAILED' });
});
test('새 원본 변경은 롤백 전에 전부 대조하고 덮어쓰지 않는다', async () => {
  const f = fixture(); await f.tool.copy(id); await f.tool.activate(id, { writersDrained: true });
  f.src.get('profile/a').token = '2'; f.src.get('profile/a').value.name = '원본 새 변경';
  await assert.rejects(f.tool.rollback(id, { writersDrained: true }), { code: 'MIGRATION_SOURCE_CHANGED' });
  assert.equal(f.src.get('profile/a').value.name, '원본 새 변경');
});
test('롤백 응답 유실을 영수증으로 대조하고 재개하며 삭제도 보존한다', async () => {
  const f = fixture(); await f.tool.copy(id); await f.tool.activate(id, { writersDrained: true });
  f.dst.set('profile/a', { key: 'profile/a', exists: false, token: '2' }); f.missingAck = true;
  await assert.rejects(f.tool.rollback(id, { writersDrained: true }));
  assert.equal((await f.tool.rollback(id, { writersDrained: true })).mismatches, 0); assert.equal(f.src.get('profile/a').exists, false);
});
test('롤백 재개 중 새 대상 변경과 영수증 이후 원본 삭제를 성공으로 오인하지 않는다', async () => {
  for (const mode of ['target', 'source']) {
    const f = fixture(); await f.tool.copy(id); await f.tool.activate(id, { writersDrained: true });
    f.missingAck = true; await assert.rejects(f.tool.rollback(id, { writersDrained: true }));
    if (mode === 'target') f.dst.get('profile/a').token = '2';
    else f.src.set('profile/a', { key: 'profile/a', exists: false, token: '0' });
    await assert.rejects(f.tool.rollback(id, { writersDrained: true }), { code: mode === 'target' ? 'MIGRATION_TARGET_CHANGED' : 'MIGRATION_SOURCE_CHANGED' });
  }
});
test('누락·운영·서로 다른 에뮬레이터 호스트는 SDK 생성 전에 거부한다', () => {
  const env = { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'demo-user-migration',
    FIREBASE_DATABASE_EMULATOR_HOST: 'emulators:9000', USER_DATABASE_URL: 'http://emulators:9000?ns=demo-user-migration-default-rtdb',
    FIRESTORE_EMULATOR_HOST: 'emulators:8080', FIREBASE_STORAGE_EMULATOR_HOST: 'emulators:9199', FIREBASE_AUTH_EMULATOR_HOST: 'emulators:9099' };
  assert.equal(validate(env).projectId, 'demo-user-migration');
  for (const patch of [{ NODE_ENV: 'production' }, { FIREBASE_AUTH_EMULATOR_HOST: undefined }, { FIRESTORE_EMULATOR_HOST: 'outside.example:8080' }, { GOOGLE_APPLICATION_CREDENTIALS: 'private' }]) assert.throws(() => validate({ ...env, ...patch }));
});
test('이전 입력은 카드/시스템/다른 파일 경로를 변경하지 못하며 UID 원문을 보존한다', () => {
  checkKey('inventory/synthetic/a'); checkKey('fs/users/synthetic'); checkKey('fs/membership_csv_imports/synthetic/members/channel');
  for (const key of ['fs/cards/synthetic', 'fs/system/crawler', 'file/notice/notices.json', 'fs/users/a/unknown/path', 'inventory/']) {
    assert.throws(() => checkKey(key), { code: 'MIGRATION_INVALID_SNAPSHOT' });
  }
});
