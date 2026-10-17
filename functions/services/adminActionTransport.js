// 기존 관리자 API의 로컬 실행은 사용자 토큰만 고정 운영 진입점에 전달한다.
const BACKEND_URL = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net/adminHandleOperationRequest';
const VERSION_HEADER = 'X-YGO-Admin-Action';
const { ADMIN_OPERATIONS } = require('./adminOperationRegistry');
const OPERATIONS = new Set(ADMIN_OPERATIONS);

function localEnvironment(env) {
  return !!(env.FUNCTIONS_EMULATOR || env.FIREBASE_EMULATOR_HUB || env.FIRESTORE_EMULATOR_HOST
    || env.FIREBASE_STORAGE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || env.FIREBASE_DATABASE_EMULATOR_HOST);
}
function unavailable(res) {
  return res.status(503).json({ success: false, message: '운영 관리자 서버에 연결할 수 없습니다. 배포 상태를 확인해 주세요.' });
}

async function forwardAdminRequest(req, res, operation, { env = process.env, fetchImpl = fetch } = {}) {
  if (env.USER_PROFILE_WRITER_MODE === 'production' || env.USER_STORAGE_MODE === 'production') {
    res.set('Cache-Control', 'no-store');
    try {
      const binding = require('./userWriterSelection').selectProductionWriter({ env });
      if (['checkAdminAccess', 'manageNotice', 'manageAdminRole', 'uploadMembershipCsv'].includes(operation)) {
        await require('./adminWriterOperations').createWriterAdminOperations({ writerBinding: binding, auth: binding.auth, env,
          setCors: require('../utils/auth').setCors })[operation](req, res);
        return true;
      }
      // 카드 전용 작업은 기존 카드 handler를 사용한다. 사용자 저장 경로로 우회하지 않는다.
      return false;
    } catch (_) { unavailable(res); return true; }
  }
  if (env.USER_PROFILE_WRITER_MODE) { res.set('Cache-Control', 'no-store'); unavailable(res); return true; }
  if (!localEnvironment(env)) return false;
  res.set('Cache-Control', 'no-store');
  if (!OPERATIONS.has(operation)) { unavailable(res); return true; }
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) {
    res.status(401).json({ success: false }); return true;
  }
  if (!['GET', 'POST'].includes(req.method)) { res.status(405).json({ success: false }); return true; }
  const headers = { 'Content-Type': 'application/json', Authorization: authorization };
  if (typeof req.headers['x-firebase-appcheck'] === 'string') headers['X-Firebase-AppCheck'] = req.headers['x-firebase-appcheck'];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ['triggerAutoCrawl', 'rebuildCardNames'].includes(operation) ? 525000 : 25000);
  try {
    const response = await fetchImpl(BACKEND_URL, {
      method: 'POST', headers, redirect: 'error', signal: controller.signal,
      body: JSON.stringify({ operation, method: req.method, query: req.query || {}, body: req.body || {} }),
    });
    if (response.headers.get(VERSION_HEADER) !== '1' || !response.headers.get('content-type')?.includes('application/json')) {
      unavailable(res); return true;
    }
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) { unavailable(res); return true; }
    res.status(response.status).json(body);
  } catch (_) {
    // 인증정보를 포함할 수 있는 네트워크 오류 원문을 기록하지 않는다. 쓰기 요청은 재시도하지 않는다.
    unavailable(res);
  } finally { clearTimeout(timer); }
  return true;
}

function createAdminOperationRequestHandler(resolveHandler, { env = process.env, writerOperations } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const writer = !!env.USER_PROFILE_WRITER_MODE || env.USER_STORAGE_MODE === 'production';
    if (writer) {
      try {
        require('../config/userProfileWriter').resolveProfileWriterConfig(env);
        if (env.USER_PROFILE_WRITER_MODE === 'production') {
          const binding = require('./userWriterSelection').selectProductionWriter({ env });
          writerOperations = require('./adminWriterOperations').createWriterAdminOperations({ writerBinding: binding, auth: binding.auth, env,
            setCors: require('../utils/auth').setCors });
        }
        if (typeof writerOperations?.checkEnvironment !== 'function') throw Error('isolated dependencies required');
        writerOperations.checkEnvironment();
      } catch (_) { return unavailable(res); }
    } else if (writerOperations || localEnvironment(env)) return unavailable(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { operation, method, body, query } = req.body || {};
    if (!OPERATIONS.has(operation) || !['GET', 'POST'].includes(method)
        || !body || typeof body !== 'object' || Array.isArray(body)
        || !query || typeof query !== 'object' || Array.isArray(query)) {
      return res.status(400).json({ success: false });
    }
    const serviceWriter = writer && ['checkAdminAccess', 'manageNotice', 'manageAdminRole', 'uploadMembershipCsv'].includes(operation);
    if (writer && !serviceWriter && env.USER_PROFILE_WRITER_MODE !== 'production') return unavailable(res);
    const authorization = req.headers?.authorization;
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) return res.status(401).json({ success: false });
    const headers = { authorization };
    if (typeof req.headers['x-firebase-appcheck'] === 'string') headers['x-firebase-appcheck'] = req.headers['x-firebase-appcheck'];
    // 본문의 UID/role/headers는 인증정보로 사용하지 않는다.
    const forwarded = Object.create(req);
    Object.defineProperties(forwarded, {
      method: { value: method }, body: { value: body }, query: { value: query }, headers: { value: headers },
    });
    res.set(VERSION_HEADER, '1');
    try { return await (serviceWriter ? writerOperations[operation] : resolveHandler(operation))(forwarded, res); }
    catch (_) { return unavailable(res); }
  };
}

module.exports = { forwardAdminRequest, createAdminOperationRequestHandler, localEnvironment };
