'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const timing = require('../services/inventoryRequestTiming');
const { fixture, call } = require('./commonWriterFixture.cjs');
test('실제 로그인 API의 단계 계측은 가입/프로필/claims와 양방향 전환·복구 계약을 보존한다', async () => {
  const f = await fixture(), logs = [];
  try {
    f.mock('functions/services/inventoryRequestTiming.js', { ...timing,
      withLoginRequestTiming: (name, handler) => timing.withLoginRequestTiming(name, handler, { emit: line => logs.push(JSON.parse(line)) }) });
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    const registration = f.load('functions/routes/registration.js'), user = f.load('functions/routes/user.js');
    for (const backend of ['legacy', 'rtdb']) {
      if ((await f.binding.transition.route()).backend !== backend) {
        const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
        await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
      }
      const profile = await f.binding.repository.read(f.uid), start = logs.length;
      const route = f.binding.transition.route; let routes = 0;
      f.binding.transition.route = async () => { routes++; return route(); };
      const status = await call(registration.getRegistrationStatus, { method: 'GET' });
      f.binding.transition.route = route;
      assert.equal(status.statusCode, 200); assert.equal(status.body.registered, true);
      assert.equal(routes, 2, '가입 API의 최초 선택 공유 뒤에도 최종 epoch 확인을 유지한다');
      const initial = await call(registration.getRegistrationStatus, { method: 'GET', query: { includeUserData: 'true' } });
      assert.equal(initial.statusCode, 200); assert.equal(initial.body.registered, true);
      assert.equal(initial.body.initialData.success, true); assert.equal(initial.body.initialData.amount, 0);
      assert.equal((await f.binding.transition.inspect()).unresolved, 0);
      const data = await call(user.getUserData, { method: 'GET' });
      assert.equal(data.statusCode, 200); assert.equal(data.body.success, true); assert.equal(data.body.amount, 0);
      assert(Array.isArray(data.body.allCards));
      const stableBody = body => Object.fromEntries(Object.entries(body).filter(([key]) => !['lastUpdated', 'debug'].includes(key)));
      assert.deepEqual(stableBody(initial.body.initialData), stableBody(data.body), '통합·기존 API의 업무 응답은 같다');
      assert.deepEqual(await f.binding.repository.read(f.uid), profile);
      const rows = logs.slice(start); assert.equal(rows.length, 3);
      assert.equal(rows[0].operation, 'getRegistrationStatus'); assert.equal(rows[1].operation, 'getRegistrationStatus'); assert.equal(rows[2].operation, 'getUserData');
      const names = new Set(rows[2].spans.map(s => s.name));
      for (const name of ['storage.initialize', 'login.binding', 'registration.profile_read', 'login.profile', 'login.inventory', 'login.claims', 'login.response']) assert(names.has(name), name);
      assert(rows.every(r => r.completed && r.status === 200 && !r.droppedSpans));
      assert(!JSON.stringify(rows).includes(f.uid)); assert(!JSON.stringify(rows).includes('synthetic'));
      assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    }
    const writer = await f.binding.transition.route(); await f.binding.transition.copy(writer);
    await f.binding.transition.drain(writer); await f.binding.transition.activate(writer);
    assert.equal((await f.binding.transition.route()).backend, 'legacy');
    assert.equal((await call(user.getUserData, { method: 'GET' })).statusCode, 200);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

test('실제 사용자 API의 claims-only 선택은 전체 인벤토리 함수·쓰기 경로로 전달하지 않는다', async () => {
  const f = await fixture();
  try {
    await f.binding.transition.initialize();
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    f.mock('functions/services/loginUserData.js', { readLoginUserData: () => assert.fail('전체 인벤토리 조회 금지') });
    const calls = [];
    f.mock('functions/services/membershipClaims.js', { readMembershipClaimsStatus: async uid => { calls.push(uid); return { status: 'pending' }; } });
    const user = f.load('functions/routes/user.js');
    const res = await call(user.getUserData, { method: 'POST', body: { membershipClaimsOnly: true } });
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { success: true, membershipClaims: { status: 'pending' } });
    assert.deepEqual(calls, [f.uid]); assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { await f.close(); }
});
