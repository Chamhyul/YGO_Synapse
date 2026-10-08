const { admin } = require("../config/firebase");
const { safeErrorSummary } = require("./safeError");
const { requestProduction, isLocal } = require("../services/publicReadTransport");

// Firebase App Check 토큰 파싱 및 검증 헬퍼
async function verifyAppCheck(req, res) {
  try {
    // 로컬 에뮬레이터 환경에서는 App Check 검증 건너뜀
    if (process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB) {
      return true;
    }

    const appCheckToken = req.headers["x-firebase-appcheck"];
    if (!appCheckToken) {
      if (!res.headersSent) {
        res.status(401).json({ success: false, code: "APPCHECK_REQUIRED", message: "앱 인증 정보가 필요합니다." });
      }
      return false;
    }

    if (typeof admin.appCheck !== "function") throw new Error("App Check 검증을 사용할 수 없습니다.");

    try {
      await admin.appCheck().verifyToken(appCheckToken);
      return true;
    } catch (tokenErr) {
      console.warn("AppCheck token verification failed:", safeErrorSummary(tokenErr));
      if (!res.headersSent) {
        const invalid = ['app-check/invalid-argument', 'app-check/app-check-token-expired'].includes(tokenErr.code);
        res.status(invalid ? 401 : 503).json({ success: false,
          code: invalid ? 'APPCHECK_INVALID' : 'APPCHECK_UNAVAILABLE', message: '앱 인증 정보를 확인하지 못했습니다.' });
      }
      return false;
    }
  } catch (err) {
    console.error("AppCheck general error:", safeErrorSummary(err));
    if (!res.headersSent) {
      res.status(503).json({ success: false, code: "APPCHECK_UNAVAILABLE", message: "앱 인증을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." });
    }
    return false;
  }
}

