'use strict';
const { measure } = require('./inventoryRequestTiming');

// HTTP 입력·요청 간 캐시가 아닌, 한 로그인 요청의 서버 내부 읽기다.
// 실패/미지원은 인증 후 기존 조회로 복귀하며 선행 읽기에서 복구하지 않는다.
function createLoginInventoryRead(read) {
  let owner, task, checked = false, accepted;
  let resolveAuthorization;
  const authorization = new Promise(resolve => { resolveAuthorization = resolve; });
  return {
    start(uid) {
      if (task || checked) return;
      owner = uid;
      task = Promise.resolve().then(() => measure('login.inventory_prefetch', () => read(uid,
        () => measure('login.inventory_authorization_wait', async () => await authorization === uid))))
        .then(value => ({ value }), () => ({}));
    },
    authorize(uid) {
      if (checked) throw new Error('로그인 계정 검사는 요청당 한 번만 완료합니다.');
      checked = true;
      accepted = uid;
      resolveAuthorization(uid);
    },
    async result(uid) {
      if (!checked || accepted !== uid || task && owner !== uid) throw new Error('로그인 읽기의 계정이 일치하지 않습니다.');
      return (await task)?.value;
    },
    async close() {
      if (!checked) { checked = true; resolveAuthorization(null); }
      await task;
      owner = accepted = task = undefined;
    },
  };
}

module.exports = { createLoginInventoryRead };
