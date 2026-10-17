'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const ambiguousError = () => Object.assign(new Error('합성 저장 승인 응답 유실'), {
  code: 'USER_STORAGE_WRITE_AMBIGUOUS',
});

// 저장소 동작은 주입하고 공개 facade의 어댑터 사이 수명주기를 확인한다.
// 실제 SDK의 승인·취소 동작은 userStorage.integration.js에서 별도로 검사한다.
function fixture({ failInventoryConstruction = false, configured = false } = {}) {
  const state = { profileCalls: 0, inventoryCalls: 0, adminCalls: 0, apiCalls: 0, closeCount: 0 };
  const database = {};
  let closing;
  const connection = {
    config: { projectId: 'demo-user-storage' }, database,
    close() {
      if (!closing) { state.closeCount++; closing = Promise.resolve(); }
      return closing;
    },
  };
  state.profileUpdate = async () => ({ saved: true });
  state.inventoryRead = async () => ({ exists: true });
  state.adminTouch = async () => true;
  state.apiConsume = async () => ({ minuteRemaining: 1 });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/user-storage/index.js'), 'utf8'), {
    module,
    require(name) {
      if (name === '../../config/userStorage') return {
        createUserStorageConnection: () => { state.connectionMode = 'emulator'; return connection; },
        createConfiguredUserStorageConnection: () => { state.connectionMode = 'configured'; return connection; },
      };
      if (name === './profileStore') return { createProfileStore(options) {
        state.profileOptions = options;
        return {
          async update(...args) { state.profileCalls++; return state.profileUpdate(...args); },
        };
      } };
      if (name === './partitionedInventoryStore') return { createPartitionedInventoryStore(options) {
        state.inventoryOptions = options;
        if (failInventoryConstruction) throw new Error('합성 어댑터 생성 실패');
        return {
          async read(...args) { state.inventoryCalls++; return state.inventoryRead(...args); },
        };
      } };
      if (name === './adminSessionStore') return { createAdminSessionStore(options) {
        state.adminOptions = options;
        return { async touch(...args) { state.adminCalls++; return state.adminTouch(...args); } };
      } };
      if (name === './apiAccessStore') return { createApiAccessStore(options) {
        state.apiOptions = options;
        return { async consume(...args) { state.apiCalls++; return state.apiConsume(...args); } };
      } };
      if (['./membershipStore', './membershipCsvStore', './customClaimsStore'].includes(name)) {
        const factory = { './membershipStore': 'createMembershipStore', './membershipCsvStore': 'createMembershipCsvStore',
          './customClaimsStore': 'createCustomClaimsStore' }[name];
        return { [factory]: options => {
          state[name] = options;
          return { read: async () => ({}) };
        } };
      }
      throw new Error(`허용하지 않은 의존성: ${name}`);
    },
  }, { filename: 'user-storage/index.js' });
  return { state, create: configured ? module.exports.createConfiguredUserStorage : module.exports.createEmulatorUserStorage };
}

