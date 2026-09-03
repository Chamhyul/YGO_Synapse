const { onRequest } = require("firebase-functions/v2/https");
const { admin } = require("../../config/firebase");
const { setCors, verifyUser } = require("../../utils/auth");
const { startCardNumbersMigration } = require("../../services/cardNumbersMigrationService");

exports.migrateCardNumbersField = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed. Use POST." });
  }

  const uid = await verifyUser(req, res);
  if (!uid) return;

  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    const isAdmin = claims.admin === true || claims.role === "owner" || claims.role === "admin";
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden: 관리자 권한이 필요합니다." });
    }
  } catch (e) {
    console.error("Card-number migration authorization error:", e);
    return res.status(403).json({ success: false, message: "Forbidden: 사용자 권한 확인 실패" });
  }

  const { httpStatus, ...result } = await startCardNumbersMigration();
  return res.status(httpStatus).json(result);

});

