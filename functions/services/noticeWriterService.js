'use strict';
const { randomBytes } = require('node:crypto');
const { createNoticeService, createStorageNoticeStore } = require('./noticeService');
const fail = code => Object.assign(new Error('공지 저장 결과를 확인하지 못했습니다. 현재 목록과 이전 writer 종료 상태를 확인해 주세요.'), { code, status: 503 });
function createNoticeWriterService({ requests, transition, bucket, storage = createStorageNoticeStore(bucket), parentLease,
  timeoutMs = 10000, now = Date.now }) {
  async function bounded(action) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('NOTICE_STORAGE_TIMEOUT')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  const guarded = {
    read: () => bounded(() => storage.read()),
    async write(value, revision) {
      const context = requests.publicationLease(); if (!context || context.uncertain) throw fail('NOTICE_WRITER_LEASE_REQUIRED');
      let submitted = false;
      try { return await bounded(() => { submitted = true; return storage.write(value, revision); }); }
      catch (error) {
        // 412는 서버가 확정한 generation 충돌이다. 다른 오류/시간초과를 미반영으로 추측하지 않는다.
        context.uncertain = submitted && Number(error.code) !== 412; throw error;
      }
    },
  };
  const service = createNoticeService({ storage: guarded, now, environment: 'local',
    runLocked: action => requests.withPublication(action, parentLease?.()) });
  return { ...service,
    async recoverPublication(expectedId, { writersDrained = false } = {}) {
      const recoveryId = await transition.recoverExternal(expectedId, randomBytes(16).toString('hex'), ['notice/publication'], { writersDrained });
      try {
        // 종료 확인 뒤의 현재 파일 대조다. 파일 일치/시각으로 이전 RPC의 종료·성공을 추정하지 않는다.
        const result = await service.list();
        await transition.endExternal(recoveryId);
        return { revision: result.revision, count: result.notices.length, outcome: 'current-state-only' };
      } catch (error) { await transition.endExternal(recoveryId, true); throw error; }
    },
  };
}
module.exports = { createNoticeWriterService };
