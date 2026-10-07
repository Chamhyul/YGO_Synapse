const { admin, getProductionAuth } = require("../config/firebase");
const { safeErrorSummary } = require("./safeError");

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
        res.status(401).json({ success: false, message: "Unauthorized. App Check Token is required." });
      }
      return false;
    }

    if (typeof admin.appCheck !== "function") {
      return true;
    }

    try {
      await admin.appCheck().verifyToken(appCheckToken);
      return true;
    } catch (tokenErr) {
      console.warn("AppCheck token verification failed:", safeErrorSummary(tokenErr));
      if (!res.headersSent) {
        res.status(401).json({ success: false, message: "Unauthorized. Invalid App Check Token." });
      }
      return false;
    }
  } catch (err) {
    console.error("AppCheck general error:", safeErrorSummary(err));
    if (!res.headersSent) {
      res.status(401).json({ success: false, message: "Unauthorized. App Check verification error." });
    }
    return false;
  }
}

// Firebase Auth 토큰 파싱 및 검증 헬퍼
async function verifyUser(req, res) {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string' || !/^Bearer \S+$/.test(authHeader)) {
    res.status(401).json({ success: false, message: "Unauthorized: No token provided" });
    return null;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('실제 Firebase Auth가 필요합니다.');
    const isEmulator = process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB;
    const auth = isEmulator ? getProductionAuth() : admin.auth();
    // SDK가 서명·유효기간·발급 프로젝트 및 철회·비활성 상태를 확인한다.
    const decodedToken = await auth.verifyIdToken(idToken, true);
    if (typeof decodedToken.uid !== 'string' || !decodedToken.uid) throw new Error('유효한 사용자가 없습니다.');
    return decodedToken.uid;
  } catch (err) {
    console.error("Token verification failed:", safeErrorSummary(err));
    res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    return null;
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
  setCors
};
