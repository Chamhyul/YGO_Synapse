'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withInitialWriterRoute, takeInitialWriterRoute } = require('../services/initialWriterRoute');
const { createProfileWriterBinding } = require('../services/userProfileWriterRepository');
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const selection = require('../services/userWriterSelection');
const { createApiWriterRepository } = require('../services/cardApiWriterRepository');
const { createAdminWriterRequests } = require('../services/adminWriterRequests');

function profileFixture() {
  const calls = { route: 0, profile: 0, inventory: 0, atomic: 0, prepare: 0, execute: 0 };
  let writer = { backend: 'rtdb', epoch: 1, phase: 'accepting' }, hook, atomicHook;
  const transition = {
    async route() { calls.route++; await hook?.(); return writer; },
    async prepareAndExecuteWithReceipt(...args) { calls.atomic++; const op = { id: args[1] }; args[4].onPrepared(op); await atomicHook?.(); return { result: null }; },
    async prepare() { calls.prepare++; return {}; }, async execute() { calls.execute++; },
  };
  let exists = true;
  const adapter = { async read() { calls.profile++; return { exists, token: exists ? '1' : '0', ...(exists ? { value: { Nickname: '합성' } } : {}) }; } };
  const binding = createProfileWriterBinding({ journal: {}, sharedTransition: transition, sharedStores: { rtdb: adapter, legacy: adapter },
    initializeMissing: false, inventoryExists: async () => { calls.inventory++; return false; } });
  return { binding, calls, transition, flip() { writer = { ...writer, epoch: writer.epoch + 1 }; },
    set hook(value) { hook = value; }, set atomicHook(value) { atomicHook = value; }, set exists(value) { exists = value; } };
}

test('진입 검사의 fresh route를 첫 업무 선택에만 전달하고 최종 확인·다음 조회는 유지한다', async () => {
  const f = profileFixture(), original = selection.selectProductionWriter;
  selection.selectProductionWriter = () => f.binding;
  try {
    const handler = withUserStorageRequestGuard(async () => {
      assert.equal(await f.binding.repository.isRegistered('synthetic'), true);
      assert.deepEqual(f.calls, { route: 2, profile: 2, inventory: 0, atomic: 0, prepare: 0, execute: 0 });
      await f.binding.repository.read('synthetic');
      assert.equal(f.calls.route, 4, '첫 업무 뒤에는 fresh before/after를 다시 읽는다');
    }, { env: { USER_PROFILE_WRITER_MODE: 'production' } });
    await handler({ method: 'GET' }, {});
    await f.binding.repository.read('synthetic'); assert.equal(f.calls.route, 6);
  } finally { selection.selectProductionWriter = original; }
});

test('공유한 최초 route 뒤 epoch가 바뀌면 새 시도의 before/after를 모두 확인한다', async () => {
  const f = profileFixture(), route = await f.binding.initialize();
  f.hook = () => { f.hook = null; f.flip(); };
  await withInitialWriterRoute(f.transition, route, () => f.binding.repository.read('synthetic'));
  assert.equal(f.calls.route, 4); assert.equal(f.calls.profile, 2);
});

test('병렬 요청·다른 binding·예외 뒤로 초기 route가 섞이거나 남지 않는다', async () => {
  const a = {}, b = {}; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = withInitialWriterRoute(a, { epoch: 1 }, async () => { await gate; assert.deepEqual(takeInitialWriterRoute(a), { epoch: 1 }); });
  await withInitialWriterRoute(a, { epoch: 2 }, async () => {
    assert.equal(takeInitialWriterRoute(b), undefined);
    assert.deepEqual(takeInitialWriterRoute(a), { epoch: 2 }); assert.equal(takeInitialWriterRoute(a), undefined);
  });
  release(); await first;
  await assert.rejects(withInitialWriterRoute(a, { epoch: 3 }, async () => { throw Error('합성'); }));
  assert.equal(takeInitialWriterRoute(a), undefined);
});

test('가입 생성은 잠금 뒤 인벤토리 재검사를 생략하는 통합 실행으로 바꾸지 않는다', async () => {
  const f = profileFixture(); f.exists = false;
  await f.binding.repository.completeRegistration('synthetic', { terms: 't', privacy: 'p' });
  assert.equal(f.calls.atomic, 0); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.execute, 1); assert.equal(f.calls.inventory, 2);
});

test('프로필 통합 준비 뒤 오류는 새 작업으로 재시도하지 않는다', async () => {
  const f = profileFixture(); f.atomicHook = () => { throw Object.assign(Error('합성'), { code: 'WRITER_RESOURCE_BUSY' }); };
  await assert.rejects(f.binding.repository.updateNickname('synthetic', '변경'), { code: 'WRITER_RESOURCE_BUSY' });
  assert.equal(f.calls.atomic, 1); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.execute, 0);
});

test('API 읽기는 요청마다 fresh route·잠금을 얻고 같은 요청의 동일 잠금은 확장하지 않는다', async () => {
  const calls = { route: 0, begin: 0, extend: 0, end: 0 }, writer = { backend: 'rtdb', epoch: 1 };
  const transition = { async route() { calls.route++; return writer; }, async beginExternal() { calls.begin++; },
    async addExternalResources() { calls.extend++; }, async endExternal() { calls.end++; } };
  const store = createApiWriterRepository({ transition, initialize: () => transition.route(), initializeMissing: false,
    adapters: { rtdb: { allowsPreflight: async () => true } } });
  await store.withRequest({}, async () => { await Promise.all([store.allowsPreflight('https://example.test'), store.allowsPreflight('https://example.test')]); });
  assert.deepEqual(calls, { route: 1, begin: 1, extend: 0, end: 1 });
  await store.allowsPreflight('https://example.test'); assert.deepEqual(calls, { route: 2, begin: 2, extend: 0, end: 2 });
});

test('관리자 계정 자원은 병렬 중복 요청에서도 한 번만 확장하고 다음 요청에는 다시 얻는다', async () => {
  const calls = { route: 0, begin: 0, extend: 0, end: 0 }, writer = { backend: 'rtdb', epoch: 1 };
  const transition = { async route() { calls.route++; return writer; }, async beginExternal() { calls.begin++; },
    async addExternalResources() { calls.extend++; }, async endExternal() { calls.end++; } };
  const store = createAdminWriterRequests({ transition, initialize: () => transition.route(), initializeMissing: false, database: { ref() {} } });
  for (let i = 0; i < 2; i++) await store.withRequest({}, () => Promise.all([store.reserveAccounts(['synthetic']), store.reserveAccounts(['synthetic'])]));
  assert.deepEqual(calls, { route: 2, begin: 2, extend: 2, end: 2 });
});
