'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createReadDiagnostics, measureRtdbGet } = require('../services/rtdbReadDiagnostics');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeDatabase() {
  const callbacks = [], paths = [];
  return { paths, ref(path) { paths.push(path); return { on(event, callback) { assert.equal(event, 'value'); callbacks.push(callback); } }; },
    connected(value) { for (const callback of callbacks) callback({ val: () => value }); } };
}
test('계측이 없는 GET은 원래 Promise·오류를 그대로 반환하며 연결을 관측하지 않는다', () => {
  const db = fakeDatabase(), value = Promise.resolve({ private: 'must-not-log' });
  assert.equal(measureRtdbGet(db, 'profile', () => value), value); assert.deepEqual(db.paths, []);
  const error = Error('private-path'); assert.throws(() => measureRtdbGet(db, 'record', () => { throw error; }), e => e === error);
});
test('동시 GET은 하나의 연결 메타 관측을 공유하고 업무 값·경로·오류를 기록하지 않는다', async () => {
  const db = fakeDatabase(), d = createReadDiagnostics();
  const result = await d.run(async () => {
    const a = measureRtdbGet(db, 'profile', async () => { await sleep(50); return 'private-profile'; });
    db.connected(true);
    const b = measureRtdbGet(db, 'storage', async () => { await sleep(45); return 'private-journal'; });
    return Promise.all([a, b]);
  });
  const log = d.finish(); assert.deepEqual(result, ['private-profile', 'private-journal']);
  assert.deepEqual(db.paths, ['.info/connected']); assert.equal(log.connections.length, 1); assert.equal(log.gets.length, 2);
  assert.equal(log.gets[0].stateAtStart, -1); assert.equal(log.gets[1].stateAtStart, 1);
  assert.equal(log.connections[0].changes.at(-1).state, 1); assert.ok(log.gets.every(g => g.ok && g.durationMs >= 40));
  assert.doesNotMatch(JSON.stringify(log), /private|token|\.info|path|uid/i);
});
test('같은 DB의 다음 요청도 관측 하나를 재사용하고 이전 상태 변경 시각을 구분한다', async () => {
  const db = fakeDatabase(), a = createReadDiagnostics();
  await a.run(() => measureRtdbGet(db, 'record', () => { db.connected(true); return Promise.resolve(1); })); a.finish();
  const b = createReadDiagnostics(); await b.run(() => measureRtdbGet(db, 'storage', () => Promise.resolve(2)));
  const log = b.finish(); assert.equal(db.paths.length, 1); assert.equal(log.connections[0].stateAtFirstGet, 1);
  assert.deepEqual(log.connections[0].changes, []); assert.ok(log.connections[0].lastObservedChangeAgeMs >= 0);
});
test('연결 끊김·복원은 동일 GET과 요청 시간축에 기록한다', async () => {
  const db = fakeDatabase(), d = createReadDiagnostics();
  await d.run(() => measureRtdbGet(db, 'profile', async () => {
    db.connected(true); await sleep(10); db.connected(false); await sleep(15); db.connected(true);
  }));
  const log = d.finish(); assert.deepEqual(log.connections[0].changes.map(x => x.state), [1, 0, 1]);
  assert.ok(log.connections[0].changes.every((x, i, a) => !i || x.atMs >= a[i - 1].atMs));
});
test('GET 오류·관측 실패가 원본 오류를 바꾸거나 새 업무 호출을 만들지 않는다', async () => {
  const db = { ref() { throw Error('secret'); } }, error = Error('original-secret'), d = createReadDiagnostics(); let calls = 0;
  await assert.rejects(d.run(() => measureRtdbGet(db, 'record', () => { calls++; return Promise.reject(error); })), e => e === error);
  const log = d.finish(); assert.equal(calls, 1); assert.equal(log.gets[0].ok, false); assert.equal(log.gets[0].stateAtEnd, -1);
  assert.doesNotMatch(JSON.stringify(log), /secret|original/);
});
test('이벤트 루프 정지는 숫자로 관측하고 응답 이후 타이머·늦은 완료를 기록하지 않는다', async () => {
  const db = fakeDatabase(), d = createReadDiagnostics();
  await d.run(() => measureRtdbGet(db, 'profile', async () => {
    await sleep(25); const until = performance.now() + 110; while (performance.now() < until) {} await sleep(30);
  }));
  const log = d.finish(); assert.ok(log.eventLoopMaxDelayMs >= 60); assert.ok(log.gets[0].eventLoopMaxDelayMs >= 60);
  const saved = JSON.stringify(log); await sleep(50); assert.equal(JSON.stringify(log), saved); assert.equal(d.finish(), undefined);
});
test('늦게 끝난 GET과 요청 간 동시 실행은 서로의 관측을 오염시키지 않는다', async () => {
  const db = fakeDatabase(), a = createReadDiagnostics(), b = createReadDiagnostics(); let finish;
  const task = a.run(() => measureRtdbGet(db, 'profile', () => new Promise(resolve => { finish = resolve; })));
  const logA = a.finish(), saved = JSON.stringify(logA);
  await b.run(() => measureRtdbGet(db, 'record', async () => { await sleep(25); return 3; }));
  finish(4); assert.equal(await task, 4); assert.equal(JSON.stringify(logA), saved); assert.equal(b.finish().gets[0].kind, 'record');
});
test('기록 상한과 연결 변화 상한을 유지한다', async () => {
  const db = fakeDatabase(), d = createReadDiagnostics();
  await d.run(async () => {
    for (let i = 0; i < 80; i++) await measureRtdbGet(db, 'record', () => { db.connected(i % 2 === 0); return Promise.resolve(i); });
  });
  const log = d.finish(); assert.equal(log.gets.length, 64); assert.equal(log.droppedGets, 16);
  assert.ok(log.connections[0].changes.length <= 32); assert.ok(log.connections[0].droppedChanges > 0);
});
test('실제 getUserData 계측의 finish/close와 출력 실패도 인증 응답·오류를 보존한다', async () => {
  const { withLoginRequestTiming } = require('../services/inventoryRequestTiming');
  const db = fakeDatabase(), logs = []; const response = new EventEmitter();
  Object.assign(response, { statusCode: 200, setHeader() {}, getHeader() {} });
  const handler = withLoginRequestTiming('getUserData', async () => { await measureRtdbGet(db, 'storage', () => Promise.resolve(7)); response.emit('finish'); response.emit('close'); return 7; }, { emit: line => logs.push(JSON.parse(line)) });
  assert.equal(await handler({ method: 'POST', body: {} }, response), 7); assert.equal(logs.length, 1);
  assert.equal(logs[0].rtdbReads.gets.length, 1);
  const other = withLoginRequestTiming('getRegistrationStatus', () => 8, { emit() { throw Error('logging-failure'); } });
  assert.equal(await other({ method: 'POST', body: {} }, { statusCode: 200 }), 8);
});
