'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { encodeKey } = require('../services/user-storage/codec');

test('제어 경로와 카드 버전 경로가 정규화 후 겹치면 I/O 전에 거부한다', () => {
  let calls = 0;
  const database = { ref() { calls++; throw new Error('DB에 접근하면 안 됨'); } };
  for (const partsPath of ['inventories', '/inventories', 'inventories/', 'inventories/cards']) {
    assert.throws(() => createPartitionedInventoryStore({ database, partsPath }), error =>
      ['USER_STORAGE_INVALID_CONFIG', 'USER_STORAGE_INVALID_PATH'].includes(error.code));
  }
  assert.throws(() => createPartitionedInventoryStore({ database, path: 'records/inventories', partsPath: 'records' }),
    { code: 'USER_STORAGE_INVALID_CONFIG' });
  assert.equal(calls, 0);
});

test('부분 조회·수정의 잘못된 선택과 초기화 revision은 DB 접근 전에 거부한다', async () => {
  let calls = 0;
  const store = createPartitionedInventoryStore({ database: { ref() { calls++; throw new Error('DB에 접근하면 안 됨'); } } });
  for (const numbers of [null, ['A', 3], new Array(2), new Array(1001).fill('A')]) {
    await assert.rejects(store.readCards('synthetic', numbers), { code: 'USER_STORAGE_INVALID_UPDATE' });
  }
  await assert.rejects(store.updateCards('synthetic', [], () => {}), { code: 'USER_STORAGE_INVALID_UPDATE' });
  await assert.rejects(store.clear('synthetic', -1), { code: 'USER_STORAGE_INVALID_REVISION' });
  assert.equal(calls, 0);
});

test('메타데이터 조회는 미래 저장 형식을 기존 형식으로 낮춰서 보고하지 않는다', async () => {
  const base = `inventories/${encodeKey('synthetic')}`;
  for (const type of ['inventory-parts', 'inventory', null]) {
    const fields = { revision: 1, format: 1, generation: 0, tombstone: false,
      'payload/type': type, 'payload/version': 2, 'payload/cards/count': 0 };
    const store = createPartitionedInventoryStore({ database: { ref(path) {
      assert.ok(path.startsWith(`${base}/`));
      return { async get() { return { val: () => fields[path.slice(base.length + 1)] ?? null }; } };
    } } });
    await assert.rejects(store.readMetadata('synthetic'), error =>
      ['USER_STORAGE_UNSUPPORTED_FORMAT', 'USER_STORAGE_INVALID_RECORD'].includes(error.code));
  }
});

test('계속 바뀌는 메타데이터는 혼합된 스냅샷 대신 제한된 재시도 후 충돌을 반환한다', async () => {
  let revision = 0;
  const store = createPartitionedInventoryStore({ maxAttempts: 2, database: { ref(path) {
    return { async get() { return { val: () => path.endsWith('/revision') ? ++revision : null }; } };
  } } });
  await assert.rejects(store.readMetadata('synthetic'), { code: 'USER_STORAGE_CONFLICT' });
  assert.equal(revision, 4);
});
