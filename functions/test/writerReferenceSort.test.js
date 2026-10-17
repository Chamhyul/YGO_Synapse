'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { sortReferences } = require('../services/user-storage/writerReferenceSort');
async function array(iterator) { const result = []; for await (const row of iterator) result.push(row); return result; }
const row = n => ({ key: `fs/users/${String(n).padStart(5, '0')}`, value: { id: 'a'.repeat(32), digest: 'b'.repeat(64), bytes: 1000, chunks: 1 } });
test('정렬은 제한 크기 묶음과 제한 수 병합으로 기존 localeCompare 순서·우선순위를 유지한다', async () => {
  const input = Array.from({ length: 1000 }, (_, n) => row((n * 17) % 1000)); input.push({ ...row(500), priority: 1 }, { ...row(500), priority: 0 }); let stats;
  const actual = await array(sortReferences(input, { maxEntries: 16, maxBytes: 2048, fanIn: 3, onStats: value => { stats = value; } }));
  assert.deepEqual(actual, input.slice().sort((a, b) => a.key.localeCompare(b.key) || (a.priority ?? 0) - (b.priority ?? 0)));
  assert.ok(stats.maxBufferedEntries <= 16); assert.ok(stats.maxBufferedBytes <= 2048); assert.ok(stats.maxMergeReaders <= 3); assert.ok(stats.mergePasses > 1); assert.equal(stats.cleaned, true);
});
test('빈 입력·Unicode 참조와 소비 중단에서도 임시 묶음을 정리한다', async () => {
  let stats; assert.deepEqual(await array(sortReferences([], { onStats: value => { stats = value; } })), []); assert.equal(stats.cleaned, true);
  const input = ['한글', 'A', '🙂', 'é'].map(key => ({ key, value: {} }));
  assert.deepEqual(await array(sortReferences(input)), input.slice().sort((a, b) => a.key.localeCompare(b.key)));
  for await (const _ of sortReferences([row(2), row(1)], { onStats: value => { stats = value; } })) break;
  assert.equal(stats.cleaned, true);
});
test('공간 상한과 입력 장애는 원문을 반환하지 않고 임시 파일을 정리한다', async () => {
  let stats;
  await assert.rejects(array(sortReferences(Array.from({ length: 100 }, (_, n) => row(n)), { maxEntries: 2, maxBytes: 1024, maxTemporaryBytes: 2048, onStats: value => { stats = value; } })), { code: 'WRITER_SORT_SPACE_EXHAUSTED' });
  assert.equal(stats.cleaned, true); assert.ok(stats.peakTemporaryBytes <= 2048);
  async function* broken() { yield row(1); throw Error('합성 원본 장애'); }
  await assert.rejects(array(sortReferences(broken(), { onStats: value => { stats = value; } })), /합성 원본 장애/); assert.equal(stats.cleaned, true);
});

test('큰 Unicode 목록의 byte 청크 경계에서도 순서를 보존하고 작은 목록은 파일 병합을 생략한다', async () => {
  const input = Array.from({ length: 300 }, (_, n) => ({ key: `합성🙂-${String(299 - n).padStart(4, '0')}-${'가🙂'.repeat(20)}`, value: { id: 'a'.repeat(32) } })); let stats;
  assert.deepEqual(await array(sortReferences(input, { maxEntries: 8, maxBytes: 1024, fanIn: 2, onStats: value => { stats = value; } })), input.slice().sort((a, b) => a.key.localeCompare(b.key)));
  assert.ok(stats.mergePasses > 1); assert.equal(stats.cleaned, true);
  await array(sortReferences([row(2), row(1)], { onStats: value => { stats = value; } })); assert.equal(stats.runs, 0); assert.equal(stats.temporaryBytes, 0);
});

test('병합 출력은 최대64KiB로 묶고 마지막 잔여분·공간 통계를 보존한다', async () => {
  const input = Array.from({ length: 5000 }, (_, n) => row(4999 - n)); let stats;
  const actual = await array(sortReferences(input, { onStats: value => { stats = value; } }));
  assert.deepEqual(actual, input.slice().sort((a, b) => a.key.localeCompare(b.key)));
  assert.ok(stats.maxOutputBufferedBytes > 32 * 1024); assert.ok(stats.maxOutputBufferedBytes <= 64 * 1024);
  assert.ok(stats.mergeWriteCalls < input.length * stats.mergePasses / 50);
  const bytes = input.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value) + '\n'), 0);
  assert.equal(stats.temporaryBytes, bytes * (stats.mergePasses + 1));
  assert.ok(stats.maxBufferedEntries <= 256); assert.ok(stats.maxBufferedBytes <= 256 * 1024);
  assert.ok(stats.maxMergeReaders <= 8); assert.ok(stats.peakTemporaryBytes <= 128 * 1024 * 1024); assert.equal(stats.cleaned, true);
});

test('64KiB보다 큰 Unicode 참조도 허용하고 작은 설정의 출력 상한·동일 우선순위를 유지한다', async () => {
  const input = Array.from({ length: 40 }, (_, n) => ({ key: `합성-${String(39 - n).padStart(4, '0')}-${'가🙂'.repeat(n % 2 ? 10000 : 1)}`, value: { n }, priority: n % 2 }));
  input.push({ ...input[10], value: { n: 999 } }); let stats;
  assert.deepEqual(await array(sortReferences(input, { onStats: value => { stats = value; } })), input.slice().sort((a, b) => a.key.localeCompare(b.key) || a.priority - b.priority));
  assert.ok(stats.maxOutputBufferedBytes <= 64 * 1024); assert.equal(stats.cleaned, true);
  await array(sortReferences(Array.from({ length: 100 }, (_, n) => row(n)), { maxEntries: 2, maxBytes: 1024, onStats: value => { stats = value; } }));
  assert.ok(stats.maxOutputBufferedBytes <= 1024); assert.equal(stats.cleaned, true);
});

test('묶음 쓰기 실패도 전파하며 열린 출력 파일과 해당 임시 폴더를 정리한다', async t => {
  const fs = require('node:fs/promises'), open = fs.open; let stats, failed = false, closed = 0, root;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
    root = require('node:path').dirname(args[0]);
    handle.writeFile = async (...values) => { if (!failed) { failed = true; throw Object.assign(new Error('합성 쓰기 장애'), { code: 'EIO' }); } return write(...values); };
    handle.close = async () => { closed++; return close(); }; return handle;
  });
  await assert.rejects(array(sortReferences(Array.from({ length: 1000 }, (_, n) => row(n)), { onStats: value => { stats = value; } })), { code: 'EIO' });
  assert.equal(closed, 1); assert.equal(stats.cleaned, true); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});

test('버퍼가 차기 전에도 공간 초과를 거부하고 외부 병합 소비 중단을 정리한다', async () => {
  let stats;
  await assert.rejects(array(sortReferences(Array.from({ length: 100 }, (_, n) => row(n)), { maxEntries: 2, maxTemporaryBytes: 22000, onStats: value => { stats = value; } })), { code: 'WRITER_SORT_SPACE_EXHAUSTED' });
  assert.ok(stats.peakTemporaryBytes <= 22000); assert.equal(stats.cleaned, true);
  for await (const _ of sortReferences(Array.from({ length: 3000 }, (_, n) => row(2999 - n)), { onStats: value => { stats = value; } })) break;
  assert.ok(stats.runs > 8); assert.equal(stats.cleaned, true);
});
