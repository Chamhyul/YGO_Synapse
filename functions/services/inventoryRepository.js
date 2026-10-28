'use strict';

// 기존 HTTP 계약을 저장 어댑터에 연결한다. 기본 Storage 경로와 달리 이
// 진입점은 config/userStorage의 test/demo 에뮬레이터 검증을 통과해야 한다.
const migrationStatusKey = Symbol.for('ygo.inventory.apiMigrationStatus');
const fullRequiredCodes = new Set([
  'USER_STORAGE_PARTIAL_REQUIRES_UPGRADE',
  'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE',
]);

function createRtdbInventoryRepository({ storage, migration } = {}) {
  if (!storage?.inventory || !migration?.prepareInventoryV2 || !migration?.inventoryMigrationStatus) {
    throw Object.assign(new Error('인벤토리 저장소와 변환 구현이 필요합니다.'), { code: 'USER_STORAGE_INVALID_CONFIG' });
  }
  const store = storage.inventory;
  async function updateFull(uid, mutate, maxRetries, expectedGeneration) {
    const memo = new Map();
    return store.update(uid, async inventory => {
      await migration.prepareInventoryV2(inventory, memo);
      await mutate(inventory);
      inventory.version = migration.inventoryMigrationStatus(inventory).status === 'complete' ? 3 : 1;
    }, { maxAttempts: maxRetries, skipUnchanged: true, expectedGeneration });
  }
  return {
    // 조회/이관과 같은 실행이 확인한 원본 revision을 반환한다. 나중에 읽은
    // 메타정보를 이전 본문과 조합해 조건부 조회 토큰을 만들지 않는다.
    async readPreparedInventory(uid, options) { return store.readPrepared ? store.readPrepared(uid, options) : undefined; },
    async readInventorySnapshot(uid) {
      const prepared = store.readPrepared ? await store.readPrepared(uid) : undefined;
      return prepared || (await updateFull(uid, () => {}, 3)).record;
    },
    async downloadInventory(uid) {
      const record = await store.read(uid);
      return { data: record.value, generation: String(record.revision) };
    },
    async updateInventoryWithRetry(uid, mutate, maxRetries = 3, options = {}) {
      let expectedGeneration;
      const input = options.cardNumbers;
      // 기존 API의 대량/빈 요청은 전체 호환 경로로 처리한다. 부분 경로의
      // 1,000개 한도를 기존 API 입력의 새 제한으로 노출하지 않는다.
      const numbers = Array.isArray(input) && input.every(number => typeof number === 'string')
        ? [...new Set(input)] : null;
      if (numbers?.length && numbers.length <= 1000) {
        try {
          const saved = await store.updateApiCards(uid, numbers, mutate, { maxAttempts: maxRetries });
          const value = saved.record.value;
          Object.defineProperty(value, migrationStatusKey, { value: saved.inventoryMigration });
          // cleanupPending은 이미 성공한 변경이다. 저장을 재실행하지 않는다.
          return value;
        } catch (error) {
          if (!fullRequiredCodes.has(error.code)) throw error;
          if (!Number.isSafeInteger(error.generation) || error.generation < 0) throw error;
          expectedGeneration = error.generation;
        }
      }
      const saved = await updateFull(uid, mutate, maxRetries, expectedGeneration);
      return saved.record.value;
    },
    async deleteInventory(uid) { await store.clear(uid); },
  };
}

let runtime;
function getRtdbInventoryRepository() {
  // 캐시가 있어도 매 호출 설정을 재검증한다. 잘못된 설정에서 기존 Storage로
  // 대체하거나 종료/저장 미확정 연결을 자동으로 재생성하지 않는다.
  const storage = require('./userStorageRuntime').getRtdbUserStorage();
  if (runtime) {
    return runtime.repository;
  }
  const migration = require('./inventoryMigrationService');
  runtime = { repository: createRtdbInventoryRepository({ storage, migration }) };
  return runtime.repository;
}

async function closeRtdbInventoryRepository() {
  // 시험 프로세스 종료용. 이미 미확정인 업무를 자동 재요청하지 않는다.
  await require('./userStorageRuntime').closeRtdbUserStorage();
}

module.exports = { createRtdbInventoryRepository, getRtdbInventoryRepository, closeRtdbInventoryRepository };
