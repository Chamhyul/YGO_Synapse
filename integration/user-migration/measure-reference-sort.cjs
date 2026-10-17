'use strict';
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { sortReferences } = require('../../functions/services/user-storage/writerReferenceSort');
const sizes = [1000, 10000, 100000];
async function measure(mode, size) {
  global.gc?.(); const initial = process.memoryUsage(); let heap = initial.heapUsed, rss = initial.rss, stats;
  const sample = () => { const now = process.memoryUsage(); heap = Math.max(heap, now.heapUsed); rss = Math.max(rss, now.rss); };
  const timer = setInterval(sample, 5), started = performance.now();
  async function* input() {
    for (let n = size - 1; n >= 0; n--) { if (n % 256 === 0) sample(); yield { key: `fs/users/synthetic-${String(n).padStart(6, '0')}-${'x'.repeat(64)}`, scope: '1'.repeat(32), value: { id: '2'.repeat(32), digest: '3'.repeat(64), bytes: 1000, chunks: 1 }, priority: 0 }; }
    for (let n = 0; n < size; n += 4) yield { key: `fs/users/synthetic-${String(n).padStart(6, '0')}-${'x'.repeat(64)}`, scope: '4'.repeat(32), value: { id: '5'.repeat(32), digest: '6'.repeat(64), bytes: 2000, chunks: 1 }, priority: 1 };
  }
  const digest = createHash('sha256'); let count = 0;
  function output(row) { const { priority, ...header } = row; digest.update(JSON.stringify(header) + '\n'); count++; if (count % 256 === 0) sample(); }
  try {
    if (mode === 'map') {
      const map = new Map(); for await (const row of input()) map.set(row.key, row); sample();
      for (const key of [...map.keys()].sort((a, b) => a.localeCompare(b))) output(map.get(key));
    } else {
      let chosen; for await (const row of sortReferences(input(), { onStats: value => { stats = value; } })) { if (chosen && chosen.key !== row.key) output(chosen); chosen = row; } if (chosen) output(chosen);
    }
    sample(); return { mode, size, count, digest: digest.digest('hex'), ms: performance.now() - started,
      peakHeapDelta: Math.max(0, heap - initial.heapUsed), peakRssDelta: Math.max(0, rss - initial.rss), ...(stats ? { stats } : {}) };
  } finally { clearInterval(timer); }
}
(async () => {
  if (process.argv[2] === '--child') { const size = Number(process.argv[4]), mode = process.argv[3]; if (!sizes.includes(size) || !['map', 'sort'].includes(mode)) throw Error('합성 측정 인자만 허용합니다.'); process.stdout.write(JSON.stringify(await measure(mode, size)) + '\n'); return; }
  const results = [];
  for (const size of sizes) for (let round = 0; round < 3; round++) {
    const pair = [];
    for (const mode of round % 2 ? ['sort', 'map'] : ['map', 'sort']) {
      const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', mode, String(size)], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
      if (child.status !== 0) throw Error('합성 정렬 측정 실패'); const value = JSON.parse(child.stdout); value.round = round; pair.push(value); results.push(value);
    }
    if (pair[0].digest !== pair[1].digest || pair.some(value => value.count !== size)) throw Error('정렬 결과 불일치');
  }
  process.stdout.write(JSON.stringify({ fixture: 'synthetic-reference-only', results }) + '\n');
})().catch(error => { const code = /^WRITER_[A-Z_]+$/.test(error.code || '') ? error.code : 'SYNTHETIC_MEASURE_FAILED'; process.stderr.write(JSON.stringify({ code }) + '\n'); process.exitCode = 1; });
