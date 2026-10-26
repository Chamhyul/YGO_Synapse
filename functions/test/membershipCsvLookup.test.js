'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildLookup, verifyEntry } = require('../services/user-storage/membershipCsvLookup');
const member = n => ({ channelId: 'UC' + String(n).padStart(22, '0'), levelName: '합성 등급' });
for (const count of [1, 2, 3, 17, 5000]) test(`채널 최소 색인 ${count}명의 정렬 위치·등급 증명`, () => {
  const source = Array.from({ length: count }, (_, n) => member(n)), tree = buildLookup([...source].reverse());
  assert.equal(tree.count, count);
  for (const row of source) {
    const entry = tree.entries[row.channelId]; assert(!Object.hasOwn(entry, 'memberName'));
    assert.deepEqual(verifyEntry(row.channelId, entry, tree), row);
  }
  assert(Buffer.byteLength(JSON.stringify(tree)) < 8 * 1024 * 1024);
});
test('등급·다른 채널·추가 필드·누락·위조 회원을 거부한다', () => {
  const tree = buildLookup([member(1), member(2), member(3)]), key = member(1).channelId, entry = tree.entries[key];
  for (const value of [{ ...entry, levelName: '위조' }, { ...entry, extra: true }, null]) {
    assert.throws(() => verifyEntry(key, value, tree), { code: 'CSV_WRITER_LOOKUP_INVALID' });
  }
  assert.throws(() => verifyEntry(member(4).channelId, entry, tree));
  assert.equal(verifyEntry(member(4).channelId, null, tree), null);
});
