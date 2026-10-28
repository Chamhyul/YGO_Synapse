const { onRequest: firebaseOnRequest } = require('firebase-functions/v2/https');
const { setCors, verifyUser, verifyAppCheck } = require('../utils/auth');
const { safeErrorSummary } = require('../utils/safeError');
const { isRegisteredUser, readRegistrationProfile, completeUserRegistration } = require('../services/registrationService');
const { measure, withLoginRequestTiming } = require('../services/inventoryRequestTiming');
const { withWriterRequestScope, rememberInitialWriterRoute } = require('../services/initialWriterRoute');
const onRequest = (options, handler) => firebaseOnRequest(options,
  (req, res) => withWriterRequestScope(() => req.method === 'GET' && req.query?.includeUserData === 'true'
    && req.query?.loginMembershipResult === 'true'
    ? require('../services/loginMembershipResult').withLoginMembershipResult(req, res, response => handler(req, response))
    : handler(req, res)));

// 공개 문서의 SHA-256. 문서를 변경할 때 이 버전도 함께 갱신한다.
const CONSENT_VERSIONS = Object.freeze({
  terms: 'a189fde0dce4ec14f7ae6b8b495674e42b455f1d453d785084ffd5a083dca7ca',
  privacy: '227208e70b6de548fd8e081b50a0b01dd2adc6537d3c8d05fa80e60879ada2e8',
});

async function prepare(req, res, method, { onIdentity } = {}) {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return null; }
  if (process.env.USER_PROFILE_WRITER_MODE || process.env.USER_STORAGE_MODE === 'production') {
    try {
      if (require('../config/userProfileWriter').resolveProfileWriterConfig().mode !== 'production') throw Error('test only');
      const binding = measure('login.binding', () => require('../services/userWriterSelection').selectProductionWriter());
      const route = await measure('storage.initialize', () => binding.initialize());
      rememberInitialWriterRoute(binding.transition, route);
    } catch (_) {
      res.status(503).json({ success: false, code: 'USER_STORAGE_FEATURE_UNAVAILABLE', message: '이 환경에서는 사용자 저장소에 접근할 수 없습니다.' });
      return null;
    }
  }
  if (req.method !== method) { res.status(405).json({ success: false, message: `${method} 요청을 사용하세요.` }); return null; }
  if (!(await verifyAppCheck(req, res))) return null;
  return measure('auth.verify', () => verifyUser(req, res, {
    includeAccountRole: req.query?.includeUserData === 'true' || req.query?.includeAccountData === 'true', onIdentity,
    ...(req.query?.includeUserData === 'true' && req.query?.loginMembershipResult === 'true'
      && process.env.USER_STORAGE_BACKEND === 'rtdb'
      ? { accountWindow: value => require('../services/loginMembershipResult').prepareLoginAccount(value) } : {}),
  }));
}

