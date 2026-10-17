'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { getApps } = require('firebase-admin/app');
const { createUserStorageConnection } = require('../config/userStorage');
const { createPartitionedInventoryStore } = require('../services/user-storage/partitionedInventoryStore');
const { createInventoryStore } = require('../services/user-storage/inventoryStore');
const { createRecordStore } = require('../services/user-storage/recordStore');
const { encodeKey } = require('../services/user-storage/codec');

// 전용 demo RTDB 연결만 사용한다. 운영 Firebase 모듈·기존 dev 데이터에는 접근하지 않는다.
const connections = [];
function open() {
  const connection = createUserStorageConnection();
  connections.push(connection);
  return connection;
}
const main = open();
after(async () => { await Promise.all(connections.map(connection => connection.close())); });

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const headPath = uid => `inventories/${encodeKey(uid)}`;
const versionsPath = uid => `inventoryCardVersions/${encodeKey(uid)}`;
const operationsPath = uid => `inventoryOperations/${encodeKey(uid)}`;
const cardHash = number => `h${createHash('sha256').update(JSON.stringify(number)).digest('base64url')}`;
const rawHead = async uid => (await main.database.ref(headPath(uid)).get()).val();
async function operationRevisions(uid, { committed, cancelled }) {
  const operations = Object.values((await main.database.ref(operationsPath(uid)).get()).val() || {});
  assert.equal(operations.filter(operation => operation.state === 'committed').length, committed);
  assert.equal(operations.filter(operation => operation.state === 'cancelled').length, cancelled);
  assert.equal(operations.length, committed + cancelled, '대조되지 않은 중간 상태를 남기지 않는다');
  const revisions = operations.map(operation => operation.receipt.revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, Array.from({ length: committed + cancelled }, (_, index) => index + 1),
    '업무 확정과 취소 fence 각각이 한 번의 revision을 차지한다');
  return committed + cancelled;
}
const versionPath = (uid, head, number) => {
  const hash = cardHash(number);
  return `${versionsPath(uid)}/${hash}/${head.payload.cards[hash].v}`;
};
const store = (database = main.database, options = {}) => createPartitionedInventoryStore({
  database, now: () => '합성 고정 시각', ...options,
});
const card = (qty = 1, loc = '합성 위치') => ({
  name: '합성 카드', cid: null, items: [{ rarity: 'N', qty, loc, illustration: '1' }],
});
function summarize(value) {
  value.amount = 0;
  value.locations = {};
  value.rarities = {};
  for (const [number, entry] of Object.entries(value.cards || {})) {
    for (const item of entry.items || []) {
      value.amount += item.qty;
      Object.defineProperty(value.rarities, item.rarity, { value: (value.rarities[item.rarity] || 0) + item.qty,
        writable: true, enumerable: true, configurable: true });
      if (!own(value.locations, item.loc)) Object.defineProperty(value.locations, item.loc, {
        value: [], writable: true, enumerable: true, configurable: true,
      });
      if (!value.locations[item.loc].includes(number)) value.locations[item.loc].push(number);
    }
  }
}
async function seed(uid, cards = { A: card(), B: card() }) {
  return store().update(uid, value => { value.cards = cards; summarize(value); });
}

