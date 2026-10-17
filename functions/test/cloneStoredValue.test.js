
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { cloneStoredValue } = require('../services/user-storage/cloneStoredValue');
const { Timestamp } = require('firebase-admin/firestore');
test('저장 값 사본은 특수키·희소 배열·별도 원형 setter·시간 정밀도와 소유권을 보존한다', () => {
  let calls = 0;
  const prototype = { set danger(_) { calls++; } }, special = Object.create(prototype);
  Object.defineProperty(special, 'danger', { value: { safe: true }, enumerable: true });
  const raw = Object.create(null);
  raw.value = JSON.parse('{"__proto__":{"preserved":true},"constructor":[],"toString":0}');
  raw.holes = [new Timestamp(1700000000, 123), new Date(1), -0, , null];
  raw.special = special;
  const copy = cloneStoredValue(raw);
  assert.deepEqual(copy, raw); assert.equal(calls, 0); assert.equal({}.preserved, undefined);
  assert.equal(Object.getPrototypeOf(copy), null); assert.equal(3 in copy.holes, false);
  assert.equal(Object.is(copy.holes[2], -0), true);
  copy.value.__proto__.preserved = false; copy.special.danger.safe = false;
  assert.equal(raw.value.__proto__.preserved, true); assert.equal(raw.special.danger.safe, true);
});