exports.getRegistrationStatus = onRequest({ invoker: 'public' }, withLoginRequestTiming('getRegistrationStatus', async (req, res) => {
  const includeUserData = req.query?.includeUserData === 'true';
  const includeAccountData = !includeUserData && req.query?.includeAccountData === 'true';
  const inventoryRead = includeUserData && process.env.USER_STORAGE_BACKEND === 'rtdb'
    && (process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production')
    && !require('../services/publicReadTransport').isLocal()
    ? require('../services/loginInventoryRead').createLoginInventoryRead((uid, beforeFinalRead) =>
      require('../utils/inventoryStorage').readLoginInventory(uid, beforeFinalRead)) : null;
  let registrationTask, registrationUid;
  const readRegistration = uid => {
    if (registrationTask && registrationUid !== uid) throw new Error('가입 확인의 계정이 일치하지 않습니다.');
    registrationUid = uid;
    // 서명 검증으로 얻은 UID만 사용한다. 현재 계정 조회와 겹치되 읽기 오류는
    // 인증 오류로 바꾸지 않고 기존 가입 조회 실패 응답에서 처리한다.
    return registrationTask ||= Promise.resolve().then(() => measure('registration.check', () =>
      includeUserData || includeAccountData ? readRegistrationProfile(uid)
        : isRegisteredUser(uid).then(registered => ({ registered }))))
      .then(value => {
        if (value.registered) inventoryRead?.start(uid);
        return { value };
      }, error => ({ error }));
  };
  try {
    const uid = await prepare(req, res, 'GET', { onIdentity: readRegistration });
    inventoryRead?.authorize(uid || null);
    if (!uid) {
      // 인증 실패 시 선행 결과를 버리고 시작한 읽기를 회수한다. 전체 조회·쓰기는 시작하지 않는다.
      if (registrationTask) await registrationTask;
      return;
    }
    try {
      // 로컬 운영 인증 프록시·구형 주입 의존성은 UID 확인 뒤 기존 순서로 읽는다.
      const checked = await readRegistration(uid);
      if (checked.error) throw checked.error;
      const registration = checked.value;
      const { registered } = registration;
      const result = { success: true, registered, consentVersions: CONSENT_VERSIONS };
      if (registered && includeAccountData) {
        result.initialAccount = await require('../services/loginUserData').readLoginAccountData(req, uid,
          { initialProfile: registration.profile });
      }
      // 기존 호출은 동일 응답을 유지한다. 미가입 계정에는 사용자 본문을 조회하지 않는다.
      if (registered && includeUserData) {
        try {
          result.initialData = await require('../services/loginUserData').readLoginUserData(req, uid,
            { initialProfile: registration.profile,
              ...(inventoryRead ? { readPreparedInventory: () => inventoryRead.result(uid) } : {}),
              ...(req.query?.loginMembershipResult === 'true' ? { readMembershipClaims:
                require('../services/loginMembershipResult').readLoginClaims } : {}) });
        } catch (error) {
          // 가입 판정과 본문 장애를 구분하고 자동 중복 조회/claims 쓰기를 피한다.
          console.error('Initial user data failed:', safeErrorSummary(error));
          result.initialData = { success: false, code: error.code === 'ACCOUNT_ROLE_UNAVAILABLE'
            ? error.code : 'INITIAL_USER_DATA_UNAVAILABLE', message: '회원 정보를 불러오지 못했습니다. 다시 시도해 주세요.' };
        }
      }
      return measure('login.response', () => res.json(result));
    } catch (error) {
      console.error('Registration status failed:', safeErrorSummary(error));
      return res.status(503).json({ success: false, message: '가입 상태를 확인하지 못했습니다. 다시 시도해 주세요.' });
    }
  } finally { await inventoryRead?.close(); }
}));

exports.completeRegistration = onRequest({ invoker: 'public' }, async (req, res) => {
  const uid = await prepare(req, res, 'POST');
  if (!uid) return;
  const { agreements, consentVersions } = req.body || {};
  if (agreements?.terms !== true || agreements?.privacy !== true) {
    return res.status(400).json({ success: false, message: '이용 약관과 개인정보 처리방침에 모두 동의해 주세요.' });
  }
  if (consentVersions?.terms !== CONSENT_VERSIONS.terms || consentVersions?.privacy !== CONSENT_VERSIONS.privacy) {
    return res.status(409).json({ success: false, code: 'CONSENT_VERSION_CHANGED', message: '문서가 변경되었습니다. 동의 화면을 다시 열어 주세요.' });
  }
  try {
    // 기존 데이터·가입일·동의 기록을 덮어쓰지 않는다. 재요청도 같은 결과를 반환한다.
    await completeUserRegistration(uid, CONSENT_VERSIONS);
    return res.json({ success: true, registered: true });
  } catch (error) {
    console.error('Registration completion failed:', safeErrorSummary(error));
    return res.status(503).json({ success: false, message: '가입을 완료하지 못했습니다. 다시 시도해 주세요.' });
  }
});
