'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { downloadUSD } = require('../../integration/user-migration/measure-retention.cjs');
test('월 총10GB여도 일부 날에 집중되면 일별 무료량을 이월하지 않는다', () => {
  assert.equal(downloadUSD(Array(30).fill(1e9 / 3)), 0);
  assert.ok(Math.abs(downloadUSD([...Array(20).fill(0), ...Array(10).fill(1e9)]) - 6.4) < 1e-9);
});
test('비용 측정 단위는 일별 bytes와 decimal GB이며 잘못된 수치로 무료를 판정하지 않는다', () => {
  assert.equal(downloadUSD([360000000]), 0); assert.ok(Math.abs(downloadUSD([1360000000]) - 1) < 1e-9);
  for (const values of [[-1], [NaN], [Infinity], undefined]) assert.throws(() => downloadUSD(values));
});