test('공통 facade도 네 어댑터 연결을 공유하고 저장 미확정 후 모두 차단한다', async () => {
  const { state, create } = fixture({ configured: true });
  const storage = create({ timeoutMs: 10, maxAttempts: 2 });
  assert.equal(state.connectionMode, 'configured');
  assert.equal(state.profileOptions.database, state.apiOptions.database);
  state.profileUpdate = async () => {
    await state.profileOptions.onAmbiguousWrite();
    throw ambiguousError();
  };
  await assert.rejects(storage.profile.update('synthetic', {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.inventory.read('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.adminSessions.touch('synthetic', 'synthetic', 1), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.apiAccess.consume('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(state.closeCount, 1);
});

test('프로필 저장 결과가 미확정이면 다른 어댑터의 진행 중 결과와 신규 호출을 함께 차단한다', async () => {
  const { state, create } = fixture();
  const storage = create({ timeoutMs: 25, maxAttempts: 2 });
  const readGate = deferred();
  state.inventoryRead = () => readGate.promise;
  const pendingRead = storage.inventory.read('synthetic-user');
  const rejectedRead = assert.rejects(pendingRead, { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  state.profileUpdate = async () => {
    const error = ambiguousError();
    await state.profileOptions.onAmbiguousWrite(error);
    throw error;
  };
  await assert.rejects(storage.profile.update('synthetic-user', { setting: true }), {
    code: 'USER_STORAGE_WRITE_AMBIGUOUS',
  });
  readGate.resolve({ exists: true, value: { amount: 7 } });
  await rejectedRead;
  await assert.rejects(storage.inventory.read('another-user'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.profile.update('another-user', {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.adminSessions.touch('synthetic-session', 'synthetic-user', 1), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.apiAccess.consume('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(state.apiCalls, 0);
  assert.equal(state.adminCalls, 0);
  assert.equal(state.inventoryCalls, 1);
  assert.equal(state.profileCalls, 1);
  assert.equal(state.closeCount, 1);
  assert.equal(state.inventoryOptions.database, state.profileOptions.database);
  assert.equal(state.adminOptions.database, state.profileOptions.database);
  assert.equal(state.apiOptions.database, state.profileOptions.database);
  await storage.close();
  // 수동 정리는 미확정 결과를 단순 종료나 롤백으로 바꾸지 않는다.
  await assert.rejects(storage.inventory.read('synthetic-user'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(state.closeCount, 1);
});

test('명시적 종료 뒤 완료된 저장을 성공으로 전달하지 않고 새 호출도 실행하지 않는다', async () => {
  const { state, create } = fixture();
  const storage = create();
  const gate = deferred();
  state.profileUpdate = () => gate.promise;
  const pending = storage.profile.update('synthetic-user', { nickname: '합성' });
  const rejected = assert.rejects(pending, { code: 'USER_STORAGE_CONNECTION_CLOSED' });
  const closing = storage.close();
  assert.equal(storage.close(), closing);
  await closing;
  gate.resolve({ saved: true });
  await rejected;
  await assert.rejects(storage.profile.update('synthetic-user', {}), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
  await assert.rejects(storage.inventory.read('synthetic-user'), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
  await assert.rejects(storage.adminSessions.touch('synthetic-session', 'synthetic-user', 1), { code: 'USER_STORAGE_CONNECTION_CLOSED' });
  assert.equal(state.profileCalls, 1);
  assert.equal(state.inventoryCalls, 0);
  assert.equal(state.closeCount, 1);
});

test('어댑터 생성 실패는 이미 생성된 전용 연결을 정리한다', () => {
  const { state, create } = fixture({ failInventoryConstruction: true });
  assert.throws(() => create(), /합성 어댑터 생성 실패/);
  assert.equal(state.closeCount, 1);
});

test('세션 활동 저장 미확정도 진행 중 프로필 응답과 후속 인벤토리·세션을 함께 차단한다', async () => {
  const { state, create } = fixture();
  const storage = create(), gate = deferred();
  state.profileUpdate = () => gate.promise;
  const pending = assert.rejects(storage.profile.update('synthetic-user', {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  state.adminTouch = async () => {
    const error = ambiguousError();
    await state.adminOptions.onAmbiguousWrite(error);
    throw error;
  };
  await assert.rejects(storage.adminSessions.touch('synthetic-session', 'synthetic-user', 1), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  gate.resolve({ saved: true });
  await pending;
  await assert.rejects(storage.inventory.read('synthetic-user'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.adminSessions.touch('synthetic-session', 'synthetic-user', 2), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(state.adminCalls, 1); assert.equal(state.inventoryCalls, 0); assert.equal(state.closeCount, 1);
});

test('API 사용량 저장 미확정은 진행 중 프로필과 후속 세션·인벤토리도 차단한다', async () => {
  const { state, create } = fixture(), storage = create(), gate = deferred();
  state.profileUpdate = () => gate.promise;
  const pending = assert.rejects(storage.profile.update('synthetic', {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  state.apiConsume = async () => {
    const error = ambiguousError();
    await state.apiOptions.onAmbiguousWrite(error);
    throw error;
  };
  await assert.rejects(storage.apiAccess.consume('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  gate.resolve({ saved: true }); await pending;
  await assert.rejects(storage.adminSessions.touch('synthetic', 'synthetic', 1), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  await assert.rejects(storage.inventory.read('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  assert.equal(state.apiCalls, 1); assert.equal(state.closeCount, 1);
});

test('멤버십·CSV·claims 어댑터도 동일 연결의 미확정 상태를 전파한다', async () => {
  for (const source of ['./membershipStore', './membershipCsvStore', './customClaimsStore']) {
    const { state, create } = fixture(), storage = create();
    assert.equal(state[source].database, state.profileOptions.database);
    await state[source].onAmbiguousWrite();
    for (const target of ['membership', 'membershipCsv', 'customClaims', 'inventory']) {
      await assert.rejects(storage[target].read('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
    }
    await assert.rejects(storage.profile.update('synthetic', {}), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
    assert.equal(state.closeCount, 1);
  }
});
