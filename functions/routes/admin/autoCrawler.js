const { onRequest } = require("firebase-functions/v2/https");
const { admin } = require("../../config/firebase");
const { setCors, verifyUser, verifyAppCheck } = require("../../utils/auth");
const { controlAutoCrawl } = require("../../services/autoCrawlerService");

exports.triggerAutoCrawl = onRequest({
  invoker: "public",
  memory: "1GiB",
  timeoutSeconds: 540,
  region: "asia-northeast3",
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  // 관리자 권한 검증 (Custom Claims)
  const uid = await verifyUser(req, res);
  if (!uid) return;

  let isAdmin = false;
  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    if (claims.admin === true || claims.role === "owner" || claims.role === "admin") {
      isAdmin = true;
    }
  } catch (e) {
    console.error("Scheduler auth error:", e);
  }

  if (!isAdmin) return res.status(403).json({ success: false, message: "Forbidden: 관리자 권한이 필요합니다." });

  try {
    return res.json(await controlAutoCrawl(req.query));
  } catch (error) {
    console.error('[AutoCrawl] 수동 실행 실패', error);
    return res.status(500).json({ success: false, message: '크롤링 실행 실패' });
  }

});