// SDK 메서드의 this와 on/off 콜백을 그대로 유지한다. 장애는 지정한 합성 경로의
// 요청/승인 응답 경계에만 주입하며 데이터베이스 전체를 가짜 구현으로 바꾸지 않는다.
function instrument(database, hook = (_event, invoke) => invoke()) {
  const events = [];
  const wrap = (ref, path) => new Proxy(ref, {
    get(target, key) {
      if (key === 'child') return child => wrap(target.child(child), [path, child].filter(Boolean).join('/'));
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['get', 'once', 'on', 'off', 'set', 'update', 'remove', 'transaction'].includes(key)) return value.bind(target);
      return (...args) => {
        const event = { method: key, path, args };
        events.push(event);
        return hook(event, () => value.apply(target, args));
      };
    },
  });
  return { events, database: new Proxy(database, {
    get(target, key) {
      if (key === 'ref') return (path = '') => wrap(target.ref(path), path.replace(/^\/|\/$/g, ''));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}
// 카드 제출과 폐쇄 표식 모두 transaction을 사용한다. 버전 경로의 순수
// callback이 null에서 제안하는 값으로 구분하여 정리 요청에 실패를 주입하지 않는다.
const isStage = (event, uid) => {
  if (!event.path.startsWith(`${versionsPath(uid)}/`) || !['set', 'transaction', 'update'].includes(event.method)) return false;
  const proposed = event.method === 'transaction' ? event.args[0](null) : event.args[0];
  return proposed != null && proposed.type !== 'inventory-stage-closed';
};
const isDelete = (event, uid) => event.path.startsWith(`${versionsPath(uid)}/`)
  && (event.method === 'remove' || (event.method === 'set' && event.args[0] === null));

test('분할 저장도 전체 조회·선택 조회·메타데이터의 기존 값과 빈 상태를 구분한다', { timeout: 20000 }, async () => {
  const uid = 'parts-shape-synthetic', instance = store();
  const empty = await instance.readMetadata(uid);
  assert.equal(empty.exists, false);
  assert.equal(empty.storageFormat, 'empty');
  assert.equal(empty.revision, 0);
  assert.deepEqual((await instance.readCards(uid, ['없음'])).value, {});
  const cards = {
    '番号.#/$[]😀': { ...card(2, '상자.#/$[]😀'), unknown: { empty: [], nullable: null } },
    EMPTY: { ...card(1, ''), name: '', items: [{ rarity: 'N', qty: 1, loc: '', illustration: '' }] },
  };
  const saved = await seed(uid, cards);
  const full = await instance.read(uid);
  assert.deepEqual(full.value, saved.record.value);
  assert.deepEqual(full.value.cards, cards);
  assert.equal(full.value.amount, 3);
  const selected = await instance.readCards(uid, ['番号.#/$[]😀', '없는 카드']);
  assert.equal(selected.scope, 'cards');
  assert.equal(selected.revision, full.revision);
  assert.deepEqual(selected.value, { '番号.#/$[]😀': cards['番号.#/$[]😀'] });
  const metadata = await instance.readMetadata(uid);
  assert.equal(metadata.storageFormat, 'parts');
  assert.equal(metadata.cardCount, 2);
  assert.equal(metadata.updatedAt, full.value.updatedAt);
  assert.equal(own(metadata, 'value'), false);
  const raw = await rawHead(uid);
  assert.equal(raw.payload.type, 'inventory-parts');
  assert.equal(raw.payload.cards.count, 2);
  assert.equal(own(raw.payload.header, 'cards'), false);
});

test('메타데이터·카드 부분 조회와 수정은 다른 카드 본문을 내려받거나 다시 쓰지 않는다', { timeout: 20000 }, async () => {
  const uid = 'parts-paths-synthetic';
  await seed(uid);
  const before = await rawHead(uid);
  const tracked = instrument(open().database), instance = store(tracked.database);
  await instance.readMetadata(uid);
  assert.equal(tracked.events.some(event => event.path.startsWith(versionsPath(uid))), false);
  assert.equal(tracked.events.some(event => event.path === headPath(uid) && ['get', 'on', 'once'].includes(event.method)), false);
  tracked.events.length = 0;
  assert.deepEqual((await instance.readCards(uid, ['A'])).value, { A: card() });
  assert.ok(tracked.events.some(event => event.method === 'get' && event.path === versionPath(uid, before, 'A')));
  assert.equal(tracked.events.some(event => event.path.includes(`/${cardHash('B')}/`)), false);
  const wholeNodes = [headPath(uid), `${headPath(uid)}/payload`, `${headPath(uid)}/payload/cards`,
    `${headPath(uid)}/payload/header`, `${headPath(uid)}/payload/header/locationNames`];
  assert.equal(tracked.events.some(event => wholeNodes.includes(event.path)
    && ['get', 'on', 'once'].includes(event.method)), false, '선택 조회는 manifest·카드 참조 목록·위치 사전 전체를 읽지 않는다');
  tracked.events.length = 0;
  const outcome = await instance.updateCards(uid, ['A'], cards => { cards.A.items[0].qty += 2; return '부분 성공'; });
  assert.equal(outcome.result, '부분 성공');
  assert.equal(outcome.record.scope, 'cards');
  assert.deepEqual(Object.keys(outcome.record.value), ['A']);
  assert.equal(tracked.events.some(event => event.path.includes(`/${cardHash('B')}/`)), false);
  assert.equal(tracked.events.some(event => event.path === versionsPath(uid)), false);
  const after = await rawHead(uid);
  assert.deepEqual(after.payload.cards[cardHash('B')], before.payload.cards[cardHash('B')]);
  assert.notEqual(after.payload.cards[cardHash('A')].v, before.payload.cards[cardHash('A')].v);
  assert.match(after.payload.cards[cardHash('A')].v, /^[a-f0-9]{32}$/);
  assert.equal((await store().read(uid)).value.amount, 4);
});

test('선택 조회는 요청 역순에도 원래 카드 순서와 null 원형을 유지하고 미래 논리 버전을 거부한다', { timeout: 20000 }, async () => {
  for (const nullPrototype of [false, true]) {
    const uid = `parts-selected-order-${nullPrototype}-synthetic`;
    const cards = nullPrototype ? Object.create(null) : {};
    cards.A = card(1, '첫 위치');
    cards.B = card(2, '둘째 위치');
    await seed(uid, cards);
    const tracked = instrument(open().database), instance = store(tracked.database);
    const selected = await instance.readCards(uid, ['B', 'A']);
    assert.deepEqual(Object.keys(selected.value), ['A', 'B']);
    assert.equal(Object.getPrototypeOf(selected.value), nullPrototype ? null : Object.prototype);
    assert.deepEqual(selected.value, cards);
    await main.database.ref(`${headPath(uid)}/payload/header/inventoryVersion`).set(4);
    const future = await rawHead(uid);
    tracked.events.length = 0;
    await assert.rejects(instance.readCards(uid, ['B', 'A']), { code: 'USER_STORAGE_UNSUPPORTED_INVENTORY_VERSION' });
    assert.equal(tracked.events.some(event => event.path.startsWith(`${versionsPath(uid)}/`)), false);
    assert.deepEqual(await rawHead(uid), future, '지원하지 않는 버전은 조회로 바꾸지 않는다');
    for (const headerChange of [{ type: 'unknown', version: 1 }, { type: 'inventory', version: 2 }]) {
      await main.database.ref(`${headPath(uid)}/payload/header`).update({ inventoryVersion: 3, ...headerChange });
      const unsupportedHeader = await rawHead(uid);
      tracked.events.length = 0;
      await assert.rejects(instance.readCards(uid, ['A']), { code: 'user-storage/invalid-inventory-format' });
      assert.equal(tracked.events.some(event => event.path.startsWith(`${versionsPath(uid)}/`)), false);
      assert.deepEqual(await rawHead(uid), unsupportedHeader, '미래/잘못된 헤더를 v1로 낮춰 읽지 않는다');
    }
  }
});

for (const sameCard of [true, false]) test(`전체 수정과 ${sameCard ? '같은' : '다른'} 카드 부분 수정의 동시 결과를 모두 보존한다`, { timeout: 20000 }, async () => {
  const uid = `parts-full-partial-${sameCard}-synthetic`;
  await seed(uid);
  const first = store(open().database), second = store(open().database);
  const gate = deferred();
  let entered = 0, fullCalls = 0, partialCalls = 0;
  async function rendezvous(firstAttempt) {
    if (!firstAttempt) return;
    if (++entered === 2) gate.resolve();
    await gate.promise;
  }
  const number = sameCard ? 'A' : 'B';
  const [full, partial] = await Promise.all([
    first.update(uid, async value => {
      await rendezvous(++fullCalls === 1);
      value.cards.A.items[0].qty += 1;
      summarize(value);
      return value.cards.A.items[0].qty;
    }),
    second.updateCards(uid, [number], async cards => {
      await rendezvous(++partialCalls === 1);
      cards[number].items[0].qty += 1;
      return cards[number].items[0].qty;
    }),
  ]);
  const final = await store().read(uid);
  assert.equal(final.revision, await operationRevisions(uid, { committed: 3, cancelled: fullCalls + partialCalls - 2 }));
  assert.equal(final.value.amount, 4);
  assert.equal(final.value.cards.A.items[0].qty, sameCard ? 3 : 2);
  assert.equal(final.value.cards.B.items[0].qty, sameCard ? 1 : 2);
  assert.ok(fullCalls + partialCalls >= 3, '충돌한 변경 함수는 최신 상태로 재실행되어야 한다');
  assert.equal(full.result, full.record.value.cards.A.items[0].qty);
  assert.equal(partial.result, partial.record.value[number].items[0].qty);
});

test('두 카드 변경은 두 버전 저장이 끝난 후 한 번에 공개되어 중간 수량이 보이지 않는다', { timeout: 20000 }, async () => {
  const uid = 'parts-atomic-move-synthetic';
  await seed(uid, { A: card(3), B: card(1) });
  const staged = deferred(), resume = deferred();
  let writes = 0;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (isStage(event, uid) && ++writes === 2) { staged.resolve(); await resume.promise; }
    return invoke();
  });
  const pending = store(tracked.database).updateCards(uid, ['A', 'B'], cards => {
    cards.A.items[0].qty -= 2;
    cards.B.items[0].qty += 2;
  });
  await staged.promise;
  try {
    const during = await store(open().database).read(uid);
    assert.deepEqual([during.value.cards.A.items[0].qty, during.value.cards.B.items[0].qty], [3, 1]);
    assert.equal(during.revision, 1);
  } finally { resume.resolve(); }
  await pending;
  const after = await store().read(uid);
  assert.deepEqual([after.value.cards.A.items[0].qty, after.value.cards.B.items[0].qty], [1, 3]);
  assert.equal(after.value.amount, 4);
  assert.equal(after.revision, 2);
});

test('독립 SDK의 서로 다른 위치 추가는 ID 충돌 없이 최신 사전을 함께 반영한다', { timeout: 20000 }, async () => {
  const uid = 'parts-location-race-synthetic';
  await seed(uid);
  const gate = deferred();
  let entered = 0;
  await Promise.all(['A', 'B'].map((number, index) => {
    let attempts = 0;
    return store(open().database).updateCards(uid, [number], async cards => {
      if (++attempts === 1) { if (++entered === 2) gate.resolve(); await gate.promise; }
      cards[number].items[0].loc = index === 0 ? '한글.#/상자' : '日本語😀[]$';
    });
  }));
  const head = await rawHead(uid), header = head.payload.header;
  assert.equal(header.nextLocationId, 4);
  assert.deepEqual(Object.keys(header.locationNames).sort(), ['l2', 'l3']);
  const ids = await Promise.all(['A', 'B'].map(async number => {
    const raw = (await main.database.ref(versionPath(uid, head, number)).get()).val();
    return raw.items.i0.loc;
  }));
  assert.deepEqual(ids.slice().sort(), [2, 3]);
  const final = await store().read(uid);
  assert.equal(final.value.cards.A.items[0].loc, '한글.#/상자');
  assert.equal(final.value.cards.B.items[0].loc, '日本語😀[]$');
});

test('카드 삭제·빈 위치 정리·전체 초기화 후에도 위치 ID를 재사용하지 않는다', { timeout: 20000 }, async () => {
  const uid = 'parts-location-clear-synthetic', instance = store();
  await seed(uid, { A: card(1, '첫 위치'), B: card(1, '남는 위치') });
  await instance.updateCards(uid, ['A'], cards => { delete cards.A; });
  let header = (await rawHead(uid)).payload.header;
  assert.deepEqual(header.locationNames, { l2: '남는 위치' });
  assert.equal(header.nextLocationId, 3);
  await instance.updateCards(uid, ['C'], cards => { cards.C = card(1, '새 위치'); });
  header = (await rawHead(uid)).payload.header;
  assert.deepEqual(header.locationNames, { l2: '남는 위치', l3: '새 위치' });
  assert.equal(header.nextLocationId, 4);
  await instance.clear(uid);
  const cleared = await instance.read(uid);
  assert.equal(cleared.exists, false);
  assert.equal(cleared.generation, 1);
  assert.deepEqual(cleared.value.cards, {});
  await instance.updateCards(uid, ['D'], cards => { cards.D = card(1, '초기화 뒤'); });
  header = (await rawHead(uid)).payload.header;
  assert.deepEqual(header.locationNames, { l4: '초기화 뒤' });
  assert.equal(header.nextLocationId, 5);
});

for (const partial of [false, true]) test(`초기화는 대기 중인 ${partial ? '부분' : '전체'} 수정의 과거 세대를 부활시키지 않는다`, { timeout: 20000 }, async () => {
  const uid = `parts-clear-race-${partial}-synthetic`;
  await seed(uid);
  const entered = deferred(), resume = deferred(), stale = store(open().database);
  const mutate = async value => {
    entered.resolve(); await resume.promise;
    (partial ? value : value.cards).A.items[0].qty += 10;
    if (!partial) summarize(value);
  };
  const pending = partial ? stale.updateCards(uid, ['A'], mutate) : stale.update(uid, mutate);
  const rejected = assert.rejects(pending, { code: 'USER_STORAGE_CONFLICT' });
  await entered.promise;
  let clearedHead;
  try { await store().clear(uid); clearedHead = await rawHead(uid); } finally { resume.resolve(); }
  await rejected;
  const final = await store().read(uid);
  assert.equal(final.exists, false);
  assert.equal(final.generation, 1);
  assert.equal(final.revision, await operationRevisions(uid, { committed: 2, cancelled: 1 }));
  assert.deepEqual(final.value.cards, {});
  const after = await rawHead(uid);
  assert.deepEqual(after.payload, clearedHead.payload, '취소 fence는 초기화된 데이터와 위치 ID를 바꾸지 않는다');
  assert.equal(after.tombstone, true);
});

test('generic·native 기존 형식은 읽기로 보존하고 전체 수정 후 부분 수정을 허용한다', { timeout: 25000 }, async () => {
  for (const format of ['generic', 'native']) {
    const uid = `parts-upgrade-${format}-synthetic`, instance = store();
    const value = { version: 3, updatedAt: '기존 시각', cards: { '番号/#': card(2, '') } };
    summarize(value);
    if (format === 'generic') await createRecordStore({ database: main.database, path: 'inventories' }).compareAndSet(uid, 0, value);
    else await createInventoryStore({ database: main.database, now: () => '기존 시각' }).update(uid, inventory => Object.assign(inventory, value));
    const before = await rawHead(uid);
    assert.deepEqual((await instance.read(uid)).value, value);
    assert.equal((await instance.readMetadata(uid)).storageFormat, 'legacy');
    const tracked = instrument(open().database), partial = store(tracked.database);
    await assert.rejects(partial.readCards(uid, ['番号/#']), { code: 'USER_STORAGE_PARTIAL_REQUIRES_UPGRADE' });
    await assert.rejects(partial.updateCards(uid, ['番号/#'], () => assert.fail('구형 부분 수정 실행 금지')), {
      code: 'USER_STORAGE_PARTIAL_REQUIRES_UPGRADE',
    });
    assert.equal(tracked.events.some(event => event.path === headPath(uid) && ['get', 'on', 'once'].includes(event.method)), false);
    assert.deepEqual(await rawHead(uid), before);
    await instance.update(uid, () => {});
    assert.equal((await instance.readMetadata(uid)).storageFormat, 'parts');
    await instance.updateCards(uid, ['番号/#'], cards => { cards['番号/#'].items[0].qty += 1; });
    assert.equal((await instance.read(uid)).value.amount, 3);
  }
});

test('과거 집계·카드 맵 부재·구버전의 호환 값은 전체 수정으로 보존하고 부분 수정을 거부한다', { timeout: 25000 }, async () => {
  for (const kind of ['summary', 'missing-cards', 'version']) {
    const uid = `parts-full-only-${kind}-synthetic`;
    const value = { version: 3, updatedAt: '합성 고정 시각', cards: { A: card() } };
    summarize(value);
    if (kind === 'summary') value.amount = 99;
    if (kind === 'missing-cards') { delete value.cards; value.amount = 0; value.locations = {}; value.rarities = {}; }
    if (kind === 'version') value.version = 2;
    await createRecordStore({ database: main.database, path: 'inventories' }).compareAndSet(uid, 0, value);
    const instance = store();
    const converted = await instance.update(uid, () => {});
    assert.deepEqual(converted.record.value, value);
    const before = await rawHead(uid);
    await assert.rejects(instance.updateCards(uid, ['A'], () => assert.fail('호환 값의 부분 수정 실행 금지')), {
      code: 'USER_STORAGE_PARTIAL_REQUIRES_FULL_UPDATE',
    });
    assert.deepEqual(await rawHead(uid), before);
    assert.deepEqual((await instance.update(uid, () => {})).record.value, value);
  }
});

test('두 번째 카드 버전 저장 실패는 취소 fence만 남기고 기존 전체 값을 보존한다', { timeout: 20000 }, async () => {
  const uid = 'parts-staging-failure-synthetic';
  await seed(uid);
  const before = await rawHead(uid);
  let writes = 0;
  const tracked = instrument(open().database, (event, invoke) => {
    if (isStage(event, uid) && ++writes === 2) return Promise.reject(Object.assign(new Error('합성 저장 실패'), { code: 'SYNTHETIC_STAGE_FAILURE' }));
    return invoke();
  });
  await assert.rejects(store(tracked.database).updateCards(uid, ['A', 'B'], cards => {
    cards.A.items[0].qty += 2; cards.B.items[0].qty += 2;
  }), { code: 'SYNTHETIC_STAGE_FAILURE' });
  assert.equal(writes, 2);
  const after = await rawHead(uid);
  assert.equal(after.revision, await operationRevisions(uid, { committed: 1, cancelled: 1 }));
  assert.equal(after.generation, before.generation);
  assert.equal(after.tombstone, before.tombstone);
  assert.deepEqual(after.payload, before.payload);
  assert.equal(after.commitReceipt.outcome, 'cancelled', '실패한 후보가 공개되지 않고 취소 증거만 남는다');
  const cancelled = await store().inspectOperation(uid, after.commitReceipt.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cleanup, 'fenced');
  assert.equal((await store().read(uid)).value.amount, 2);
});

test('버전 저장 뒤 head CAS 충돌은 최신 카드로 재시도하고 최종 시도의 결과만 반환한다', { timeout: 20000 }, async () => {
  const uid = 'parts-cas-conflict-synthetic';
  await seed(uid);
  const rival = store(open().database);
  let intercepted = false, calls = 0;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (!intercepted && event.path === headPath(uid) && event.method === 'transaction') {
      intercepted = true;
      await rival.updateCards(uid, ['A'], cards => { cards.A.items[0].qty += 5; });
    }
    return invoke();
  });
  const outcome = await store(tracked.database).updateCards(uid, ['A'], cards => {
    calls += 1; cards.A.items[0].qty += 2; return cards.A.items[0].qty;
  });
  assert.equal(intercepted, true);
  assert.equal(calls, 2);
  assert.equal(outcome.result, 8);
  assert.equal(outcome.record.revision, await operationRevisions(uid, { committed: 3, cancelled: 1 }));
  assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 8);
});

