'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { withAuthenticationResult, publishAuthenticationResult, isAuthenticationResultRequest } = require('./authenticationResult');
const context = new AsyncLocalStorage();
const pending = () => ({ status: 'pending' });

// 첫 결과를 보낸 뒤에도 HTTP 실행을 유지해 기존 claims writer/기록 종료를 회수한다.
// 브라우저가 연결을 닫아도 작업을 취소하거나 미확정 쓰기를 재제출하지 않는다.
function withLoginMembershipResult(req, res, work) {
  return withAuthenticationResult(req, res, 'login', streamed => {
    if (!isAuthenticationResultRequest('login')) return work(streamed);
    const state = {};
    const response = new Proxy(streamed, { get(target, key) {
      if (key === 'json') return value => {
        state.result = value;
        return response;
      };
      if (['status', 'set', 'type'].includes(key)) return (...args) => { target[key](...args); return response; };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return context.run(state, async () => {
      let value;
      try { value = await work(response); }
      finally { await state.check?.checked; }
      if (state.result === undefined) return value;
      const data = state.result?.initialData || state.result;
      if (state.repair && state.result?.success === true && data?.success === true) {
        publishAuthenticationResult(state.result);
        const membershipClaims = await Promise.resolve().then(state.repair).catch(pending);
        await state.check.drain();
        // 종료 프레임에는 보유 정보 본문을 중복 전송하지 않는다.
        return membershipClaims?.status === 'synced'
          ? streamed.json({ success: true, membershipClaims }) : streamed.status(503).json({ success: false });
      }
      // 실패 응답도 HTTP 종료 뒤 쓰기를 남기지 않는다. 아직 제출하지 않은
      // repair는 실행하지 않으며 다음 명시 조회가 원래 동기화 경로를 사용한다.
      await state.check?.drain();
      return streamed.json(state.result);
    });
  });
}

function prepareLoginAccount({ uid, auth, read }) {
  const state = context.getStore();
  if (!state) return read();
  if (state.check) throw new Error('로그인 검증은 요청당 한 계정만 사용합니다.');
  state.uid = uid;
  state.check = require('./membershipClaims').beginLoginMembershipCheck(uid, { auth, readAccount: read });
  return state.check.account;
}

// HTTP 입력을 받지 않는다. 인증·가입이 끝난 전체 데이터 처리만 호출한다.
async function readLoginClaims(uid) {
  const state = context.getStore();
  if (!state?.check || state.uid !== uid) return require('./membershipClaims').syncMembershipClaims(uid);
  const result = await state.check.checked;
  if (result.repair) {
    state.repair ||= result.repair;
    return pending();
  }
  return result.claims;
}

module.exports = { withLoginMembershipResult, prepareLoginAccount, readLoginClaims };
