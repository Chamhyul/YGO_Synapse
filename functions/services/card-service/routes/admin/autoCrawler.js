const { forwardAdminRequest } = require('../../services/adminActionTransport');
const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyAdmin, verifyAppCheck } = require("../../utils/auth");
const { controlAutoCrawl } = require("../../services/autoCrawlerService");

exports.triggerAutoCrawl = onRequest({
  invoker: "public",
  memory: "512MiB",
  timeoutSeconds: 540,
  region: "asia-northeast3",
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (await forwardAdminRequest(req, res, 'triggerAutoCrawl')) return;
  if (!(await verifyAppCheck(req, res))) return;

  if (!(await verifyAdmin(req, res))) return;

  try {
    return res.json(await controlAutoCrawl(req.query));
  } catch (error) {
    console.error('[AutoCrawl] 수동 실행 실패', error);
    return res.status(500).json({ success: false, message: '크롤링 실행 실패' });
  }

});