test('head를 읽은 독자의 구버전이 정리되면 새 head로 다시 읽고 세대가 섞인 값을 반환하지 않는다', { timeout: 20000 }, async () => {
  const uid = 'parts-reader-cleanup-race-synthetic';
  await seed(uid);
  const before = await rawHead(uid), oldPath = versionPath(uid, before, 'A');
  const entered = deferred(), resume = deferred();
  let blocked = false;
  const tracked = instrument(open().database, async (event, invoke) => {
    if (!blocked && event.method === 'get' && event.path === oldPath) {
      blocked = true; entered.resolve(); await resume.promise;
    }
    return invoke();
  });
  const pending = store(tracked.database).read(uid);
  await entered.promise;
  try {
    await store().updateCards(uid, ['A', 'B'], cards => { cards.A.items[0].qty = 2; cards.B.items[0].qty = 3; });
    // 정리의 시점을 결정적으로 만든다. 이미 지워진 동일 합성 구버전의 remove도 안전하다.
    await main.database.ref(oldPath).remove();
  } finally { resume.resolve(); }
  const result = await pending;
  assert.equal(result.revision, 2);
  assert.deepEqual([result.value.cards.A.items[0].qty, result.value.cards.B.items[0].qty], [2, 3]);
});

test('현재 head의 버전 누락·손상 위치 참조를 거부하고 원본 및 조회 범위를 보존한다', { timeout: 20000 }, async () => {
  const uid = 'parts-missing-version-synthetic';
  await seed(uid);
  const before = await rawHead(uid);
  await main.database.ref(versionPath(uid, before, 'A')).remove();
  const instance = store();
  const missingVersion = { code: 'USER_STORAGE_MISSING_CARD_VERSION' };
  await assert.rejects(instance.read(uid), missingVersion);
  await assert.rejects(instance.readCards(uid, ['A']), missingVersion);
  await assert.rejects(instance.updateCards(uid, ['A'], () => assert.fail('누락 버전의 변경 함수 실행 금지')), missingVersion);
  assert.deepEqual(await rawHead(uid), before);
  assert.deepEqual((await instance.readCards(uid, ['B'])).value, { B: card() });
  // RTDB에 저장 가능한 문자열로 위치 참조를 손상시킨다. 이를 위치 경로로
  // 해석하거나 선택 카드 본문을 읽기 전에 참조 형식 검증에서 거부해야 한다.
  await main.database.ref(`${headPath(uid)}/payload/cards/${cardHash('B')}/l`).set({ l1: '../../다른_합성_영역' });
  const broken = await rawHead(uid), tracked = instrument(open().database);
  await assert.rejects(store(tracked.database).readCards(uid, ['B']), { code: 'USER_STORAGE_INVALID_RECORD' });
  assert.equal(tracked.events.some(event => event.path.includes('/locationNames/')), false);
  assert.equal(tracked.events.some(event => event.path.startsWith(`${versionsPath(uid)}/`)), false);
  assert.ok(tracked.events.every(event => event.path.startsWith(`${headPath(uid)}/`)), '손상된 참조로 사용자 제어 영역 밖을 읽으면 안 된다');
  assert.deepEqual(await rawHead(uid), broken);
});

