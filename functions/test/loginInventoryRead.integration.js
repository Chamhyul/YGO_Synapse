'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, call, response } = require('./commonWriterFixture.cjs');
const { encodeKey } = require('../services/user-storage/codec');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup({ empty = false } = {}) {
  const f = await fixture({ realAuthHelpers: true });
  try {
    const helpers = f.load('functions/utils/auth.js');
    f.mock('functions/utils/auth.js', { ...helpers, verifyAppCheck: async () => true });
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const route = await f.binding.transition.route();
    await f.binding.transition.copy(route); await f.binding.transition.drain(route); await f.binding.transition.activate(route);
    if (!empty) await f.binding.inventoryRepository.updateInventoryWithRetry(f.uid, inv => {
      inv.cards = { A: { name: '합성', cid: '101', items: [{ qty: 2, rarity: 'N', loc: '상자', illustration: '1' }] } };
      inv.amount = 2; inv.locations = { 상자: ['A'] }; inv.rarities = { N: 2 };
    });
    const handler = f.load('functions/routes/registration.js').getRegistrationStatus;
    const request = () => call(handler, { method: 'GET', query: { includeUserData: 'true' } });
    const initial = await request(); assert.equal(initial.body.initialData.success, true);
    if (!empty) await f.binding.rebuildInventoryReadSnapshot(f.uid);
    const repo = f.binding.inventoryRepository;
    return { ...f, repo, initial, request, handler,
      view: `inventoryReadSnapshots/${encodeKey(f.config.runId)}/${encodeKey(f.uid)}` };
  } catch (error) { await f.close(); throw error; }
}
function observe(database) {
  const original = database.ref, reads = [], writes = [];
  database.ref = path => {
    const ref = original(path);
    for (const [method, list] of [['get', reads], ['transaction', writes], ['set', writes], ['remove', writes]]) {
      const fn = ref[method].bind(ref); ref[method] = (...args) => { list.push(path); return fn(...args); };
    }
    return ref;
  };
  return { reads, writes, close() { database.ref = original; } };
}
test('실제 demo 통합 로그인은 계정 검사 중 보유 복사본을 읽고 인증 후 같은 전체 결과를 무쓰기로 반환한다', { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), account = gate(); let pending, o;
  const auth = f.binding.auth, get = auth.getUser, read = f.repo.readLoginInventory, prepared = f.repo.readPreparedInventory;
  try {
    const before = await f.binding.transition.inspect(); let first = true;
    auth.getUser = async uid => { if (first) { first = false; await account.promise; } return get(uid); };
    f.repo.readLoginInventory = (uid, authorize) => read(uid, () => { entered.resolve(); return authorize(); });
    f.repo.readPreparedInventory = () => assert.fail('적중 뒤 전체 보유 조회 반복 금지');
    o = observe(f.connection.targetDatabase); let done = false;
    pending = f.request().then(res => { done = true; return res; }); await entered.promise;
    assert.equal(done, false); assert.equal(o.writes.length, 0);
    account.resolve(); const result = await pending;
    assert.equal(result.statusCode, 200);
    for (const field of ['allCards', 'amount', 'locations', 'rarities', 'settings', 'sourceMembership', 'nickname', 'createdAt'])
      assert.deepEqual(result.body.initialData[field], f.initial.body.initialData[field], field);
    assert.equal(o.writes.length, 0); assert(!o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    assert.equal(o.reads.filter(path => path === f.view).length, 1);
    assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { account.resolve(); await pending?.catch(() => {}); o?.close(); auth.getUser = get;
    f.repo.readLoginInventory = read; f.repo.readPreparedInventory = prepared; await f.close(); }
});
for (const kind of ['disabled', 'revoked']) test(`실제 demo ${kind} 계정은 선행 읽기 결과를 버리고 DB·권한 쓰기를 하지 않는다`, { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), account = gate(); let pending, o;
  const auth = f.binding.auth, get = auth.getUser, read = f.repo.readLoginInventory;
  try {
    const before = await f.binding.transition.inspect(); let first = true;
    if (kind === 'revoked') auth.verifyIdToken = async () => ({ uid: f.uid, auth_time: 1 });
    auth.getUser = async uid => { if (first) { first = false; await account.promise; } return get(uid); };
    f.repo.readLoginInventory = (uid, authorize) => read(uid, () => { entered.resolve(); return authorize(); });
    o = observe(f.connection.targetDatabase); pending = f.request(); await entered.promise;
    if (kind === 'disabled') await f.connection.auth.updateUser(f.uid, { disabled: true });
    else await f.connection.auth.revokeRefreshTokens(f.uid);
    account.resolve(); const result = await pending;
    assert.equal(result.statusCode, 401); assert.equal(result.body.success, false); assert.equal(result.body.initialData, undefined);
    assert.equal(o.writes.length, 0); assert.deepEqual(await f.binding.transition.inspect(), before);
  } finally { account.resolve(); await pending?.catch(() => {}); o?.close(); auth.getUser = get; f.repo.readLoginInventory = read; await f.close(); }
});
for (const kind of ['missing', 'corrupt']) test(`선행 복사본 ${kind}는 무쓰기 미적중이고 인증 후 기존 전체 조회가 복구한다`, { timeout: 30000 }, async () => {
  const f = await setup(); let o;
  try {
    if (kind === 'missing') await f.connection.targetDatabase.ref(f.view).remove();
    else await f.connection.targetDatabase.ref(f.view).set({ format: 1, payload: '{' });
    o = observe(f.connection.targetDatabase);
    assert.equal(await f.repo.readLoginInventory(f.uid, async () => true), undefined);
    assert.equal(o.writes.length, 0); assert(!o.reads.some(path => path.startsWith('inventoryCardVersions/')));
    o.close(); o = undefined;
    const result = await f.request(); assert.equal(result.body.initialData.amount, 2);
    assert.deepEqual(result.body.initialData.allCards, f.initial.body.initialData.allCards);
  } finally { o?.close(); await f.close(); }
});
for (const kind of ['quantity', 'clear', 'drain']) test(`계정 검사 대기 중 ${kind} 변경은 이전 보유 snapshot을 최종 결과로 사용하지 않는다`, { timeout: 30000 }, async () => {
  const f = await setup(), entered = gate(), account = gate(); let pending;
  try {
    pending = f.repo.readLoginInventory(f.uid, async () => { entered.resolve(); return account.promise; });
    await entered.promise;
    if (kind === 'quantity') await f.repo.updateInventoryWithRetry(f.uid, inv => {
      inv.cards.A.items[0].qty = 8; inv.amount = 8; inv.rarities.N = 8;
    }, 3, { cardNumbers: ['A'] });
    else if (kind === 'clear') await f.repo.deleteInventory(f.uid);
    else await f.binding.transition.drain(await f.binding.transition.route());
    account.resolve(true);
    if (kind === 'drain') await assert.rejects(pending, { code: 'WRITER_FENCED' });
    else {
      const result = await pending;
      if (kind === 'quantity') { assert.equal(result, undefined); assert.equal((await f.repo.readPreparedInventory(f.uid)).value.amount, 8); }
      else assert.equal(result.value.amount, 0);
    }
  } finally { account.resolve(false); await pending?.catch(() => {}); await f.close(); }
});
test('부재 보유 읽기도 계정 검사 뒤 생성된 새 자료를 빈 목록으로 덮지 않는다', { timeout: 30000 }, async () => {
  const f = await setup({ empty: true }), entered = gate(), account = gate(); let pending;
  try {
    pending = f.repo.readLoginInventory(f.uid, async () => { entered.resolve(); return account.promise; }); await entered.promise;
    await f.repo.updateInventoryWithRetry(f.uid, inv => {
      inv.cards = { A: { name: '합성', cid: '101', items: [{ qty: 1, rarity: 'N', loc: '상자', illustration: '1' }] } };
      inv.amount = 1; inv.locations = { 상자: ['A'] }; inv.rarities = { N: 1 };
    });
    account.resolve(true); assert.equal(await pending, undefined);
    assert.equal((await f.repo.readPreparedInventory(f.uid)).value.amount, 1);
  } finally { account.resolve(false); await pending?.catch(() => {}); await f.close(); }
});


