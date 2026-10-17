'use strict';
const { randomBytes } = require('node:crypto');
const { open } = require('./connection.cjs');
const { metered, received } = require('./measure-retention.cjs');
const { createWriterJournalStore } = require('../../functions/services/user-storage/writerJournalStore');
async function main() {
  const results = [];
  for (const bodyBytes of [1024, 65536, 1048576]) {
    const runId = randomBytes(16).toString('hex'), c = open(runId), meter = metered(c.targetDatabase);
    try {
      const journal = createWriterJournalStore({ database: meter.database, path: 'routeJournal' });
      const value = { format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
        operations: { synthetic: { body: 'x'.repeat(bodyBytes) } }, events: [], frozen: {} };
      await journal.compareAndSet(runId, 0, value); const modes = {};
      for (const mode of ['full', 'route']) {
        meter.reset(); const rx = received(), started = performance.now(), times = [];
        for (let n = 0; n < 32; n++) {
          const before = performance.now(), result = mode === 'full' ? await journal.read(runId) : await journal.readRoute(runId);
          if (result.value.backend !== 'legacy' || result.value.epoch !== 1) throw Error('synthetic state mismatch');
          times.push(performance.now() - before);
        }
        times.sort((a, b) => a - b);
        modes[mode] = { count: 32, milliseconds: performance.now() - started, containerRxBytes: received() - rx,
          p95Ms: times[Math.ceil(times.length * 0.95) - 1], ...meter.stats };
      }
      results.push({ bodyBytes, ...modes, payloadReductionPercent: (1 - modes.route.getPayloadBytes / modes.full.getPayloadBytes) * 100 });
    } finally { await c.close(); }
  }
  process.stdout.write(JSON.stringify({ environment: 'isolated-demo-emulator', results,
    limitations: ['같은 신규 기록의 전체 읽기와 빠른 상태 읽기를 비교한32개 순차 합성 표본이다.',
      '신규 통합 헤더는GET1회다. 초기화/구형 fallback/업무 전후 대조와 별개이며 payload 감소를 전체 부하 감소율로 보지 않는다.',
      'SDK get/listener를 과금량으로 합산하지 않는다. 실제 운영/동시 부하/청구를 입증하지 않는다.'] }, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('격리된 상태 조회 측정 환경을 확인해 주세요.\n'); process.exitCode = 1; });
