'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createWriterSnapshotSource } = require('../services/user-storage/writerSnapshotSource');
const { encodeKey } = require('../services/user-storage/codec');
function setup(adapters, ids) {
  const queries = [], reads = [];
  const db = { collection(path) { const query = {
    orderBy(field) { queries.push(['orderBy', path, field]); return query; },
    limit(n) { queries.push(['limit', n]); return query; },
    select() { queries.push(['select']); return query; },
    startAfter(id) { queries.push(['after', id]); return query; },
    async get() { return { docs: ids.map(id => ({ id })) }; },
  }; return query; } };
  const profile = { read: async key => { reads.push(key); return { key, exists: true, token: '0', value: {} }; } };
  return { queries, reads, source: createWriterSnapshotSource({ db, database: { ref() {} }, backend: 'legacy', adapters: { profile, ...adapters } }) };
}
test('Firestore 목록은 이름만 페이지 조회하고 본문은 소비할 때 한 항목씩 읽는다', async () => {
  const f = setup({}, ['a', 'b']), page = await f.source.page();
  assert.equal(page.size, 2); assert.equal(f.reads.length, 0); assert.ok(f.queries.some(row => row[0] === 'select'));
  const iterator = page.entries[Symbol.asyncIterator](); assert.equal((await iterator.next()).value.key, 'fs/users/a'); assert.deepEqual(f.reads, ['fs/users/a']);
  assert.equal((await iterator.next()).value.key, 'fs/users/b'); assert.equal((await iterator.next()).done, true);
});
test('위치의 경로 주입·잘못된 source 번호는 조회 전에 거부하고 source 구성이 다르면 layout도 다르다', async () => {
  const f = setup({}, []);
  for (const cursor of [{ source: 10, after: null }, { source: 0, after: null, path: 'other' }, { source: 0, after: '' }]) await assert.rejects(f.source.page(cursor), { code: 'WRITER_SNAPSHOT_INVALID' });
  assert.equal(f.queries.length, 0); assert.notEqual(f.source.layout, setup({ membership: { read() {} } }, []).source.layout);
});
test('CSV·인증 메타정보의 잘못된 논리 키를 다른 도메인으로 전달하지 않는다', async () => {
  const f = setup({ csv: { read() {} } }, [encodeKey('fs/users/other')]);
  await assert.rejects(f.source.page({ source: 3, after: null }), { code: 'CSV_WRITER_INVALID_KEY' }); assert.equal(f.reads.length, 0);
  const g = setup({ membership: { read() {} } }, [encodeKey('csv/control')]);
  await assert.rejects(g.source.page({ source: 4, after: null }), { code: 'MEMBERSHIP_WRITER_INVALID_KEY' }); assert.equal(g.reads.length, 0);
});
