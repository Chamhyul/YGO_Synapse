// 로컬 저장소는 유지하고 공개 조회·로그인 확인만 고정 운영 API로 전달한다.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const BASE = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net';
const ALLOWED = new Set(['getPublicCardData', 'verifyUserIdentity', 'searchCardByImage']);
const isLocal = () => !!(process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB
  || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST
  || process.env.FIREBASE_AUTH_EMULATOR_HOST);
const withPublicReadRequest = handler => (req, res) => {
  if (isLocal() && (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST)) {
    return res.status(503).json({ success: false, message: '로컬 데이터 에뮬레이터가 필요합니다.' });
  }
  return context.run({ headers: req.headers || {}, pending: new Map() }, () => handler(req, res));
};
function failure(status = 503, code = "AUTH_VERIFICATION_UNAVAILABLE") {
  return Object.assign(new Error(status === 401 ? '유효한 앱·로그인 인증이 필요합니다.' : '운영 조회 서버에 연결할 수 없습니다.'), { status, code });
}
async function requestProduction(operation, body, { headers = context.getStore()?.headers, fetchImpl = fetch } = {}) {
  if (!ALLOWED.has(operation)) throw failure();
  const appCheck = headers?.['x-firebase-appcheck'];
  if (typeof appCheck !== 'string' || !appCheck || appCheck.length > 8192) throw failure(401, "APPCHECK_REQUIRED");
  const forwarded = { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': appCheck };
  if (operation === 'verifyUserIdentity') {
    if (typeof headers.authorization !== 'string' || !/^Bearer \S+$/.test(headers.authorization)) throw failure(401, "AUTH_INVALID");
    forwarded.Authorization = headers.authorization;
  }
  const store = context.getStore();
  const key = operation === 'getPublicCardData' ? JSON.stringify(body) : null;
  if (key && store?.pending.has(key)) return store.pending.get(key);
  const perform = async () => {
    try {
      const response = await fetchImpl(`${BASE}/${operation}`, { method: 'POST', redirect: 'error',
        headers: forwarded, body: JSON.stringify(body), signal: AbortSignal.timeout(operation === 'searchCardByImage' ? 55000 : 25000) });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const allowedCodes = ['AUTH_INVALID', 'APPCHECK_REQUIRED', 'APPCHECK_INVALID', 'APPCHECK_UNAVAILABLE'];
        const code = allowedCodes.includes(detail?.code) ? detail.code : 'AUTH_VERIFICATION_UNAVAILABLE';
        throw failure([400, 401, 403, 429].includes(response.status) ? response.status : 503, code);
      }
      if (!response.headers.get('content-type')?.includes('application/json')
          || (operation !== 'searchCardByImage' && response.headers.get('X-YGO-Public-Read') !== '1')) throw failure();
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.success !== true) throw failure();
      return result;
    } catch (error) { throw failure(error.status || 503, error.code || "AUTH_VERIFICATION_UNAVAILABLE"); }
  };
  const promise = perform();
  if (key && store) {
    store.pending.set(key, promise);
    promise.catch(() => store.pending.delete(key));
  }
  return promise;
}
module.exports = { isLocal, withPublicReadRequest, requestProduction };
