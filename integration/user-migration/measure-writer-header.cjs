'use strict';
const { randomBytes } = require('node:crypto');
const { open } = require('./connection.cjs');
const { metered, received } = require('./measure-retention.cjs');
const { createWriterJournalStore } = require('../../functions/services/user-storage/writerJournalStore');
const { encodeKey } = require('../../functions/services/user-storage/codec');
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function main() {
  const results = [], count = 128, rounds = 5;
  for (const bodyBytes of [0, 1024, 65536]) {
    const runId = randomBytes(16).toString('hex'), c = open(runId), meter = metered(c.targetDatabase);
    try {
      const journal = createWriterJournalStore({ database: meter.database, path: 'headerMeasurement' });
      const state = { format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
        operations: bodyBytes ? { synthetic: { body: 'x'.repeat(bodyBytes) } } : {}, events: [], frozen: {} };
      await journal.compareAndSet(runId, 0, state);
      const raw = (await c.targetDatabase.ref(`headerMeasurement/${encodeKey(runId)}`).get()).val();
      const modes = { full: [], route: [] };
      for (let round = 0; round < rounds; round++) {
        // 순서 효과를 줄이며 각 모드의 첫 연결/캐시 준비는 표본에서 제외한다.
        for (const mode of round % 2 ? ['route', 'full'] : ['full', 'route']) {
          const read = () => mode === 'full' ? journal.read(runId) : journal.readRoute(runId);
          for (let n = 0; n < 16; n++) await read();
          meter.reset(); const rx = received(), times = [];
          for (let n = 0; n < count; n++) {
            const before = performance.now(), result = await read();
            if (!result.exists || result.value.backend !== 'legacy' || result.value.epoch !== 1
                || result.value.phase !== 'accepting') throw Error('synthetic state mismatch');
            times.push(performance.now() - before);
          }
          modes[mode].push({ round, count, milliseconds: times.reduce((a, b) => a + b, 0),
            p50Ms: percentile(times, .5), p95Ms: percentile(times, .95),
            containerRxBytes: received() - rx, ...meter.stats });
        }
      }
      const summary = Object.fromEntries(Object.entries(modes).map(([mode, samples]) => [mode, {
        count: count * rounds, gets: samples.reduce((a, v) => a + v.gets, 0),
        getPayloadBytes: samples.reduce((a, v) => a + v.getPayloadBytes, 0),
        medianRoundP50Ms: percentile(samples.map(v => v.p50Ms), .5),
        medianRoundP95Ms: percentile(samples.map(v => v.p95Ms), .5),
      }]));
      results.push({ bodyBytes, storedFormat: raw.head?.format ?? raw.payload?.version,
        physicalRecordBytes: Buffer.byteLength(JSON.stringify(raw)), summary, rounds: modes });
    } finally { await c.close(); }
  }
  process.stdout.write(JSON.stringify({ environment: 'isolated-demo-emulator', samplesPerRound: count, rounds,
    results, limitations: ['동일 합성 상태에서 모드별128회·5라운드 순차 표본이다. 각 모드16회 준비 조회는 지표에서 제외한다.',
      '기존 분리 reader 이미지와 통합 헤더 이미지에서 같은 도구/fixture를 따로 실행한다. 실제 동시 운영·RTT·TLS·청구 증거가 아니다.',
      'p95 중앙값은 라운드별p95의 중앙값이며 전체 표본p95와 구분한다. SDK payload와 컨테이너 수신/과금량은 다르다.'] }, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('격리된 헤더 조회 측정 환경을 확인해 주세요.\n'); process.exitCode = 1; });
