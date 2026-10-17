'use strict';

const { createRecordStore } = require('./recordStore');
const { inventoryPayloadCodec } = require('./inventoryCodec');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const failure = (code, message) => Object.assign(new Error(message), { code });

function validateInventory(value) {
  if (!plain(value) || (value.cards !== undefined && !plain(value.cards))) {
    throw failure('USER_STORAGE_INVALID_INVENTORY', '인벤토리 형식이 올바르지 않습니다. 원본을 보존합니다.');
  }
  const version = value.version === undefined ? 1 : Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1 || version > 3) {
    throw failure('USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION', '지원하지 않는 인벤토리 버전입니다. 원본을 보존합니다.');
  }
  return value;
}

function createInventoryStore({ prepare = async () => {}, now = () => new Date().toISOString(), ...options } = {}) {
  if (typeof prepare !== 'function' || typeof now !== 'function') throw failure('USER_STORAGE_INVALID_CONFIG', '인벤토리 준비 함수가 올바르지 않습니다.');
  const empty = () => ({ version: 3, updatedAt: now(), amount: 0, locations: {}, rarities: {}, cards: {} });
  const store = createRecordStore({ ...options, path: options.path ?? 'inventories',
    payloadCodec: inventoryPayloadCodec,
    retainOnDelete: state => ({ inventory: empty(), locationState: state?.locationState }),
  });
  // 위치 ID 사전은 내부 저장 상태다. 기존 호출자는 계속 문자열 loc와 집계를 받는다.
  const inventoryOf = record => ({ ...record, value: record.exists ? validateInventory(record.value.inventory) : empty() });
  return {
    async read(uid) { return inventoryOf(await store.read(uid)); },
    async update(uid, mutate, updateOptions) {
      if (typeof mutate !== 'function') throw failure('USER_STORAGE_INVALID_UPDATE', '인벤토리 변경 함수가 필요합니다.');
      const outcome = await store.update(uid, async (state, metadata) => {
        const inventory = metadata.exists ? validateInventory(state.inventory) : empty();
        await prepare(inventory, metadata);
        validateInventory(inventory);
        const result = await mutate(inventory, metadata);
        validateInventory(inventory);
        inventory.updatedAt = now();
        return { value: { inventory, locationState: state?.locationState }, result };
      }, updateOptions);
      return { ...outcome, record: inventoryOf(outcome.record) };
    },
    async clear(uid, expectedRevision) {
      const revision = expectedRevision ?? (await store.read(uid)).revision;
      const record = await store.delete(uid, revision);
      return { ...record, value: undefined };
    }
  };
}

module.exports = { createInventoryStore };
