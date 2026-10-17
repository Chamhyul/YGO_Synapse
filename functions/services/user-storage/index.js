'use strict';

const { createUserStorageConnection, createConfiguredUserStorageConnection } = require('../../config/userStorage');
const { createProfileStore } = require('./profileStore');
const { createPartitionedInventoryStore } = require('./partitionedInventoryStore');
const { createAdminSessionStore } = require('./adminSessionStore');
const { createApiAccessStore } = require('./apiAccessStore');
const { createMembershipStore } = require('./membershipStore');
const { createMembershipCsvStore } = require('./membershipCsvStore');
const { createCustomClaimsStore } = require('./customClaimsStore');

// 준비 단계의 명시적 진입점. 기존 라우트에 자동으로 연결하지 않는다.
function createStorage(connection, { timeoutMs, maxAttempts, prepareInventory, prepareCards, now } = {}) {
  let state = 'open';
  function ensureOpen() {
    if (state !== 'open') throw Object.assign(new Error(state === 'ambiguous'
      ? '저장 결과가 불명확합니다. 새 연결로 반영 여부를 대조해 주세요.'
      : '종료된 사용자 저장소 연결입니다.'), {
      code: state === 'ambiguous' ? 'USER_STORAGE_WRITE_AMBIGUOUS' : 'USER_STORAGE_CONNECTION_CLOSED',
    });
  }
  const options = {
    database: connection.database, timeoutMs, maxAttempts,
    onAmbiguousWrite: () => {
      state = 'ambiguous';
      return connection.close();
    },
  };
  const wrap = store => Object.fromEntries(Object.entries(store).map(([name, method]) => [name, async (...args) => {
    ensureOpen();
    const result = await method(...args);
    ensureOpen();
    return result;
  }]));
  let profile, inventory, adminSessions, apiAccess, membership, membershipCsv, customClaims;
  try {
    profile = wrap(createProfileStore(options));
    inventory = wrap(createPartitionedInventoryStore({ ...options, prepare: prepareInventory, prepareCards, now }));
    adminSessions = wrap(createAdminSessionStore(options));
    apiAccess = wrap(createApiAccessStore(options));
    membership = wrap(createMembershipStore({ ...options, now }));
    membershipCsv = wrap(createMembershipCsvStore({ ...options, now }));
    customClaims = wrap(createCustomClaimsStore(options));
  } catch (error) {
    connection.close().catch(() => {});
    throw error;
  }
  return {
    config: connection.config, profile, inventory, adminSessions, apiAccess, membership, membershipCsv, customClaims,
    close() {
      if (state === 'open') state = 'closed';
      return connection.close();
    },
  };
}

function createEmulatorUserStorage(options) { return createStorage(createUserStorageConnection(), options); }
function createConfiguredUserStorage(options) { return createStorage(createConfiguredUserStorageConnection(), options); }

module.exports = { createEmulatorUserStorage, createConfiguredUserStorage };
