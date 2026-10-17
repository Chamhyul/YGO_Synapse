'use strict';

const { randomBytes } = require('node:crypto');
const { createRecordStore } = require('./recordStore');
const failure = code => Object.assign(new Error('계정 권한 동기화 상태를 확인해야 합니다.'), { code });

// Auth의 claims 교체 API에는 CAS가 없다. 같은 UID의 앱 내 writer는 이 기록으로 직렬화한다.
// 응답 미확정 작업은 자동 만료시키지 않는다. 늦은 Auth 쓰기와 새 권한 변경의 역전을 막는다.
function createCustomClaimsStore(options = {}) {
  const records = createRecordStore({ ...options, path: 'customClaimsSync' });
  function check(value) {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['idle', 'running', 'uncertain'].includes(value.state)
        || typeof value.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(value.operationId)
        || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
        || (value.recoveryOf !== undefined && (typeof value.recoveryOf !== 'string' || !/^[a-f0-9]{32}$/.test(value.recoveryOf)))
        || Object.keys(value).some(key => !['state', 'operationId', 'startedAt', 'recoveryOf'].includes(key))) {
      throw failure('MEMBERSHIP_CLAIMS_INVALID_RECORD');
    }
  }
  return {
    async observe(uid) {
      const record = await records.read(uid); check(record.value);
      return { revision: record.revision, generation: record.generation, value: record.value };
    },
    async inspect(uid) { const record = await records.read(uid); check(record.value); return record.value; },
    async acquire(uid, { operationId = randomBytes(16).toString('hex') } = {}) {
      if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) throw failure('MEMBERSHIP_CLAIMS_INVALID');
      const startedAt = Date.now();
      await records.update(uid, value => {
        check(value);
        if (value && value.state !== 'idle') throw failure('MEMBERSHIP_CLAIMS_BUSY');
        return { value: { state: 'running', operationId, startedAt } };
      });
      return operationId;
    },
    async beginRecovery(uid, expectedOperationId, { writersDrained = false, operationId = randomBytes(16).toString('hex'), allowIdle = false } = {}) {
      // CAS는 이전 Auth 요청을 취소하지 못한다. 이전 writer/요청 종료를 확인한 뒤 사용한다.
      if (writersDrained !== true || typeof expectedOperationId !== 'string' || !/^[a-f0-9]{32}$/.test(expectedOperationId)) {
        throw failure('MEMBERSHIP_CLAIMS_RECOVERY_CONFIRMATION_REQUIRED');
      }
      if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId) || operationId === expectedOperationId) throw failure('MEMBERSHIP_CLAIMS_INVALID');
      const startedAt = Date.now();
      await records.update(uid, value => {
        check(value);
        if (value?.operationId === operationId && value.recoveryOf === expectedOperationId && ['running', 'uncertain'].includes(value.state)) {
          return { value: { ...value, state: 'running' } };
        }
        if (!value || value.operationId !== expectedOperationId || !['running', 'uncertain', ...(allowIdle === true ? ['idle'] : [])].includes(value.state)) {
          throw failure('MEMBERSHIP_CLAIMS_RECOVERY_CONFLICT');
        }
        return { value: { state: 'running', operationId, startedAt, recoveryOf: expectedOperationId } };
      });
      return operationId;
    },
    async finish(uid, operationId, uncertain = false) {
      await records.update(uid, value => {
        check(value);
        if (!value || value.operationId !== operationId || value.state !== 'running') throw failure('MEMBERSHIP_CLAIMS_BUSY');
        return { value: { ...value, state: uncertain ? 'uncertain' : 'idle' } };
      });
    },
  };
}
module.exports = { createCustomClaimsStore };
