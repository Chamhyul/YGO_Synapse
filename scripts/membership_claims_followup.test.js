'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync('public/membership-claims-sync.js', 'utf8');
function fixture({ responses = [], refresh = true, durations = [], resultAt } = {}) {
    const timers = new Map(), states = [], bodies = [], starts = []; let id = 0, current = true, refreshed = 0, now = 0;
    const ctx = { performance: { now: () => now }, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(key) { timers.delete(key); } };
    vm.createContext(ctx); vm.runInContext(source, ctx);
    const start = () => ctx.YgoMembershipClaimsSync.start({ isCurrent: () => current,
        check: async () => { bodies.push('claims-only'); starts.push(now); const result = resultAt ? resultAt(now) : responses.shift();
            now += durations.shift() || 0; if (result instanceof Error) throw result; return result; },
        refresh: async () => { refreshed++; return refresh; }, onStatus: state => states.push(state) });
    return { start, states, bodies, timers, starts, cancel: () => ctx.YgoMembershipClaimsSync.cancel(), change: () => { current = false; },
        refreshed: () => refreshed, now: () => now,
        async tick() { const [key, timer] = timers.entries().next().value; timers.delete(key); now += timer.ms; await timer.fn(); } };
}
const synced = { success: true, membershipClaims: { status: 'synced', version: 'synthetic' } };
test('후속 완료 확인은 pending 뒤 서버·토큰 확정 시에만 안내를 해제한다', async () => {
    const f = fixture({ responses: [{ success: true, membershipClaims: { status: 'pending' } }, synced] });
    f.start(); assert.deepEqual(f.states, ['checking']); await f.tick(); await f.tick();
    assert.deepEqual(f.states, ['checking', 'ready']); assert.equal(f.bodies.length, 2); assert.equal(f.refreshed(), 1); assert.equal(f.timers.size, 0);
});
test('첫 확인은 예약 대기 없이 시작하고 완료된 worker는 추가 조회 없이 회수한다', async () => {
    const f = fixture({ responses: [synced] }); f.start();
    assert.equal([...f.timers.values()][0].ms, 0);
    await f.tick(); assert.deepEqual(f.states, ['checking', 'ready']); assert.equal(f.bodies.length, 1);
});
test('느린 조회는 겹치지 않고 정상 pending 뒤 짧은 확인을 추가한다', async () => {
    let resolve; const f = fixture({ responses: [new Promise(r => { resolve = r; }), synced] });
    f.start(); const running = f.tick(); assert.equal(f.timers.size, 0); assert.equal(f.bodies.length, 1);
    resolve({ success: true, membershipClaims: { status: 'pending' } }); await running;
    assert.equal([...f.timers.values()][0].ms, 250); await f.tick(); assert.equal(f.bodies.length, 2);
});
test('worker 완료 직전을 놓친 응답은 긴 backoff 전에 새 서버 증거와 토큰으로 확인한다', async () => {
    const f = fixture({ responses: [{ success: true, membershipClaims: { status: 'pending' } }, synced] });
    f.start(); await f.tick();
    assert.deepEqual(f.states, ['checking']); assert.equal(f.refreshed(), 0);
    assert.equal([...f.timers.values()][0].ms, 250);
    await f.tick(); assert.deepEqual(f.states, ['checking', 'ready']);
    assert.equal(f.refreshed(), 1); assert.equal(f.bodies.length, 2);
});
test('두 번째 pending은 다음 경과 시각에 fresh 증거를 확인하며 완료 전 토큰을 갱신하지 않는다', async () => {
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ responses: [pending, pending, synced] }); f.start();
    await f.tick(); await f.tick();
    assert.equal([...f.timers.values()][0].ms, 750);
    assert.equal(f.refreshed(), 0); assert.deepEqual(f.states, ['checking']);
    await f.tick(); assert.equal(f.refreshed(), 1);
    assert.deepEqual(f.states, ['checking', 'ready']); assert.equal(f.timers.size, 0);
});
test('지속 pending은 경과 24초까지 최대8회 확인하고 수동 복구를 남긴다', async () => {
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ responses: Array(8).fill(pending) }); f.start();
    const waits = [];
    while (f.timers.size) { waits.push([...f.timers.values()][0].ms); await f.tick(); }
    assert.deepEqual(waits, [0, 250, 750, 1000, 2000, 2000, 6000, 12000]);
    assert.deepEqual(f.starts, [0, 250, 1000, 2000, 4000, 6000, 12000, 24000]);
    assert.equal(f.bodies.length, 8); assert.equal(f.refreshed(), 0);
    assert.deepEqual(f.states, ['checking', 'pending']);
});
test('첫 worker가 5.5초에 완료되면 620ms 조회에서도 6초 지점에서 회수한다', async () => {
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ durations: Array(8).fill(620), resultAt: now => now >= 5500 ? synced : pending });
    f.start(); while (f.timers.size) await f.tick();
    assert.deepEqual(f.starts, [0, 1000, 2000, 4000, 6000]);
    assert.equal(f.now(), 6620); assert.equal(f.refreshed(), 1);
    assert.deepEqual(f.states, ['checking', 'ready']);
});
test('느린 확인으로 지난 예약은 몰아서 실행하지 않고 다음 시각을 선택한다', async () => {
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ responses: [pending, synced], durations: [5500] });
    f.start(); await f.tick();
    assert.equal([...f.timers.values()][0].ms, 500);
    await f.tick(); assert.deepEqual(f.starts, [0, 6000]);
    assert.deepEqual(f.states, ['checking', 'ready']);
});
test('정상 pending 뒤 오류가 나도 오류용 3/6/12초 대기는 소비되지 않는다', async () => {
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ responses: [pending, new Error('one'), new Error('two'), new Error('three'), synced] });
    f.start(); const waits = [];
    while (f.timers.size) { waits.push([...f.timers.values()][0].ms); await f.tick(); }
    assert.deepEqual(waits, [0, 250, 3000, 6000, 12000]);
    assert.deepEqual(f.states, ['checking', 'ready']);
});
test('오류·구형 응답·토큰 갱신 실패에는 빠른 확인을 추가하지 않는다', async () => {
    const f = fixture({ responses: [new Error('synthetic'), {}, synced, synced], refresh: false }); f.start();
    const waits = [];
    while (f.timers.size) { waits.push([...f.timers.values()][0].ms); await f.tick(); }
    assert.deepEqual(waits, [0, 3000, 6000, 12000]);
    assert.equal(f.bodies.length, 4); assert.deepEqual(f.states, ['checking', 'pending']);
});
test('빠른 확인 중 계정이 바뀌면 응답·토큰을 적용하지 않는다', async () => {
    let resolve;
    const pending = { success: true, membershipClaims: { status: 'pending' } };
    const f = fixture({ responses: [pending, pending, new Promise(r => { resolve = r; })] });
    f.start(); await f.tick(); await f.tick(); const running = f.tick();
    f.change(); resolve(synced); await running;
    assert.deepEqual(f.states, ['checking']); assert.equal(f.refreshed(), 0); assert.equal(f.timers.size, 0);
});
test('실패·구형 응답·토큰 실패는 제한4회 뒤 수동 재시도를 남긴다', async () => {
    const f = fixture({ responses: [new Error('synthetic'), {}, { success: false }, synced], refresh: false });
    f.start(); for (let i = 0; i < 4; i++) await f.tick();
    assert.deepEqual(f.states, ['checking', 'pending']); assert.equal(f.timers.size, 0); assert.equal(f.bodies.length, 4);
});
test('계정 변경·로그아웃·새 인증은 이전 완료 확인을 적용하지 않는다', async () => {
    const f = fixture({ responses: [synced] }); f.start(); f.change(); await f.tick(); assert.deepEqual(f.states, ['checking']); assert.equal(f.bodies.length, 0);
    const g = fixture({ responses: [synced] }); g.start(); g.start(); assert.equal(g.timers.size, 1); g.cancel(); assert.equal(g.timers.size, 0);
});
test('완료 확인 대기 중 다음 계정으로 바뀌어도 준비 상태를 전달하지 않는다', async () => {
    let resolve; const pending = new Promise(r => { resolve = r; }); const f = fixture({ responses: [pending] });
    f.start(); const running = f.tick(); f.change(); resolve(synced); await running; assert.deepEqual(f.states, ['checking']);
});