test('부분 수정이 선택 밖 카드를 추가하면 저장 전에 거부하고 원본을 보존한다', { timeout: 20000 }, async () => {
  const uid = 'parts-outside-scope-synthetic';
  await seed(uid);
  const before = await rawHead(uid), tracked = instrument(open().database);
  await assert.rejects(store(tracked.database).updateCards(uid, ['A'], cards => { cards.B = card(99); }), {
    code: 'USER_STORAGE_INVALID_UPDATE',
  });
  assert.equal(tracked.events.some(event => isStage(event, uid)), false);
  assert.deepEqual(await rawHead(uid), before);
});

test('head 승인 후 구버전 정리 실패는 성공 데이터를 유지하고 정리 필요 상태를 알린다', { timeout: 20000 }, async () => {
  const uid = 'parts-cleanup-failure-synthetic';
  await seed(uid);
  const before = await rawHead(uid);
  let failed = false;
  const tracked = instrument(open().database, (event, invoke) => {
    if (isDelete(event, uid)) {
      failed = true;
      return Promise.reject(Object.assign(new Error('합성 정리 실패'), { code: 'SYNTHETIC_CLEANUP_FAILURE' }));
    }
    return invoke();
  });
  const outcome = await store(tracked.database).updateCards(uid, ['A'], cards => { cards.A.items[0].qty = 3; });
  assert.equal(failed, true);
  assert.equal(outcome.cleanupPending, true);
  assert.equal(outcome.record.revision, 2);
  assert.equal((await store().read(uid)).value.cards.A.items[0].qty, 3);
  assert.notEqual((await main.database.ref(versionPath(uid, before, 'A')).get()).val(), null);
});

