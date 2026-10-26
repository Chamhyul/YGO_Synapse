'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const selection = require('../services/userWriterSelection');
const { newKey } = require('../services/cardApiAccess');
const { createMembershipCsvService } = require('../services/membershipCsvService');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };

for (const backend of ['legacy', 'rtdb']) test(`${backend} native 저장 결과·fresh route·중복 자원 재사용은 독립 reader와 복구 계약을 보존한다`, async () => {
  const runId = id(), connection = open(runId);
  const options = { db: connection.db, database: connection.targetDatabase, bucket: connection.bucket, FieldValue,
    runId, config: connection.config, migration, historyMaintenance: 'deferred' };
  const seed = createUserInventoryWriterBinding(options), originalSelector = selection.selectProductionWriter;
  try {
    await seed.initialize();
    if (backend === 'rtdb') {
      const writer = await seed.transition.route(); await seed.transition.copy(writer);
      await seed.transition.drain(writer); await seed.transition.activate(writer);
    }
    await seed.repository.updateSettings('synthetic', { theme: 'dark' });
    const key = newKey(); await seed.apiAccess.register(key, { label: '합성', origins: [], minuteLimit: 5, dayLimit: 20 });
    const lean = createUserInventoryWriterBinding({ ...options, initializeMissing: false });
    const route = lean.transition.route, receipt = lean.stores[backend].receipt;
    let routes = 0, receipts = 0;
    lean.transition.route = async () => { routes++; return route(); };
    lean.stores[backend].receipt = async (...args) => { receipts++; return receipt(...args); };
    lean.transition.prepare = async () => assert.fail('설정·API 저장에 별도 prepare를 반복하지 않는다');
    lean.transition.execute = async () => assert.fail('통합 실행 후 별도 execute를 반복하지 않는다');
    selection.selectProductionWriter = () => lean;
    await withUserStorageRequestGuard(async () => assert.equal(await lean.repository.isRegistered('synthetic'), true),
      { env: { USER_PROFILE_WRITER_MODE: 'production' } })({ method: 'GET' }, {});
    assert.equal(routes, 2, '진입 fresh 선택과 최종 epoch 확인만 수행한다');
    routes = 0;
    await lean.repository.updateSettings('synthetic', { theme: 'light' });
    assert.equal(routes, 1); assert.equal(receipts, backend === 'rtdb' ? 0 : 1);
    assert.equal((await seed.repository.read('synthetic')).value.settings.theme, 'light');
    routes = 0; receipts = 0;
    const extend = lean.transition.addExternalResources; let extensions = 0;
    lean.transition.addExternalResources = async (...args) => { extensions++; return extend(...args); };
    await lean.apiAccess.withRequest({}, async () => {
      await lean.apiAccess.authenticate(key.token);
      assert.equal((await lean.apiAccess.consume(key.token)).dayRemaining, 19);
      assert.equal((await lean.apiAccess.consume(key.token)).dayRemaining, 18);
    });
    assert.equal(routes, 1); assert.equal(extensions, 0); assert.equal(receipts, 0);
    const stored = await seed.apiAdapters[backend].read(`apiKey/${key.id}`);
    assert.equal(stored.value.usage.dayCount, 2);
    assert.equal((await lean.transition.inspect()).unresolved, 0);
    assert.equal((await lean.transition.inspect()).externalUnresolved, 0);
  } finally { selection.selectProductionWriter = originalSelector; await connection.close(); }
});

test('native CSV의 같은 요청은 이미 확보한 control·키 자원을 중복 확장하지 않는다', async () => {
  const runId = id(), connection = open(runId);
  const options = { db: connection.db, database: connection.targetDatabase, bucket: connection.bucket, FieldValue,
    runId, config: connection.config, migration, historyMaintenance: 'deferred' };
  try {
    const seed = createUserInventoryWriterBinding(options); await seed.initialize();
    const writer = await seed.transition.route(); await seed.transition.copy(writer);
    await seed.transition.drain(writer); await seed.transition.activate(writer);
    const lean = createUserInventoryWriterBinding({ ...options, initializeMissing: false });
    const service = createMembershipCsvService({ store: lean.membershipCsv });
    const members = [{ channelId: 'UC' + '1'.repeat(22), memberName: '합성', levelName: 'A' }];
    const request = { members, ...await service.preview({ members }), operationId: id() };
    const route = lean.transition.route, extend = lean.transition.addExternalResources, held = new Set(['csv/control']);
    let routes = 0;
    lean.transition.route = async () => { routes++; return route(); };
    lean.transition.addExternalResources = async (requestId, resources) => {
      for (const key of resources) assert(!held.has(key), '같은 요청에서 같은 자원을 다시 확장하지 않는다');
      const result = await extend(requestId, resources);
      for (const key of resources) held.add(key);
      return result;
    };
    await lean.membershipCsv.withRequest({}, async () => assert.equal((await service.apply(request, 'synthetic')).count, 1));
    assert.equal(routes, 1);
    assert.equal((await seed.membershipCsv.read()).members.length, 1);
    assert.equal((await lean.transition.inspect()).externalUnresolved, 0);
  } finally { await connection.close(); }
});

test('새 server-time의 SDK snapshot이 어긋나도 fresh 영수증과 역전환은 실제 저장 시각을 보존한다', async () => {
  const runId = id(), connection = open(runId);
  const options = { db: connection.db, database: connection.targetDatabase, bucket: connection.bucket, FieldValue,
    runId, config: connection.config, migration, historyMaintenance: 'deferred' };
  const uid = 'clock-synthetic'; let altered = 0;
  try {
    const binding = createUserInventoryWriterBinding(options); await binding.initialize();
    const initial = await binding.transition.route(); await binding.transition.copy(initial);
    await binding.transition.drain(initial); await binding.transition.activate(initial);
    const ref = connection.targetDatabase.ref;
    connection.targetDatabase.ref = path => {
      const target = ref(path);
      if (path !== `users/${encodeKey(uid)}`) return target;
      return new Proxy(target, { get(object, property) {
        if (property === 'transaction') return async (...args) => {
          const result = await object.transaction(...args);
          return { committed: result.committed, snapshot: { val() {
            const raw = structuredClone(result.snapshot.val());
            const shift = node => {
              if (!node || typeof node !== 'object') return;
              if (node.t === 'server-time' && typeof node.v === 'number') { node.v += 1000; altered++; }
              for (const value of Object.values(node)) shift(value);
            };
            shift(raw); return raw;
          } } };
        };
        const value = object[property]; return typeof value === 'function' ? value.bind(object) : value;
      } });
    };
    await binding.repository.completeRegistration(uid, { terms: 't', privacy: 'p' });
    await binding.repository.updateNickname(uid, '합성');
    assert(altered > 0, '실제 DB는 유지하고 SDK 반환 시각만 의도적으로 어긋나게 한다');
    const actual = (await binding.repository.read(uid)).value;
    const writer = await binding.transition.route(); await binding.transition.copy(writer);
    await binding.transition.drain(writer); await binding.transition.activate(writer);
    assert.deepEqual((await binding.repository.read(uid)).value, actual);
    assert.equal((await binding.transition.inspect()).unresolved, 0);
  } finally { await connection.close(); }
});