test('보유 선행 읽기와 멤버십 첫 결과는 권한 갱신 ACK를 기다리지 않고 기존 복구를 끝까지 회수한다', { timeout: 30000 }, async () => {
  const f = await setup(), first = gate(), release = gate(), writing = gate(); let pending;
  const auth = f.binding.auth, set = auth.setCustomUserClaims;
  try {
    await f.connection.auth.setCustomUserClaims(f.uid, {});
    auth.setCustomUserClaims = async (...args) => { writing.resolve(); await release.promise; return set(...args); };
    const res = response(), frames = [];
    res.write = line => { frames.push(JSON.parse(line)); first.resolve(); return true; };
    res.end = line => { if (line) frames.push(JSON.parse(line)); res.writableEnded = true; return res; };
    pending = f.handler({ method: 'GET', headers: { authorization: 'Bearer member' },
      query: { includeUserData: 'true', loginMembershipResult: 'true' } }, res);
    await first.promise; await writing.promise;
    assert.equal(frames[0].type, 'result'); assert.equal(frames[0].result.initialData.allCards.length, 1);
    assert.equal(frames[0].result.initialData.amount, 2); assert.equal(frames[0].result.initialData.membershipClaims.status, 'pending');
    assert.equal(res.writableEnded, undefined);
    release.resolve(); await pending;
    assert.equal(frames.at(-1).type, 'recorded'); assert.equal(frames.at(-1).success, true);
    assert.equal(frames.at(-1).result.membershipClaims.status, 'synced');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { release.resolve(); await pending?.catch(() => {}); auth.setCustomUserClaims = set; await f.close(); }
});
