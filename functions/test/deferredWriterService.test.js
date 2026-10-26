'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { deferredWriterService, deferredWriterAdapters } = require('../services/deferredWriterService');

test('선택 서비스의 lease 조회는 초기화하지 않고 실제 사용 후 같은 객체·문맥을 전달한다', () => {
  let created = 0;
  const actual = { marker: 'preserved', writerLease() { return this.lease; },
    start() { this.lease = { id: this.marker }; return this.lease; }, stop() { this.lease = undefined; } };
  const value = deferredWriterService(() => { created++; return actual; }, { passiveLease: true });
  assert.equal(value.writerLease(), undefined); assert.equal(created, 0);
  const lease = value.start(); assert.equal(value.writerLease(), lease); assert.equal(created, 1);
  value.stop(); assert.equal(value.writerLease(), undefined); assert.equal(value.marker, 'preserved');
});

test('양방향 어댑터는 첫 실제 사용 때 한 번만 생성하고 기존 메서드의 this와 오류를 보존한다', () => {
  let created = 0;
  const value = deferredWriterAdapters(() => { created++; return {
    legacy: { side: 'legacy', read() { return this.side; } },
    rtdb: { side: 'rtdb', read() { return this.side; }, write() { throw Object.assign(Error('synthetic'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' }); } },
  }; });
  assert(value.legacy && value.rtdb); assert.equal(created, 0);
  assert.equal(value.rtdb.read(), 'rtdb'); assert.equal(value.legacy.read(), 'legacy'); assert.equal(created, 1);
  assert.throws(() => value.rtdb.write(), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
});

test('생성 실패를 빈 구현이나 정상 결과로 바꾸지 않는다', () => {
  const value = deferredWriterService(() => { throw Object.assign(Error('synthetic'), { code: 'USER_STORAGE_CONFIG_INVALID' }); });
  assert.throws(() => value.read(), { code: 'USER_STORAGE_CONFIG_INVALID' });
});
