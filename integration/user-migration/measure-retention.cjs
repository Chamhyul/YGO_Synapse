'use strict';
// scoped demo SDK만 연다. 운영 연결/실제 사용자 자료는 이 측정에 사용하지 않는다.
const fs = require('node:fs'), { randomBytes } = require('node:crypto');
const { open } = require('./connection.cjs');
const { createWriterHistoryStore } = require('../../functions/services/user-storage/writerHistoryStore');
const { createWriterPlanStore } = require('../../functions/services/user-storage/writerPlanStore');
const { encodeKey } = require('../../functions/services/user-storage/codec');
const { fingerprint } = require('../../functions/services/userMigrationRehearsal');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function downloadUSD(dailyBytes) {
  if (!Array.isArray(dailyBytes) || dailyBytes.some(value => !Number.isFinite(value) || value < 0)) throw Error('invalid synthetic traffic');
  return dailyBytes.reduce((sum, value) => sum + Math.max(0, value / 1e9 - 0.36), 0);
}
function received() {
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').filter(line => line.includes(':') && !line.includes('lo:'));
  return lines.reduce((sum, line) => sum + Number(line.split(':')[1].trim().split(/\s+/)[0]), 0);
}
function metered(database) {
  const stats = { gets: 0, listenerSnapshots: 0, transactions: 0, committed: 0, getPayloadBytes: 0, listenerPayloadBytes: 0, committedPayloadBytes: 0 };
  function wrap(target) {
    const listeners = new Map();
    return new Proxy(target, { get(value, property) {
      if (property === 'get') return async () => { stats.gets++; const snapshot = await value.get(); stats.getPayloadBytes += bytes(snapshot.val()); return snapshot; };
      if (property === 'on') return (event, callback, ...rest) => { const measured = snapshot => { stats.listenerSnapshots++; stats.listenerPayloadBytes += bytes(snapshot.val()); return callback(snapshot); }; listeners.set(callback, measured); return value.on(event, measured, ...rest); };
      if (property === 'off') return (event, callback) => value.off(event, listeners.get(callback) || callback);
      if (property === 'transaction') return async (...args) => { stats.transactions++; const result = await value.transaction(...args); if (result.committed) { stats.committed++; stats.committedPayloadBytes += bytes(result.snapshot.val()); } return result; };
      if (['orderByKey', 'startAt', 'limitToFirst'].includes(property)) return (...args) => wrap(value[property](...args));
      const item = value[property]; return typeof item === 'function' ? item.bind(value) : item;
    } });
  }
  return { database: { ref: path => wrap(database.ref(path)) }, stats, reset: () => { for (const key of Object.keys(stats)) stats[key] = 0; } };
}
async function main() {
  const results = [];
  for (const bodyBytes of [1024, 10240, 65536]) {
    const runId = randomBytes(16).toString('hex'), connection = open(runId), meter = metered(connection.targetDatabase);
    try {
      const history = createWriterHistoryStore({ database: meter.database, runId }), count = 32;
      const rx = received(), started = performance.now(), latencies = [];
      for (let n = 0; n < count; n++) {
        const id = n.toString(16).padStart(32, '0'), entry = { key: 'fs/users/synthetic', exists: true, token: '0', value: { body: 'x'.repeat(bodyBytes) } };
        const operation = { id, digest: fingerprint(entry), backend: 'legacy', epoch: 1, status: 'completed', capturedSequence: n + 1,
          resources: [entry.key], changes: [entry], result: null, receipt: { id, digest: fingerprint(entry), changes: [{ ...entry, token: '1' }], result: null } };
        const before = performance.now(); await history.put('operations', id, operation); latencies.push(performance.now() - before);
      }
      latencies.sort((a, b) => a - b);
      const archive = { milliseconds: performance.now() - started, containerRxBytes: received() - rx, ...meter.stats,
        latencyMs: { mean: latencies.reduce((sum, value) => sum + value, 0) / count, p50: latencies[Math.ceil(count * 0.5) - 1], p95: latencies[Math.ceil(count * 0.95) - 1], max: latencies.at(-1) } };
      const stored = bytes((await connection.targetDatabase.ref(`profileWriterHistory/${encodeKey(runId)}`).get()).val());
      meter.reset(); const pageRx = received(), pageStart = performance.now(); let cursor, seen = 0;
      do { const page = await history.summaryPage('operations', { cursor, limit: 7 }); seen += page.items.length; cursor = page.cursor || undefined; } while (cursor);
      if (seen !== count) throw Error('synthetic page count mismatch');
      const listing = { milliseconds: performance.now() - pageStart, containerRxBytes: received() - pageRx, ...meter.stats };
      const scenarios = [100, 1000, 10000].map(operationsPerDay => {
        const dayDownloadsGB = archive.containerRxBytes / count * operationsPerDay / 1e9;
        return { operationsPerDay, retentionDays: 90, storedGBAtDay90: stored / count * operationsPerDay * 90 / 1e9,
          estimatedStorageUSDAtDay90: Math.max(0, stored / count * operationsPerDay * 90 / 1e9 - 1) * 5,
          emulatorArchiveDownloadsGBPerDay: dayDownloadsGB, estimatedDownloadsUSDPer30Days: downloadUSD(Array(30).fill(dayDownloadsGB * 1e9)) };
      });
      results.push({ bodyBytes, count, storedBytes: stored, archive, pageListing: listing, scenarios });
    } finally { await connection.close(); }
  }
  const runId = randomBytes(16).toString('hex'), connection = open(runId), meter = metered(connection.targetDatabase);
  try {
    const plans = createWriterPlanStore({ database: meter.database, runId }), count = 70, bodyBytes = 65536;
    const entries = Array.from({ length: count }, (_, n) => ({ key: 'fs/users/synthetic-' + String(n).padStart(3, '0'), exists: true, token: '0', value: { body: 'x'.repeat(bodyBytes) } }));
    const rx = received(), started = performance.now(), ref = await plans.save(entries);
    const creation = { milliseconds: performance.now() - started, containerRxBytes: received() - rx, ...meter.stats };
    const stored = bytes((await connection.targetDatabase.ref(`profileWriterPlans/${encodeKey(runId)}`).get()).val());
    results.push({ kind: 'snapshot-plan', count, bodyBytes, sourcePayloadBytes: count * bodyBytes, hotReferenceBytes: bytes(ref), storedBytes: stored, creation });
  } finally { await connection.close(); }
  process.stdout.write(JSON.stringify({ format: 1, environment: 'isolated-demo-emulator', currency: 'USD', gbBytes: 1e9,
    sampleConcurrency: 1, pricing: { storedGBFree: 1, storageUSDPerGBMonth: 5, blazeDownloadsGBFreePerDay: 0.36, downloadsUSDPerGB: 1,
      source: 'https://firebase.google.com/pricing', billingSource: 'https://firebase.google.com/docs/database/usage/billing' },
    limitations: ['합성 별도 보관/계획 SDK 측정이며 업무 DB·hot journal·Functions·Auth·Storage 비용은 제외한다.',
      'container Rx는 demo HTTP/TCP 수신량이며 운영 TLS·실지역·캐시·기존 연결 부하와 실제 과금량을 입증하지 않는다.',
      'get/listener payload는 중복 관측이 가능하므로 합산하여 billable bytes로 쓰지 않는다.',
      '단가/균등한 일일 작업량/90일 무삭제 보관을 가정한 규모 시나리오이며 실제 청구 예측이 아니다.'], results }, null, 2) + '\n');
}
if (require.main === module) main().catch(() => { process.stderr.write('격리된 보관 측정 설정과 상태를 확인해 주세요.\n'); process.exitCode = 1; });
module.exports = { downloadUSD, metered, received };
