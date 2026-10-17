'use strict';
// SDK/네트워크를 제외한 같은 snapshot 변환·지문 비용이다. 운영 지연/청구와 구분한다.
const rehearsal = require('../../functions/services/userMigrationRehearsal');
const original = rehearsal.fingerprint;
let hashes = 0, hashMs = 0;
rehearsal.fingerprint = value => {
  const before = performance.now();
  try { return original(value); } finally { hashes++; hashMs += performance.now() - before; }
};
const { createWriterJournalStore, projection, encodeJournalRecord } = require('../../functions/services/user-storage/writerJournalStore');
const { encodeValue, encodeKey } = require('../../functions/services/user-storage/codec');
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function main() {
  const results = [], count = 300, rounds = 5, id = 'a'.repeat(32), path = `synthetic/${encodeKey(id)}`;
  for (const operations of [0, 128]) {
    const state = { format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
      operations: Object.fromEntries(Array.from({ length: operations }, (_, n) => [`operation${n}`, { body: 'x'.repeat(1024) }])),
      events: [], frozen: {} };
    const raw = encodeJournalRecord({ format: 1, revision: 1, generation: 0, tombstone: false,
      payload: { version: 2, value: encodeValue(state).value, control: projection(state, 1, id) } }, id, path);
    const database = { ref: key => ({ get: async () => ({ val: () => key === `${path}/head` ? raw.head : raw }) }) };
    const store = createWriterJournalStore({ database, path: 'synthetic' }), modes = { full: [], route: [] };
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 ? ['route', 'full'] : ['full', 'route']) {
        const read = () => mode === 'full' ? store.read(id) : store.readRoute(id);
        for (let n = 0; n < 32; n++) await read();
        hashes = 0; hashMs = 0; const times = [];
        for (let n = 0; n < count; n++) {
          const before = performance.now(), result = await read();
          if (!result.exists || result.value.backend !== 'legacy' || result.value.epoch !== 1) throw Error('synthetic mismatch');
          times.push(performance.now() - before);
        }
        modes[mode].push({ round, hashesPerRead: hashes / count, hashMsPerRead: hashMs / count,
          meanMs: times.reduce((a, b) => a + b, 0) / count, p50Ms: percentile(times, .5), p95Ms: percentile(times, .95) });
      }
    }
    results.push({ operations, modes, summary: Object.fromEntries(Object.entries(modes).map(([mode, samples]) => [mode, {
      hashesPerRead: samples[0].hashesPerRead, medianRoundMeanMs: percentile(samples.map(v => v.meanMs), .5),
      medianRoundP95Ms: percentile(samples.map(v => v.p95Ms), .5), medianRoundHashMs: percentile(samples.map(v => v.hashMsPerRead), .5),
    }])) });
  }
  process.stdout.write(JSON.stringify({ environment: 'networkless-synthetic-snapshot', count, rounds, results,
    limitations: ['동일 snapshot을 반환하는 합성 의존성이며 실제 SDK/네트워크/청구는 포함하지 않는다.',
      'fingerprint 측정 래퍼의 비용을 포함하며 기준/신규 이미지에서 같은 도구를 사용한다.'] }, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('합성 조회 측정에 실패했습니다.\n'); process.exitCode = 1; });
