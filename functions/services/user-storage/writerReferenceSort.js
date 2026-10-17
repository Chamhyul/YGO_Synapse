'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const fail = () => Object.assign(new Error('키·참조 정렬 자료와 임시 공간을 확인해 주세요.'), { code: 'WRITER_SORT_INVALID' });
const compare = (a, b) => a.key.localeCompare(b.key) || (a.priority ?? 0) - (b.priority ?? 0);
const MERGE_WRITE_BYTES = 64 * 1024;

// 실제 본문은 받지 않는다. 실행 환경의 비공개 임시 폴더에 제한 크기 묶음만 저장한다.
async function* sortReferences(input, { maxEntries = 256, maxBytes = 256 * 1024, fanIn = 8, maxTemporaryBytes = 128 * 1024 * 1024, onStats = () => {} } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 2 || maxEntries > 4096
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024
      || !Number.isSafeInteger(fanIn) || fanIn < 2 || fanIn > 16
      || !Number.isSafeInteger(maxTemporaryBytes) || maxTemporaryBytes < 1024 || maxTemporaryBytes > 256 * 1024 * 1024) throw fail();
  const root = await fs.mkdtemp(join(tmpdir(), 'ygo-writer-sort-'));
  const stats = { entries: 0, runs: 0, mergePasses: 0, maxBufferedEntries: 0, maxBufferedBytes: 0, maxMergeReaders: 0, maxOutputBufferedBytes: 0, mergeWriteCalls: 0, temporaryBytes: 0, peakTemporaryBytes: 0, cleaned: false };
  let liveBytes = 0;
  function reserve(size) { if (liveBytes + size > maxTemporaryBytes) throw Object.assign(fail(), { code: 'WRITER_SORT_SPACE_EXHAUSTED' });
    liveBytes += size; stats.peakTemporaryBytes = Math.max(stats.peakTemporaryBytes, liveBytes); }
  const name = (level, n) => join(root, `${level}-${n}.jsonl`);
  async function* read(path) {
    const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16 * 1024 }); let pending = '';
    try {
      for await (const chunk of stream) {
        pending += chunk; let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line || Buffer.byteLength(line) > maxBytes) throw fail(); const row = JSON.parse(line); if (typeof row?.key !== 'string') throw fail(); yield row;
        }
        if (Buffer.byteLength(pending) > maxBytes) throw fail();
      }
      if (pending) throw fail();
    } finally { stream.destroy(); }
  }
  async function merge(paths, output) {
    const iterators = paths.map(path => read(path)[Symbol.asyncIterator]()), next = [], file = await fs.open(output, 'wx', 0o600);
    stats.maxMergeReaders = Math.max(stats.maxMergeReaders, paths.length);
    const outputBuffer = Buffer.alloc(Math.min(MERGE_WRITE_BYTES, maxBytes)); let outputBytes = 0;
    async function flushOutput() {
      if (!outputBytes) return;
      await file.writeFile(outputBuffer.subarray(0, outputBytes));
      stats.mergeWriteCalls++; stats.temporaryBytes += outputBytes; outputBytes = 0;
    }
    try {
      for (const iterator of iterators) next.push(await iterator.next());
      while (next.some(row => !row.done)) {
        let first = -1; for (let n = 0; n < next.length; n++) if (!next[n].done && (first < 0 || compare(next[n].value, next[first].value) < 0)) first = n;
        const line = JSON.stringify(next[first].value) + '\n', size = Buffer.byteLength(line); reserve(size);
        // 한 참조의 기존 byte 한도는 유지한다. 큰 참조는 버퍼에 쌓지 않고 기존처럼 직접 쓴다.
        if (size > outputBuffer.length) {
          await flushOutput(); await file.writeFile(line); stats.mergeWriteCalls++; stats.temporaryBytes += size;
        } else {
          if (outputBytes + size > outputBuffer.length) await flushOutput();
          outputBuffer.write(line, outputBytes, size, 'utf8'); outputBytes += size;
          stats.maxOutputBufferedBytes = Math.max(stats.maxOutputBufferedBytes, outputBytes);
        }
        next[first] = await iterators[first].next();
      }
      await flushOutput();
    } finally { await file.close(); await Promise.all(iterators.map(iterator => iterator.return?.())); }
  }
  try {
    let rows = [], bytes = 0, runs = 0;
    async function flush() {
      if (!rows.length) return; rows.sort(compare);
      const body = rows.map(row => JSON.stringify(row) + '\n').join(''); reserve(Buffer.byteLength(body)); await fs.writeFile(name(0, runs++), body, { flag: 'wx', mode: 0o600 });
      stats.temporaryBytes += Buffer.byteLength(body); rows = []; bytes = 0;
    }
    for await (const row of input) {
      if (typeof row?.key !== 'string' || row.priority !== undefined && (!Number.isSafeInteger(row.priority) || row.priority < 0)) throw fail();
      const size = Buffer.byteLength(JSON.stringify(row) + '\n'); if (size > maxBytes) throw fail();
      if (rows.length && (rows.length >= maxEntries || bytes + size > maxBytes)) await flush();
      rows.push(row); bytes += size; stats.entries++;
      stats.maxBufferedEntries = Math.max(stats.maxBufferedEntries, rows.length); stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, bytes);
    }
    // 고정 상한 안의 작은 목록은 메모리에서 끝내 불필요한 파일 왕복을 줄인다.
    if (!runs) { rows.sort(compare); for (const row of rows) yield row; return; }
    await flush(); stats.runs = runs; let level = 0;
    while (runs > 1) {
      let outputs = 0;
      for (let start = 0; start < runs; start += fanIn) {
        const paths = Array.from({ length: Math.min(fanIn, runs - start) }, (_, n) => name(level, start + n));
        await merge(paths, name(level + 1, outputs++)); for (const path of paths) { liveBytes -= (await fs.stat(path)).size; await fs.unlink(path); }
      }
      runs = outputs; level++; stats.mergePasses++;
    }
    if (runs) for await (const row of read(name(level, 0))) yield row;
  } finally { await fs.rm(root, { recursive: true, force: true }); stats.cleaned = true; onStats({ ...stats }); }
}
module.exports = { sortReferences };