// Firebase Auth 토큰 파싱 및 검증 헬퍼
const verifiedAccountRoles = new WeakMap();
async function verifyUser(req, res, { includeAccountRole = false } = {}) {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string' || !/^Bearer \S+$/.test(authHeader)) {
    res.status(401).json({ success: false, code: "AUTH_INVALID", message: "로그인 정보가 필요합니다." });
    return null;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Object.assign(new Error('실제 Firebase Auth가 필요합니다.'), { code: 'AUTH_INVALID' });
    if (isLocal()) {
      if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
        throw Object.assign(new Error('로컬 데이터 에뮬레이터가 필요합니다.'), { status: 503 });
      }
      const result = await requestProduction("verifyUserIdentity", includeAccountRole ? { includeAccountRole: true } : {}, { headers: req.headers });
      if (typeof result.uid !== "string" || !result.uid || result.uid.includes("/") || result.uid.length > 128) throw new Error("유효한 사용자가 없습니다.");
      if (includeAccountRole) {
        if (result.accountRoleVersion !== 1 || !['owner', 'admin', 'none'].includes(result.accountRole)) throw new Error('현재 계정 권한 응답이 필요합니다.');
        verifiedAccountRoles.set(req, { uid: result.uid, role: result.accountRole });
      }
      return result.uid;
    }
    const auth = admin.auth();
    // SDK가 서명·유효기간·발급 프로젝트 및 철회·비활성 상태를 확인한다.
    const decodedToken = await auth.verifyIdToken(idToken, true);
    if (typeof decodedToken.uid !== 'string' || !decodedToken.uid) throw Object.assign(new Error('유효한 사용자가 없습니다.'), { code: 'AUTH_INVALID' });
    return decodedToken.uid;
  } catch (err) {
    console.error("Token verification failed:", safeErrorSummary(err));
    const invalidTokenCodes = ['AUTH_INVALID', 'auth/argument-error', 'auth/invalid-argument',
      'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked',
      'auth/user-disabled', 'auth/user-not-found'];
    const invalid = invalidTokenCodes.includes(err.code);
    const appError = ['APPCHECK_REQUIRED', 'APPCHECK_INVALID', 'APPCHECK_UNAVAILABLE'].includes(err.code);
    const status = invalid ? 401 : err.status === 429 ? 429 : appError && err.status === 401 ? 401 : 503;
    res.status(status).json({ success: false, code: invalid ? 'AUTH_INVALID' : appError ? err.code : 'AUTH_VERIFICATION_UNAVAILABLE',
      message: invalid ? '로그인 정보가 만료되었거나 유효하지 않습니다.' : '인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    return null;
  }
}

// 로컬 권한은 운영의 검증 결과만 사용하며, 해당 요청 안에서만 공유한다.
async function getVerifiedAccountRole(req, uid) {
  const cached = verifiedAccountRoles.get(req);
  if (cached?.uid === uid) return cached.role;
  try {
    if (isLocal()) {
      const result = await requestProduction('verifyUserIdentity', { includeAccountRole: true }, { headers: req.headers });
      if (result.uid !== uid || result.accountRoleVersion !== 1 || !['owner', 'admin', 'none'].includes(result.accountRole)) throw new Error();
      verifiedAccountRoles.set(req, { uid, role: result.accountRole });
      return result.accountRole;
    }
    const user = await admin.auth().getUser(uid);
    if (user.disabled) throw new Error();
    return require('../services/membershipPolicy').resolveAccountRole(user.customClaims || {});
  } catch (_) {
    throw Object.assign(new Error('현재 계정 권한을 확인하지 못했습니다.'), { code: 'ACCOUNT_ROLE_UNAVAILABLE' });
  }
}

// 관리자 데이터·작업은 운영 실행 환경의 현재 계정 권한으로만 허용한다.
async function verifyAdmin(req, res, { ownerOnly = false } = {}) {
  if (process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB
      || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST
      || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    res.status(503).json({ success: false, message: '운영 관리자 서버에서 처리해야 합니다.' });
    return null;
  }
  const uid = await verifyUser(req, res);
  if (!uid) return null;
  try {
    const user = await admin.auth().getUser(uid);
    if (user.disabled) { res.status(401).json({ success: false }); return null; }
    const claims = user.customClaims || {};
    const role = claims.role === 'owner' ? 'owner'
      : claims.role === 'admin' || claims.admin === true ? 'admin' : null;
    if (!role || (ownerOnly && role !== 'owner')) {
      res.status(403).json({ success: false, message: '이 작업에 필요한 관리자 권한이 없습니다.' });
      return null;
    }
    return { uid, role };
  } catch (error) {
    console.error('Admin verification failed:', safeErrorSummary(error));
    res.status(503).json({ success: false, message: '관리자 권한을 확인할 수 없습니다.' });
    return null;
  }
}

// CORS 허용 헤더
async function verifyRegisteredUser(req, res, options) {
  const uid = await verifyUser(req, res, options);
  if (!uid) return null;
  try {
    const { isRegisteredUser } = require('../services/registrationService');
    if (await isRegisteredUser(uid)) return uid;
    res.status(403).json({ success: false, code: 'REGISTRATION_REQUIRED', message: '서비스 가입을 완료해 주세요.' });
  } catch (error) {
    console.error('Registration verification failed:', safeErrorSummary(error));
    res.status(503).json({ success: false, message: '가입 상태를 확인하지 못했습니다. 다시 시도해 주세요.' });
  }
  return null;
}

function setCors(res, req) {
  const origin = (req && req.headers.origin) || "";
  const allowed = [
    "https://ygo-synapse.web.app",
    "https://ygo-synapse.firebaseapp.com",
    "http://192.168.0.22:5005",
    "http://ch97-macbookair.local:5005"
  ];
  // localhost와 127.0.0.1은 임의의 개발 포트를 허용하고, mDNS 주소는 위 목록에서 명시적으로만 허용합니다.
  const localOriginRegex = /^https?:\/\/(?:localhost|127\.0\.0\.1)(:\d+)?$/i;
  const isAllowed = allowed.includes(origin) || localOriginRegex.test(origin);

  res.set("Access-Control-Allow-Origin", isAllowed ? origin : "https://ygo-synapse.web.app");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization, X-Firebase-AppCheck");
  res.set("Vary", "Origin");
}

module.exports = {
  verifyAppCheck,
  verifyUser,
  verifyAdmin,
  verifyRegisteredUser,
  getVerifiedAccountRole,
  setCors
};
