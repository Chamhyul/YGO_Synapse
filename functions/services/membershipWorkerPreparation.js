'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// 배포 대상은 클라이언트·요청·환경변수에서 받지 않는다. 다른 서비스로 토큰을 보내지 않는다.
const WORKER_URL = 'https://syncmembershipclaimsafterprofile-e4pt3uwcya-as.a.run.app';
const TYPE = 'com.ygo-synapse.membership.prepare.v1';
const SOURCE = 'urn:ygo-synapse:membership-preparation';
const isManagedMembershipWorker = env => !!(env.K_SERVICE && env.K_REVISION
  && env.FUNCTION_TARGET === 'syncMembershipClaimsAfterProfile'
  && !Object.entries(env).some(([key, value]) => key.includes('EMULATOR') && value));
const allowedCaller = env => env.GCLOUD_PROJECT === 'ygo-synapse'
  && env.USER_STORAGE_MODE === 'production' && env.K_SERVICE && env.K_REVISION
  && env.FUNCTION_TARGET === 'getUserData'
  && !Object.entries(env).some(([key, value]) => key.includes('EMULATOR') && value);

function createMembershipWorkerPreparation({ env = process.env, fetchImpl = fetch, identity,
  now = () => performance.now(), timeoutMs = 4000, cooldownMs = 60000 } = {}) {
  let client, pending, deadline = -Infinity;
  const token = identity || (async () => {
    client ||= await new (require('google-auth-library').GoogleAuth)().getIdTokenClient(WORKER_URL);
    const headers = await client.getRequestHeaders();
    const authorization = headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw Error('identity unavailable');
    return authorization;
  });
  return function prepare() {
    if (!allowedCaller(env)) return Promise.resolve({ status: 'unavailable' });
    if (pending) return pending;
    if (now() < deadline) return Promise.resolve({ status: 'throttled' });
    deadline = now() + cooldownMs;
    const controller = new AbortController();
    let timer;
    pending = Promise.race([(async () => {
      const authorization = await token();
      // 토큰 준비가 시간제한을 넘겼다면 늦은 요청을 전송하지 않는다.
      if (controller.signal.aborted) return { status: 'unavailable' };
      const response = await fetchImpl(WORKER_URL, { method: 'POST', redirect: 'error',
        signal: controller.signal, headers: { Authorization: authorization,
          'Content-Type': 'application/json', 'ce-specversion': '1.0',
          'ce-type': TYPE, 'ce-source': SOURCE, 'ce-id': randomUUID() },
        body: JSON.stringify({ version: 1 }) });
      // Functions Framework는 CloudEvent handler의 정상 완료에204를 반환한다.
      // 준비 응답은 권한 증명이나 실제 이벤트의 인스턴스 배정 보장이 아니다.
      const status = response.status === 204 ? 'delivered' : 'unavailable';
      await response.body?.cancel();
      return { status };
    })(), new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ status: 'unavailable' }); }, timeoutMs);
    })]).catch(() => ({ status: 'unavailable' })).finally(() => {
      clearTimeout(timer); pending = undefined;
    });
    return pending;
  };
}

// 기존 DB 이벤트 변환 전에 별도 타입의 무자료 준비 신호만 받는다.
// 서비스는 기존 Cloud Run IAM을 계속 요구한다. 공개 invoker·새 DB 경로는 만들지 않는다.
function withMembershipWorkerPreparation(worker, { select, env = process.env,
  emit = value => console.log(JSON.stringify(value)) } = {}) {
  const wrapped = async event => {
    if (typeof event?.type !== 'string' || !event.type.startsWith('com.ygo-synapse.membership.prepare')) {
      return worker(event);
    }
    if (event.type !== TYPE || event.source !== SOURCE || event.specversion !== '1.0'
        || typeof event.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.id)
        || !event.data || Array.isArray(event.data) || event.data.version !== 1
        || Object.keys(event.data).length !== 1
        || !isManagedMembershipWorker(env)) {
      throw Object.assign(new Error('worker 준비 신호 형식이 올바르지 않습니다.'),
        { code: 'MEMBERSHIP_WORKER_PREPARATION_INVALID' });
    }
    const runtime = select();
    if (runtime?.config?.mode !== 'production' || !runtime.storage?.writerTransition) {
      throw Object.assign(new Error('worker 준비 구성을 확인하지 못했습니다.'),
        { code: 'MEMBERSHIP_WORKER_PREPARATION_INVALID' });
    }
    // route/Auth/원본 조회·잠금·claims 저장·완료 기록은 전혀 실행하지 않는다.
    try { emit({ event: 'membership_worker_preparation', version: 1, status: 'prepared' }); } catch (_) {}
  };
  // SDK의 export·배포 메타정보와 실제 DB 이벤트의 run 계약을 그대로 보존한다.
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(worker));
  return wrapped;
}
let preparation;
function prepareMembershipWorker() {
  preparation ||= createMembershipWorkerPreparation();
  return preparation();
}
module.exports = { createMembershipWorkerPreparation, withMembershipWorkerPreparation,
  prepareMembershipWorker, isManagedMembershipWorker, WORKER_URL, TYPE, SOURCE };
