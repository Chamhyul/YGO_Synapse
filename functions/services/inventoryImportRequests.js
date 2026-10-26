'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });
const digestImport = (source, body) => createHash('sha256').update(JSON.stringify([source,
  source === 'file' ? body?.data ?? null : [body?.spreadsheetId ?? null, body?.fingerprint ?? null]])).digest('hex');
function createInventoryImportRequests({ transition }) {
  const scope = new AsyncLocalStorage();
  function identity(uid, requestId, digest) {
    if (typeof uid !== 'string' || !uid || !/^[a-f0-9]{32}$/.test(requestId || '') || !/^[a-f0-9]{64}$/.test(digest || '')) {
      throw fail('IMPORT_REQUEST_INVALID', '가져오기 요청 식별자가 올바르지 않습니다.');
    }
    return { uid, digest, operationId: createHash('sha256').update(JSON.stringify(['inventory-import-v1', uid, requestId])).digest('hex').slice(0, 32) };
  }
  async function lookup(context) {
    const op = await transition.lookupOperation(context.operationId);
    if (!op) return { status: 'missing' };
    if (op.details?.importDigest !== context.digest || op.changes?.length !== 1 || op.changes[0].key !== `inventory/${context.uid}`) {
      throw fail('IMPORT_REQUEST_CONFLICT', '같은 가져오기 식별자로 다른 내용을 저장할 수 없습니다.');
    }
    if (op.status === 'completed') {
      if (op.result?.success !== true) throw fail('IMPORT_REQUEST_CONFLICT', '가져오기 완료 영수증을 확인하지 못했습니다.');
      return { status: 'completed', result: op.result };
    }
    return { status: op.status === 'cancelled' ? 'cancelled' : 'pending' };
  }
  return {
    current: uid => { const context = scope.getStore(); return context?.uid === uid ? context : null; },
    status: async (uid, requestId, digest) => lookup(identity(uid, requestId, digest)),
    async run(uid, requestId, digest, action) {
      const context = identity(uid, requestId, digest), before = await lookup(context);
      if (before.status === 'completed') return before.result;
      if (before.status !== 'missing') throw fail(before.status === 'cancelled' ? 'IMPORT_REQUEST_CANCELLED' : 'IMPORT_REQUEST_PENDING',
        before.status === 'cancelled' ? '이전 가져오기는 취소되었습니다. 새 시도로 다시 진행해 주세요.' : '이전 가져오기 저장 결과를 확인 중입니다. 새 작업으로 다시 제출하지 마세요.');
      try { return await scope.run(context, action); }
      catch (error) {
        // 같은 ID의 동시 요청·완료 뒤 응답 유실은 원래 결과를 재사용한다.
        // 실행/저장 미확정 기록은 자동 재실행·복구하지 않는다.
        const after = await lookup(context);
        if (after.status === 'completed') return after.result;
        if (after.status === 'pending') throw fail('IMPORT_REQUEST_PENDING', '이전 가져오기 저장 결과를 확인 중입니다. 새 작업으로 다시 제출하지 마세요.');
        if (after.status === 'cancelled') throw fail('IMPORT_REQUEST_CANCELLED', '이전 가져오기는 취소되었습니다. 새 시도로 다시 진행해 주세요.');
        throw error;
      }
    },
  };
}
module.exports = { createInventoryImportRequests, digestImport };
