'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const id = () => randomBytes(16).toString('hex');
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
function verification() {
  const startedAt = Date.now();
  return { nonceHash: id() + id(), startedAt, expiresAt: startedAt + 300000,
    consumed: false, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' };
}
async function setup(initializeMissing) {
  const runId = id(), connection = open(runId);
  const options = { db: connection.db, database: connection.targetDatabase, bucket: connection.bucket,
    FieldValue, runId, config: connection.config, migration };
  await createUserInventoryWriterBinding(options).initialize();
  const binding = createUserInventoryWriterBinding({ ...options, initializeMissing });
  await binding.initialize();
  return { ...binding, connection, close: () => connection.close() };
}
async function switchTo(binding) {
  const writer = await binding.transition.route();
  await binding.transition.copy(writer); await binding.transition.drain(writer);
  return binding.transition.activate(writer);
}

for (const initializeMissing of [false, true]) test(`공통 route 재사용은 initializeMissing:${initializeMissing}에서 요청 사이의 양방향 전환을 따른다`, async () => {
  const f = await setup(initializeMissing);
  try {
    await f.repository.completeRegistration('member', { terms: 't', privacy: 'p' });
    const original = f.transition.route; let routes = 0;
    f.transition.route = async () => { routes++; return original(); };
    const measured = async (action, expected) => {
      routes = 0; const value = await action();
      assert.equal(routes, expected, '같은 호출의 fresh route만 재사용한다'); return value;
    };
    let index = 0;
    for (const backend of ['legacy', 'rtdb', 'legacy']) {
      assert.equal((await original()).backend, backend);
      assert.equal((await measured(() => f.repository.read('member'), 2)).exists, true);
      assert.equal(await measured(() => f.repository.isRegistered('member'), 2), true);
      const theme = index % 2 ? 'light' : 'dark';
      await measured(() => f.repository.updateSettings('member', { theme }), 1);
      assert.equal((await f.repository.read('member')).value.settings.theme, theme);
      await measured(() => f.repository.completeRegistration(`new-${index}`, { terms: 't', privacy: 'p' }), 1);
      assert.equal((await measured(() => f.membership.read('member'), 2)).version, '0');
      const state = verification();
      assert.equal((await measured(() => f.membership.start(`nonce-${index}`, 'discord', state), 1)).nonceHash, state.nonceHash);
      const claimsId = await measured(() => f.claimsStorage.customClaims.acquire(`claims-${index}`), 1);
      assert.match(claimsId, /^[a-f0-9]{32}$/);
      await f.claimsStorage.customClaims.finish(`claims-${index}`, claimsId);
      assert.equal((await f.claimsStorage.customClaims.inspect(`claims-${index}`)).state, 'idle');
      if (index++ < 2) await switchTo(f);
    }
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

for (const initializeMissing of [false, true]) for (const reader of ['profile', 'membership']) {
  test(`${reader} 조회 initializeMissing:${initializeMissing}는 최종 epoch 변경 뒤 fresh route로 다시 읽는다`, async () => {
    const f = await setup(initializeMissing);
    try {
      await f.repository.updateSettings('member', { theme: 'dark' });
      const membership = { status: 'active', type: 'discord', levelName: '합성 회원',
        discordId: '123456789012345678', verificationVersion: 2, verificationProvider: 'discord', lastChecked: Date.now() };
      const original = f.transition.route; let routes = 0;
      const observed = async () => {
        routes++;
        if (routes === 2) {
          // 첫 snapshot을 읽은 뒤 독립 전환·후속 변경이 끝나는 경계를 재현한다.
          // 전환 작업 자체의 route는 측정에서 분리한다.
          f.transition.route = original;
          try { await switchTo(f); await f.repository.updateSettings('member', { theme: 'light', membership }); }
          finally { f.transition.route = observed; }
        }
        return original();
      };
      f.transition.route = observed;
      const saved = await (reader === 'profile' ? f.repository.read('member') : f.membership.read('member'));
      assert.equal(routes, 4, '첫 snapshot의 epoch 재검사와 새 시도의 before/after 조회를 유지한다');
      if (reader === 'profile') assert.equal(saved.value.settings.theme, 'light');
      else assert.deepEqual(saved.membership, membership);
      assert.equal((await original()).backend, 'rtdb');
    } finally { await f.close(); }
  });
}

for (const initializeMissing of [false, true]) test(`멤버십·claims initializeMissing:${initializeMissing}는 drain 중 부모 lease와 미확정 복구 장벽을 유지한다`, async () => {
  const f = await setup(initializeMissing); let writer, claimsId;
  try {
    const begin = f.transition.beginExternal, prepare = f.transition.prepare;
    f.transition.beginExternal = async (selected, externalId, resources, options) => {
      const parent = f.membership.writerLease();
      if (parent) { assert.equal(selected, parent.writer); assert.equal(options.parentId, parent.id); }
      return begin(selected, externalId, resources, options);
    };
    f.transition.prepare = async (selected, operationId, changes, result, options) => {
      const parent = f.membership.writerLease();
      assert.ok(parent); assert.equal(selected, parent.writer); assert.equal(options.parentExternal, parent.id);
      return prepare(selected, operationId, changes, result, options);
    };
    await f.membership.withVerification('member', 'discord', async () => {
      const parent = f.membership.writerLease(); writer = parent.writer;
      await f.transition.copy(writer); await f.transition.drain(writer);
      await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
      const state = verification();
      assert.equal((await f.membership.start('member', 'discord', state)).nonceHash, state.nonceHash);
      claimsId = await f.claimsStorage.customClaims.acquire('member');
      await f.claimsStorage.customClaims.finish('member', claimsId, true);
      assert.equal((await f.claimsStorage.customClaims.inspect('member')).state, 'uncertain');
      assert.equal((await f.transition.inspect()).externalUnresolved, 2);
    });
    f.transition.beginExternal = begin; f.transition.prepare = prepare;
    assert.equal((await f.transition.inspect()).externalUnresolved, 1);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    const recovered = await f.claimsStorage.customClaims.beginRecovery('member', claimsId, { writersDrained: true });
    await f.claimsStorage.customClaims.finish('member', recovered);
    assert.equal((await f.transition.inspect()).externalUnresolved, 0);
    await f.transition.activate(writer);
    assert.equal((await f.transition.route()).backend, 'rtdb');
    assert.equal((await f.claimsStorage.customClaims.inspect('member')).state, 'idle');
  } finally { await f.close(); }
});