test('구버전 정리 승인 응답이 유실돼도 업무 저장은 성공하고 같은 연결로 다시 조회할 수 있다', { timeout: 20000 }, async () => {
  const uid = 'parts-cleanup-timeout-synthetic';
  await seed(uid);
  const before = await rawHead(uid);
  let removed = false, ambiguous = 0;
  const tracked = instrument(open().database, (event, invoke) => {
    if (isDelete(event, uid)) {
      return invoke().then(() => {
        removed = true;
        return new Promise(() => {});
      });
    }
    return invoke();
  });
  const instance = store(tracked.database, { timeoutMs: 500, onAmbiguousWrite: () => { ambiguous += 1; } });
  const outcome = await instance.updateCards(uid, ['A'], cards => {
    cards.A.items[0].qty = 3;
    return '저장 성공';
  });
  assert.equal(removed, true, '실제 구버전 삭제는 승인되고 응답만 유실된다');
  assert.equal(outcome.result, '저장 성공');
  assert.equal(outcome.cleanupPending, true);
  assert.equal(outcome.record.revision, 2);
  assert.equal(ambiguous, 0, '퇴역 버전 정리 지연은 업무 저장 연결을 차단하지 않는다');
  const readBack = await instance.read(uid);
  assert.equal(readBack.revision, 2);
  assert.equal(readBack.value.cards.A.items[0].qty, 3);
  assert.equal(readBack.value.amount, 4);
  assert.equal((await main.database.ref(versionPath(uid, before, 'A')).get()).val(), null);
});

