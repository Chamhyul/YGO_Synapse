// 사용자가 실행할 수 있는 격리 검증 정의입니다. 운영 DB/Storage에 연결하지 않습니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const copy = value => JSON.parse(JSON.stringify(value));
function load(file, mocks) {
  const filename = path.join(__dirname, '..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, Date, Buffer,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw Error(`격리되지 않은 의존성: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}
const inventory = () => ({ version: 1, amount: 3, locations: { 선반: ['A'] }, rarities: { N: 3 },
  cards: { A: { name: '카드', items: [{ rarity: 'N', qty: 3, loc: '선반', illustration: '1' }] } } });
function fixture(resolver = async () => '123') {
  let saved = inventory();
  let generation = '9007199254740993';
  let conflicts = 0;
  let calls = 0;
  let onSave = null;
  const migration = load('services/inventoryMigrationService.js', {
    'node:timers': require('node:timers'),
    './cardQueryService': {
      resolveInventoryCid: async (...args) => { calls++; return resolver(...args); },
      mapLimited: async (values, fn) => { for (const value of values) await fn(value); },
      normalizeNumber: value => String(value).trim().toUpperCase(),
    },
    '../utils/common': { normalizeText: value => String(value || '').trim() },
  });
  const bucket = { file(name, options) { return {
    async getMetadata() { return [{ generation }]; },
    async download() {
      assert.equal(options.generation, generation);
      return [Buffer.from(JSON.stringify(saved))];
    },
    async save(body, options) {
      if (onSave) { const fn = onSave; onSave = null; fn(); }
      if (options.preconditionOpts.ifGenerationMatch !== generation) {
        conflicts++; throw Object.assign(Error('충돌'), { code: 412 });
      }
      saved = JSON.parse(body);
      generation = String(BigInt(generation) + 1n);
    },
  }; } };
  const storage = load('utils/inventoryStorage.js', {
    '../config/firebase': { admin: { storage: () => ({ bucket: () => bucket }) } },
    '../services/inventoryMigrationService': migration,
  });
  return { storage, migration, get saved() { return saved; }, set saved(value) { saved = value; },
    get calls() { return calls; }, get conflicts() { return conflicts; },
    concurrent(fn) { onSave = () => { fn(saved); generation = String(BigInt(generation) + 1n); }; } };
}

test('v1 로드 이관은 CID와 버전만 보완하고 수량·위치를 보존한다', async () => {
  const f = fixture();
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.version, 2);
  assert.equal(f.saved.cards.A.cid, '123');
  assert.deepEqual(f.saved.cards.A.items, inventory().cards.A.items);
  assert.equal(f.saved.amount, 3);
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.calls, 1);
});

test('미발견은 null로 보존하고 v2 재로드에서 매번 조회하지 않는다', async () => {
  const f = fixture(async () => null);
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.version, 2);
  assert.equal(f.saved.cards.A.cid, null);
  assert.equal(f.migration.inventoryMigrationStatus(f.saved).unresolvedCount, 1);
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.calls, 1);
});

test('일시 오류는 v1과 재시도 상태를 남긴다', async () => {
  const f = fixture(async () => { throw Error('DB 일시 오류'); });
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.version, 1);
  assert.equal(f.saved.cards.A.cid, undefined);
  assert.equal(f.migration.inventoryMigrationStatus(f.saved).status, 'retryableError');
  assert.equal(f.saved.amount, 3);
});

test('동시 수량 수정 충돌 후 최신 재고에 CID만 적용한다', async () => {
  const f = fixture();
  f.concurrent(data => { data.cards.A.items[0].qty = 7; data.amount = 7; });
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.cards.A.cid, '123');
  assert.equal(f.saved.cards.A.items[0].qty, 7);
  assert.equal(f.saved.amount, 7);
  assert.equal(f.conflicts, 1);
  assert.equal(f.calls, 1);
});

test('이관 중 삭제된 카드를 되살리지 않는다', async () => {
  const f = fixture();
  f.concurrent(data => { data.cards = {}; data.amount = 0; });
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.deepEqual(f.saved.cards, {});
  assert.equal(f.saved.amount, 0);
});

test('추가 재시도는 같은 수량을 두 번 적용하지 않는다', async () => {
  const f = fixture();
  const groups = { A: { name: '카드', cid: '123', items: [{ rarity: 'N', qty: 2, loc: '선반', illustration: '1' }] } };
  f.concurrent(data => { data.cards.A.items[0].qty = 4; data.amount = 4; });
  await f.storage.updateInventoryWithRetry('user', data => f.storage.processAddCards(data, groups));
  assert.equal(f.saved.cards.A.items[0].qty, 6);
  assert.equal(f.saved.amount, 6);
  assert.equal(groups.A.items[0].qty, 2);
});

test('큰 인벤토리는 진행을 저장하고 다음 로드에서 이어간다', async () => {
  const f = fixture();
  f.saved = { ...inventory(), cards: Object.fromEntries(Array.from({ length: 45 }, (_, i) =>
    [String(i), copy(inventory().cards.A)])) };
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.version, 1);
  assert.equal(f.migration.inventoryMigrationStatus(f.saved).pendingCount, 5);
  await f.storage.updateInventoryWithRetry('user', () => {});
  assert.equal(f.saved.version, 2);
  assert.equal(f.calls, 45);
});
