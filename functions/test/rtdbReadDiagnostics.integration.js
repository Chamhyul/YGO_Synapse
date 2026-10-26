'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createReadDiagnostics } = require('../services/rtdbReadDiagnostics');
const { createStorageAccess } = require('../services/user-storage/storageAccess');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('실제 getUserData 계측 문맥에서 헤더·프로필·레코드 GET 세 경로가 같은 연결을 사용한다', async () => {
  const f = open(randomBytes(16).toString('hex'));
  const { EventEmitter } = require('node:events');
  const { FieldValue } = require('firebase-admin/firestore');
  const { createProfileWriterAdapters } = require('../services/userProfileWriterAdapters');
  const { createRecordStore } = require('../services/user-storage/recordStore');
  const { withLoginRequestTiming } = require('../services/inventoryRequestTiming');
  // demo의 업무 경로만 scope하고 .info는 실제 SDK 로컬 메타정보로 보낸다.
  const database = { ref: path => path === '.info/connected' ? f.database.ref(path) : f.targetDatabase.ref(path) };
  const access = createStorageAccess({ database }), records = createRecordStore({ database, path: 'syntheticRecords' });
  const profiles = createProfileWriterAdapters({ database, db: f.db, FieldValue }), logs = [];
  const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {}, getHeader() {} });
  try {
    const before = (await f.targetDatabase.ref('users').get()).val();
    const handler = withLoginRequestTiming('getUserData', async () => {
      await Promise.all([access.read('syntheticHeader'), profiles.rtdb.read('fs/users/synthetic-diagnostics'), records.read('synthetic')]);
      res.emit('finish'); return 3;
    }, { emit: line => logs.push(JSON.parse(line)) });
    assert.equal(await handler({ method: 'POST', body: {} }, res), 3);
    const read = logs[0].rtdbReads; assert.deepEqual(read.gets.map(g => g.kind).sort(), ['profile', 'record', 'storage']);
    assert.equal(read.connections.length, 1); assert.ok(read.gets.every(g => g.ok));
    assert.equal(read.connections[0].stateAtEnd, 1); assert.equal(read.connections[0].observerErrors, 0);
    assert.deepEqual((await f.targetDatabase.ref('users').get()).val(), before);
  } finally { await f.close(); }
});

test('실제 demo SDK의 연결 중단 시간초과·새 연결의 원본 대조와 늦은 응답 격리를 유지한다', { timeout: 15000 }, async () => {
  const runId = randomBytes(16).toString('hex'), f = open(runId);
  const path = 'diagnosticSynthetic/' + randomBytes(16).toString('hex');
  const access = createStorageAccess({ database: f.database, timeoutMs: 5000 });
  let fresh;
  try {
    await f.database.ref(path).set({ preserved: 7 });
    const first = createReadDiagnostics();
    assert.deepEqual(await first.run(() => access.read(path)), { preserved: 7 });
    await sleep(25); const firstLog = first.finish(); assert.equal(firstLog.connections[0].stateAtEnd, 1);
    f.database.goOffline(); await sleep(30);
    const limited = createStorageAccess({ database: f.database, timeoutMs: 80 }), d = createReadDiagnostics();
    await assert.rejects(d.run(() => limited.read(path)), { code: 'USER_STORAGE_READ_TIMEOUT' });
    const ended = d.finish(), saved = JSON.stringify(ended); assert.equal(ended.gets[0].stateAtStart, 0);
    // 기존 미확정/종료 연결을 자동 교체하지 않는다. 시험에서 명시 새 SDK로 원본을 대조한다.
    fresh = open(runId);
    const restored = createStorageAccess({ database: fresh.database, timeoutMs: 5000 }), next = createReadDiagnostics();
    assert.deepEqual(await next.run(() => restored.read(path)), { preserved: 7 });
    const log = next.finish(); assert.equal(log.connections[0].stateAtEnd, 1);
    assert.equal(JSON.stringify(ended), saved); assert.doesNotMatch(JSON.stringify([firstLog, ended, log]), new RegExp(path));
    console.log(JSON.stringify({ event: 'synthetic_rtdb_get_connection', offlineState: ended.gets[0].stateAtStart,
      freshState: log.connections[0].stateAtEnd, freshGetMs: log.gets[0].durationMs,
      onlySynthetic: true, sameConnectionReconnectProven: false, productionNetworkMeasured: false }));
  } finally { await f.close(); if (fresh) await fresh.close(); }
});
