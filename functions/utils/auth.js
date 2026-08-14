const { admin } = require("../config/firebase");

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
      console.warn("AppCheck token verification failed:", tokenErr.message || tokenErr);
      if (!res.headersSent) {
        res.status(401).json({ success: false, message: "Unauthorized. Invalid App Check Token." });
      }
      return false;
    }
  } catch (err) {
    console.error("AppCheck general error:", err);
    if (!res.headersSent) {
      res.status(401).json({ success: false, message: "Unauthorized. App Check verification error." });
    }
    return false;
  }
}

// Firebase Auth 토큰 파싱 및 검증 헬퍼
async function verifyUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Unauthorized: No token provided" });
    return null;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const isEmulator = process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB;
    const decodedToken = await admin.auth().verifyIdToken(idToken).catch((err) => {
      if (isEmulator && idToken) {
        try {
          const base64Payload = idToken.split('.')[1];
          if (base64Payload) {
            const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
            const uid = payload.user_id || payload.sub || payload.uid;
            if (uid) return { uid };
          }
        } catch (e) {
          // ignore
        }
      }
      throw err;
    });
    return decodedToken.uid;
  } catch (err) {
    console.error("Token verification failed:", err);
    res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
    return null;
  }
}

// CORS 허용 헤더
function setCors(res, req) {
  const origin = (req && req.headers.origin) || "";
  const allowed = [
    "https://ygo-synapse.web.app",
    "https://ygo-synapse.firebaseapp.com"
  ];
  // localhost 또는 127.0.0.1 (포트 번호 선택 허용) 정규식 검사
  const localOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  const isAllowed = allowed.includes(origin) || localOriginRegex.test(origin);

  res.set("Access-Control-Allow-Origin", isAllowed ? origin : "https://ygo-synapse.web.app");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization, X-Firebase-AppCheck");
  res.set("Vary", "Origin");
}

module.exports = {
  verifyAppCheck,
  verifyUser,
  setCors
};
