'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createMembershipCsvLookup } = require('../services/user-storage/membershipCsvLookup');
const C = require('../services/membershipCsvWriterContract');
test('최대5000명은 회원 한 건만 전송하며 비회원 증명도 전체 목록을 조회하지 않는다', async () => {
  const c = open(randomBytes(16).toString('hex'));
  try {
    const members = Array.from({ length: 5000 }, (_, i) => ({ channelId: 'UC' + String(i * 2).padStart(22, '0'), memberName: '합성 회원', levelName: '합성 등급' }));
    const source = { members, fingerprint: C.digest(members) }, pointer = { revision: randomBytes(16).toString('hex'), fingerprint: source.fingerprint, count: members.length };
    let reads = 0, bytes = 0;
    const database = { ref(path) {
      const wrap = ref => new Proxy(ref, { get(target, key) {
        const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
        if (key === 'get') return async () => { const snapshot = await value.call(target); reads++; bytes += Buffer.byteLength(JSON.stringify(snapshot.val())); return snapshot; };
        if (['child','orderByKey','endAt','startAt','limitToLast','limitToFirst'].includes(key)) return (...args) => wrap(value.apply(target, args));
        return value.bind(target);
      } }); return wrap(c.targetDatabase.ref(path));
    } };
    const lookup = createMembershipCsvLookup({ database });
    const before = process.memoryUsage().rss, begin = performance.now();
    const prepared = await lookup.install(pointer, source), prepareMs = performance.now() - begin;
    reads = bytes = 0;
    let start = performance.now();
    assert.deepEqual(await lookup.read(pointer, members[2500].channelId, () => assert.fail('준비 후 전체 목록 금지')), { channelId: members[2500].channelId, levelName: members[2500].levelName });
    const positive = { ms: performance.now() - start, reads, bytes }; assert.equal(reads, 1); assert(bytes < 2048);
    reads = bytes = 0; start = performance.now();
    assert.equal(await lookup.read(pointer, 'UC' + String(5001).padStart(22, '0'), () => assert.fail('비회원 전체 조회 금지')), null);
    const negative = { ms: performance.now() - start, reads, bytes }; assert.equal(reads, 1); assert(bytes < 2048);
    console.log(JSON.stringify({ event: 'synthetic_csv_lookup_scale', count: members.length, sourceBytes: Buffer.byteLength(JSON.stringify(source)), projectionBytes: prepared.indexBytes, prepareMs, rssDeltaBytes: process.memoryUsage().rss - before, positive, negative }));
  } finally { await c.close(); }
});
