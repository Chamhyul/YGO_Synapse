'use strict';
const { randomBytes } = require('node:crypto');
const { checkProfileKey } = require('./userProfileWriterAdapters');
const { createCustomClaimsStore } = require('./user-storage/customClaimsStore');
const { accountResource } = require('./user-storage/accountResource');
function createClaimsWriterStore({ transition, initialize, initializeMissing = true, database, timeoutMs, onAmbiguousWrite, writerLease = () => undefined }) {
  const native = createCustomClaimsStore({ database, timeoutMs, onAmbiguousWrite });
  const resources = uid => { const key = `fs/users/${uid}`; checkProfileKey(key); return [key, `inventory/${uid}`, accountResource(uid)].sort(); };
  return {
    inspect: uid => native.inspect(uid),
    observe: uid => native.observe(uid),
    isSettled: (uid, id) => transition.isExternalSettled(id, resources(uid)),
    async acquire(uid) {
      const locks = resources(uid), id = randomBytes(16).toString('hex'), initialized = await initialize();
      const parent = writerLease();
      await transition.beginExternal(parent?.writer || (initializeMissing ? await transition.route() : initialized), id, locks, { parentId: parent?.id });
      try { return await native.acquire(uid, { operationId: id }); }
      catch (error) {
        // BUSY는 Auth 제출 전 확인된 거부다. 그 외 저장 미확정은 전환 장벽을 유지한다.
        await transition.endExternal(id, error.code !== 'MEMBERSHIP_CLAIMS_BUSY'); throw error;
      }
    },
    async finish(uid, id, uncertain = false) {
      await native.finish(uid, id, uncertain);
      await transition.endExternal(id, uncertain);
    },
    async beginRecovery(uid, expectedId, { writersDrained = false } = {}) {
      const locks = resources(uid), id = randomBytes(16).toString('hex'); await initialize();
      // drain 상태와 같은 UID/이전 작업이 일치해야 한다. 별도 종료 확인을 대신하지 않는다.
      const reserved = await transition.recoverExternal(expectedId, id, locks, { writersDrained });
      // UID finish만 승인되고 journal 종료가 유실된 경우도 남은 공통 장벽 안에서 복구한다.
      try { return await native.beginRecovery(uid, expectedId, { writersDrained, operationId: reserved, allowIdle: true }); }
      catch (error) { await transition.endExternal(reserved, true); throw error; }
    },
  };
}
module.exports = { createClaimsWriterStore };