test('버전 저장 승인 유실은 head를 제출하거나 미확정 버전을 정리하지 않는다', { timeout: 20000 }, async () => {
  const uid = 'parts-stage-timeout-synthetic';
  await seed(uid);
  const before = await rawHead(uid), connection = open();
  let stagedPath, ambiguous = 0;
  const tracked = instrument(connection.database, (event, invoke) => {
    if (isStage(event, uid) && !stagedPath) {
      stagedPath = event.path;
      return invoke().then(() => new Promise(() => {}));
    }
    return invoke();
  });
  const instance = store(tracked.database, { timeoutMs: 500, onAmbiguousWrite: () => { ambiguous += 1; return connection.close(); } });
  await assert.rejects(instance.updateCards(uid, ['A'], cards => { cards.A.items[0].qty = 4; }), {
    code: 'USER_STORAGE_WRITE_AMBIGUOUS',
  });
  assert.equal(ambiguous, 1);
  assert.equal(tracked.events.some(event => event.path === headPath(uid) && event.method === 'transaction'), false);
  assert.equal(tracked.events.some(event => isDelete(event, uid)), false);
  assert.deepEqual(await rawHead(uid), before);
  assert.notEqual((await main.database.ref(stagedPath).get()).val(), null);
  await assert.rejects(instance.readMetadata(uid), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
});

test('실제 head 승인 응답 유실은 성공으로 응답하지 않고 새 연결 대조 전까지 연결을 거부한다', { timeout: 20000 }, async () => {
  const uid = 'parts-ack-timeout-synthetic';
  await seed(uid);
  const connection = open();
  let acknowledged = false, ambiguous = 0;
  const tracked = instrument(connection.database, (event, invoke) => {
    if (event.path === headPath(uid) && event.method === 'transaction') {
      return invoke().then(result => {
        if (!result.committed) return result;
        acknowledged = true;
        return new Promise(() => {});
      });
    }
    return invoke();
  });
  const instance = store(tracked.database, { timeoutMs: 500, onAmbiguousWrite: () => { ambiguous += 1; return connection.close(); } });
  await assert.rejects(instance.updateCards(uid, ['A'], cards => { cards.A.items[0].qty = 3; }), {
    code: 'USER_STORAGE_WRITE_AMBIGUOUS',
  });
  assert.equal(acknowledged, true);
  assert.equal(ambiguous, 1);
  await assert.rejects(instance.read(uid), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
  const reconciled = await store(open().database).read(uid);
  assert.equal(reconciled.revision, 2);
  assert.equal(reconciled.value.cards.A.items[0].qty, 3);
  assert.equal(getApps().some(app => app.name === '[DEFAULT]'), false);
});
