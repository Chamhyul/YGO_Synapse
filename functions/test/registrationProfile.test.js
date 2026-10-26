'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProfileWriterBinding } = require('../services/userProfileWriterRepository');
function fixture({ exists = true, inventory = false } = {}) {
  let reads = 0, routes = 0;
  const state = { epoch: 1, backend: 'rtdb', token: '1', exists, inventory };
  const transition = { async route() {
    routes++; await state.onRoute?.(routes);
    return { backend: state.backend, epoch: state.epoch, phase: 'accepting' };
  } };
  const stores = Object.fromEntries(['legacy', 'rtdb'].map(backend => [backend, { async read(key) {
    reads++; await state.onRead?.(reads, key);
    return { exists: state.exists, token: state.token,
      value: state.exists ? { Nickname: `${backend}-${state.token}` } : undefined };
  } }]));
  const binding = createProfileWriterBinding({ sharedTransition: transition, sharedStores: stores, journal: {},
    initializeMissing: false, inventoryExists: async () => state.inventory });
  return { state, repo: binding.repository, counts: () => ({ reads, routes }) };
}
test('가입과 본문이 하나의 검증된 snapshot이며 기존 boolean 계약도 보존한다', async () => {
  const f = fixture(), result = await f.repo.readRegistrationProfile('synthetic');
  assert.equal(result.registered, true); assert.equal(result.profile.value.Nickname, 'rtdb-1');
  assert.deepEqual(f.counts(), { reads: 2, routes: 2 });
  assert.equal(await f.repo.isRegistered('synthetic'), true);
  assert.equal((await f.repo.read('synthetic')).value.Nickname, 'rtdb-1');
});
for (const kind of ['epoch', 'backend', 'profile']) test(`${kind} 변경은 재시도 후 검증된 새 snapshot만 반환한다`, async () => {
  const f = fixture();
  if (kind === 'profile') f.state.onRead = n => { if (n === 2) f.state.token = '2'; };
  else f.state.onRoute = n => { if (n === 2) { f.state[kind] = kind === 'epoch' ? 2 : 'legacy'; f.state.token = '2'; } };
  const result = await f.repo.readRegistrationProfile('synthetic');
  assert.equal(result.profile.value.Nickname, `${f.state.backend}-2`); assert(f.counts().reads > 2);
});
test('미가입과 프로필 없는 기존 인벤토리 회원은 생성 없이 구분한다', async () => {
  for (const inventory of [true, false]) {
    const f = fixture({ exists: false, inventory }), result = await f.repo.readRegistrationProfile('synthetic');
    assert.equal(result.registered, inventory); assert.equal(result.profile.exists, false);
    assert.equal(result.profile.value, undefined);
  }
});
test('다음 요청과 다른 사용자는 이전 프로필을 재사용하지 않는다', async () => {
  const f = fixture(); await f.repo.readRegistrationProfile('one'); f.state.token = '2';
  const result = await Promise.all(['one', 'two'].map(uid => f.repo.readRegistrationProfile(uid)));
  assert(result.every(r => r.profile.value.Nickname === 'rtdb-2')); assert.equal(f.counts().reads, 6);
});
test('반복 변경과 DB 장애는 가입 성공으로 바꾸지 않는다', async () => {
  const f = fixture(); f.state.onRead = n => { f.state.token = String(n); };
  await assert.rejects(f.repo.readRegistrationProfile('synthetic'), { code: 'WRITER_FENCED' });
  f.state.onRead = () => { throw Error('synthetic-unavailable'); };
  await assert.rejects(f.repo.readRegistrationProfile('synthetic'), /synthetic-unavailable/);
});
