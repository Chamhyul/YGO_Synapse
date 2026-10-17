'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const timing = require('../services/inventoryRequestTiming');
const { fixture, call } = require('./commonWriterFixture.cjs');

test('실제 등록·제거 handler의 단계 로그는 API·저장·영수증과 역전환을 유지한다', async () => {
  const f = await fixture(), logs = [];
  try {
    f.mock('functions/services/inventoryRequestTiming.js', { ...timing,
      withInventoryRequestTiming: (name, handler) => timing.withInventoryRequestTiming(name, handler, { emit: line => logs.push(JSON.parse(line)) }) });
    f.mock('functions/services/inventoryCardLookup.js', { resolveCardNumber: async number => number });
    f.mock('functions/services/inventoryMigrationService.js', {
      ...require('../services/inventoryMigrationService'),
      resolveGroupCids: async groups => { for (const group of Object.values(groups)) group.cid = '100'; },
      inventoryMigrationStatus: () => ({ status: 'complete', pendingCount: 0, unresolvedCount: 0, retryAt: 0 }),
      prepareInventoryV2: async () => {},
    });
    await f.binding.transition.initialize(); await f.binding.repository.completeRegistration(f.uid, { terms: 'test', privacy: 'test' });
    let writer = await f.binding.transition.route();
    await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
    const routes = f.load('functions/routes/inventory.js');
    const add = await call(routes.addCards, { body: { rows: [['합성 카드', 'A', 'SR', 1, '합성 위치', '1', '100']] } });
    assert.equal(add.statusCode, 200); assert.equal(add.body.success, true); assert.equal(add.body.amount, 1);
    assert.equal(logs.length, 1);
    const remove = await call(routes.discardCards, { body: { discards: [{ cardNo: 'A', name: '합성 카드', rarity: 'SR', illustration: '1', loc: '합성 위치', qty: 1 }] } });
    assert.equal(remove.statusCode, 200); assert.equal(remove.body.success, true); assert.equal(remove.body.amount, 0);
    assert.equal(logs.length, 2);
    for (const row of logs) {
      assert.equal(row.status, 200); assert.equal(row.droppedSpans, 0);
      const names = new Set(row.spans.map(span => span.name));
      for (const name of ['storage.initialize', 'registration.profile_read', 'inventory.update', 'inventory.snapshot',
        'writer.prepare', 'writer.maintenance', 'writer.commit', 'writer.receipt', 'writer.complete', 'writer.receipt_final', 'record.transaction']) {
        assert(names.has(name), name);
      }
      assert.equal(names.has('writer.executing'), false, '새 명령은 준비와 실행 소유권을 같은 CAS로 확정한다');
      assert.equal(row.spans.filter(span => span.name === 'journal.cas').length, 2);
      assert(!JSON.stringify(row).includes(f.uid)); assert(!JSON.stringify(row).includes('합성 카드'));
    }
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    writer = await f.binding.transition.route();
    await f.binding.transition.copy(writer); await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
    assert.equal((await f.binding.transition.route()).backend, 'legacy');
    assert.equal((await f.binding.inventoryRepository.downloadInventory(f.uid)).data.amount, 0);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
