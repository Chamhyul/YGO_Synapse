'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRtdbInventoryRepository } = require('../services/inventoryRepository');

const status = { status: 'complete', pendingCount: 0, unresolvedCount: 2, retryAt: 0 };
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ ...status }) };
const error = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

test('부분 처리 불가일 때만 관측한 초기화 세대를 전체 처리로 전달한다', async () => {
  let partialCalls = 0, fullCalls = 0, callbacks = 0;
  const storage = { inventory: {
    async updateApiCards() { partialCalls++; throw error('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE', { generation: 7 }); },
    async update(uid, mutate, options) {
      fullCalls++;
      assert.equal(uid, 'synthetic');
      assert.deepEqual(options, { maxAttempts: 2, skipUnchanged: true, expectedGeneration: 7 });
      const value = { version: 3, cards: {} };
      await mutate(value);
      return { record: { value } };
    },
  } };
  const repository = createRtdbInventoryRepository({ storage, migration });
  const value = await repository.updateInventoryWithRetry('synthetic', value => { callbacks++; value.amount = 3; }, 2, { cardNumbers: ['A'] });
  assert.equal(value.amount, 3);
  assert.deepEqual([partialCalls, fullCalls, callbacks], [1, 1, 1]);
});

test('초기화 세대를 제공하지 않은 부분 오류와 미확정 저장은 전체 쓰기로 재실행하지 않는다', async () => {
  for (const thrown of [error('USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE'),
    error('USER_STORAGE_WRITE_AMBIGUOUS', { generation: 0 }), error('USER_STORAGE_CONFLICT', { generation: 0 })]) {
    let fullCalls = 0;
    const repository = createRtdbInventoryRepository({ migration, storage: { inventory: {
      async updateApiCards() { throw thrown; },
      async update() { fullCalls++; },
    } } });
    await assert.rejects(repository.updateInventoryWithRetry('synthetic', () => {}, 3, { cardNumbers: ['A'] }), thrown);
    assert.equal(fullCalls, 0);
  }
});

test('정리 보류는 성공이며 전역 CID 요약이 부분 카드의 상태로 축소되지 않는다', async () => {
  let fullCalls = 0;
  const value = { version: 3, cards: { A: { cid: '123', items: [] } }, amount: 5 };
  const repository = createRtdbInventoryRepository({ migration, storage: { inventory: {
    async updateApiCards() { return { record: { value }, inventoryMigration: status, cleanupPending: true }; },
    async update() { fullCalls++; },
  } } });
  const result = await repository.updateInventoryWithRetry('synthetic', () => {}, 3, { cardNumbers: ['A'] });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/inventoryMigrationService.js'), 'utf8'), {
    module, exports: module.exports, require(name) {
      if (name === 'node:timers') return require(name);
      if (name === './inventoryCardLookup') return {};
      if (name === '../utils/common') return {};
      throw Error(name);
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(module.exports.inventoryMigrationStatus(result))), status);
  assert.equal(fullCalls, 0);
  assert.equal(JSON.stringify(result).includes('unresolvedCount'), false);
});

test('부분 한도를 넘는 기존 요청은 잘라내지 않고 전체 호환 경로로 처리한다', async () => {
  let partialCalls = 0, fullCalls = 0;
  const repository = createRtdbInventoryRepository({ migration, storage: { inventory: {
    async updateApiCards() { partialCalls++; },
    async update(uid, mutate) { fullCalls++; const value = { cards: {} }; await mutate(value); return { record: { value } }; },
  } } });
  await repository.updateInventoryWithRetry('synthetic', () => {}, 3,
    { cardNumbers: Array.from({ length: 1001 }, (_, index) => `A-${index}`) });
  assert.deepEqual([partialCalls, fullCalls], [0, 1]);
});

function loadFacade(backend, getRepository) {
  let storageAccess = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/inventoryStorage.js'), 'utf8'), {
    module, exports: module.exports, process: { env: { USER_STORAGE_BACKEND: backend } },
    require(name) {
      if (name === '../config/firebase') return { admin: { storage() { storageAccess++; throw Error('Storage 접근 금지'); } } };
      if (name === '../services/inventoryRepository') return { getRtdbInventoryRepository: getRepository };
      throw Error(name);
    },
  });
  return { facade: module.exports, storageAccess: () => storageAccess };
}

test('RTDB 설정 오류·연결 실패에서 기존 Storage로 대체하지 않는다', async () => {
  for (const backend of ['invalid', 'rtdb']) {
    const { facade, storageAccess } = loadFacade(backend, () => { throw error('USER_STORAGE_CONFIG_INVALID'); });
    for (const call of [() => facade.downloadInventory('synthetic'),
      () => facade.updateInventoryWithRetry('synthetic', () => {}), () => facade.deleteInventory('synthetic')]) {
      await assert.rejects(call(), { code: 'USER_STORAGE_CONFIG_INVALID' });
    }
    assert.equal(storageAccess(), 0);
  }
});

test('실제 런타임 진입점은 운영 프로젝트 설정을 SDK 생성 전에 거부한다', () => {
  const { getRtdbInventoryRepository } = require('../services/inventoryRepository');
  const keys = ['NODE_ENV', 'USER_STORAGE_BACKEND', 'GCLOUD_PROJECT'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { NODE_ENV: 'test', USER_STORAGE_BACKEND: 'rtdb', GCLOUD_PROJECT: 'production-example' });
    assert.throws(getRtdbInventoryRepository, { code: 'USER_STORAGE_CONFIG_INVALID' });
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});
