'use strict';

const { randomBytes } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual: same } = require('node:util');
const { createRecordStore } = require('./recordStore');
const failure = code => Object.assign(new Error('계정 권한 동기화 상태를 확인해야 합니다.'), { code });

// Auth의 claims 교체 API에는 CAS가 없다. 같은 UID의 앱 내 writer는 이 기록으로 직렬화한다.
// 응답 미확정 작업은 자동 만료시키지 않는다. 늦은 Auth 쓰기와 새 권한 변경의 역전을 막는다.
function createCustomClaimsStore(options = {}) {
  const records = createRecordStore({ ...options, path: 'customClaimsSync' });
  const sessions = new AsyncLocalStorage();
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
    withSession(action) {
      return sessions.getStore() ? action() : sessions.run(new Map(), () => records.withSession(action));
    },
    async observe(uid) {
      const record = await records.read(uid); check(record.value);
      return { revision: record.revision, generation: record.generation, value: record.value };
    },
    async inspect(uid) { const record = await records.read(uid); check(record.value); return record.value; },
    async acquire(uid, { operationId = randomBytes(16).toString('hex') } = {}) {
      if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) throw failure('MEMBERSHIP_CLAIMS_INVALID');
      const startedAt = Date.now();
      sessions.getStore()?.delete(uid);
      const saved = await records.update(uid, value => {
        check(value);
        if (value && value.state !== 'idle') throw failure('MEMBERSHIP_CLAIMS_BUSY');
        return { value: { state: 'running', operationId, startedAt } };
      });
      // 서버가 승인한 잠금만 이 요청의 종료 CAS에 재사용한다. 요청 밖 캐시는 없다.
      sessions.getStore()?.set(uid, saved.record);
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
      const finish = value => {
        check(value);
        if (!value || value.operationId !== operationId || value.state !== 'running') throw failure('MEMBERSHIP_CLAIMS_BUSY');
        return { value: { ...value, state: uncertain ? 'uncertain' : 'idle' } };
      };
      const saved = sessions.getStore()?.get(uid);
      sessions.getStore()?.delete(uid);
      if (saved?.value?.operationId === operationId) {
        try {
          await records.compareAndSet(uid, saved.revision, finish(saved.value).value, {
            validateCurrent(current) {
              if (current.generation !== saved.generation || !same(current.value, saved.value)) throw failure('USER_STORAGE_CONFLICT');
              finish(current.value);
            },
          });
          return;
        } catch (error) {
          // 확정 충돌만 fresh 재조회한다. 미확정 쓰기·시간초과는 재제출하지 않는다.
          if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
        }
      }
      await records.update(uid, finish);
    },
  };
}
module.exports = { createCustomClaimsStore };
