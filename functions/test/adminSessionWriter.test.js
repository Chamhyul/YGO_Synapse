'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSessionKey, checkSessionCommand } = require('../services/adminSessionWriterAdapters');
const { checkCommitReceipt } = require('../services/user-storage/recordStore');
test('세션 공통 키/명령은 cookie 원문과 알 수 없는 필드를 거부한다', () => {
  assert.equal(checkSessionKey('session/' + 'a'.repeat(64)), 'a'.repeat(64));
  for (const key of ['session/cookie', 'fs/users/admin', 'session/' + 'a'.repeat(63)]) assert.throws(() => checkSessionKey(key));
  const entry = { key: 'session/' + 'a'.repeat(64), exists: true, token: '0', value: { uid: 'synthetic', lastActivity: 1, expiresAt: 2 } };
  assert.deepEqual(checkSessionCommand({ changes: [entry], details: { kind: 'session', action: 'set' } }), entry);
  assert.throws(() => checkSessionCommand({ changes: [entry], details: { kind: 'session', action: 'remove' } }));
  assert.throws(() => checkSessionCommand({ changes: [{ ...entry, value: { ...entry.value, cookie: 'synthetic-only' } }], details: { kind: 'session', action: 'set' } }));
});
test('단일 head의 취소 사유는 취소 영수증만 허용하고 원본 필드를 엄격히 검사한다', () => {
  const proof = { id: 'a'.repeat(32), digest: 'b'.repeat(64), outcome: 'cancelled', revision: 2, generation: 0 };
  for (const reason of ['conflict', 'inactive', 'fenced']) assert.equal(checkCommitReceipt({ ...proof, reason }, 2, 0), true);
  for (const value of [{ ...proof, reason: 'other' }, { ...proof, reason: 'conflict', outcome: 'committed' }, { ...proof, extra: true }, { ...proof, revision: 3 }]) assert.equal(checkCommitReceipt(value, 2, 0), false);
});
