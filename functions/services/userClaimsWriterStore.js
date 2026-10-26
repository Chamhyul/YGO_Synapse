'use strict';
const { randomBytes } = require('node:crypto');
const { checkProfileKey } = require('./userProfileWriterAdapters');
const { createCustomClaimsStore } = require('./user-storage/customClaimsStore');
const { accountResource } = require('./user-storage/accountResource');
function createClaimsWriterStore({ transition, initialize, initializeMissing = true, database, timeoutMs, onAmbiguousWrite, writerLease = () => undefined }) {
  const native = createCustomClaimsStore({ database, timeoutMs, onAmbiguousWrite });
  const resources = uid => { const key = `fs/users/${uid}`; checkProfileKey(key); return [key, `inventory/${uid}`, accountResource(uid)].sort(); };
  return {
    withSession: action => native.withSession(action),
    inspect: uid => native.inspect(uid),
    observe: uid => native.observe(uid),
    isSettled: (uid, id) => transition.isExternalSettled(id, resources(uid)),
    async acquire(uid, { backend } = {}) {
      const locks = resources(uid), id = randomBytes(16).toString('hex'), parent = writerLease();
      // 기존 부모가 있으면 beginExternal의 서버 CAS가 부모/epoch/자원을 다시 검증한다.
      const initialized = parent ? undefined : await initialize();
      const writer = parent?.writer || (initializeMissing ? await transition.route() : initialized);
      // legacy 복구 선택 뒤 RTDB로 전환됐다면 조회가 새 Auth writer로 바뀌지 않는다.
      // 이후 전환 경합은 기존 beginExternal CAS가 같은 backend/epoch를 다시 검사한다.
      if (backend !== undefined && writer.backend !== backend) throw Object.assign(new Error('claims 저장소가 변경되었습니다.'), { code: 'WRITER_FENCED' });
      await transition.beginExternal(writer, id, locks, { parentId: parent?.id });
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
