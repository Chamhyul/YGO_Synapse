'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { encodeKey } = require('../services/user-storage/codec');
const id = () => randomBytes(16).toString('hex');
for (const provider of ['discord', 'youtube']) test(`${provider}: 실제 SDK는 이력 조회를 부모 CAS와 겹치고 같은 ID를 한 번만 읽으며 결과·전환·역전환을 보존한다`, async () => {
  const runId = id(), c = open(runId), events = [];
  const database = { ref(path) { const target = c.targetDatabase.ref(path); return new Proxy(target, { get(object, property) {
    const value = Reflect.get(object, property, object); if (typeof value !== 'function') return value;
    return (...args) => { if (['get', 'transaction'].includes(property)) events.push({ type: property, path }); return value.apply(object, args); };
  } }); } };
  const b = createUserInventoryWriterBinding({ db: c.db, database, bucket: c.bucket, FieldValue, runId, config: c.config,
    historyMaintenance: 'deferred', migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } });
  try {
    await b.initialize(); let writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
    const uid = id(), nonceHash = createHash('sha256').update(id()).digest('hex'), now = Date.now();
    await b.membership.start(uid, provider, { nonceHash, startedAt: now, expiresAt: now + 300000, consumed: false, localOnly: false,
      ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}) });
    let reserved; const prefetch = b.transition.withOperationHistoryPrefetch;
    b.transition.withOperationHistoryPrefetch = (ids, action) => { reserved = [...ids]; return prefetch(ids, action); };
    const value = { status: 'active', type: provider === 'discord' ? 'discord' : 'csv', levelName: 'synthetic',
      verificationVersion: 2, verificationProvider: provider, lastChecked: Date.now(),
      ...(provider === 'discord' ? { discordId: '123456789012345678' } : { userChannelId: 'UC' + 'a'.repeat(22) }) };
    events.length = 0;
    await b.membership.withVerification(uid, provider, async () => {
      await b.membership.consume(uid, provider, nonceHash);
      assert.equal((await b.membership.complete(uid, provider, nonceHash, value)).stored, true);
    });
    assert.equal(reserved.length, 2);
    const firstCas = events.findIndex(e => e.type === 'transaction' && e.path.startsWith('profileWriterTransitions/'));
    for (const operation of reserved) {
      const gets = events.map((e, i) => ({ ...e, i })).filter(e => e.type === 'get' && e.path.endsWith(`/operations/${encodeKey(operation)}`));
      assert.equal(gets.length, 1); assert(gets[0].i < firstCas);
    }
    assert.deepEqual((await b.membership.read(uid)).membership, value);
    await assert.rejects(b.membership.consume(uid, provider, nonceHash), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    assert.equal((await b.transition.inspect()).unresolved, 0);
    await b.transition.compact({ limit: 128 });
    writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
    assert.deepEqual((await b.membership.read(uid)).membership, value);
    writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
    assert.deepEqual((await b.membership.read(uid)).membership, value);
  } finally { await c.close(); }
});
