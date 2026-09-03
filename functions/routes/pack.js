const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyAppCheck } = require("../utils/auth");
const packService = require("../services/packService");

function packRoute(options, handler) {
  return onRequest({ invoker: "public", ...options }, async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (!(await verifyAppCheck(req, res))) return;
    try {
      const result = await handler({ ...req.query, ...(req.body || {}) });
      return res.status(result.isError ? 400 : 200).json(result);
    } catch (error) {
      console.error('[Pack]', error);
      return res.status(500).json({ isError: true, message: '팩 처리에 실패했습니다. 다시 시도해 주세요.' });
    }
  });
}

exports.searchPack = packRoute({ memory: "1GiB", timeoutSeconds: 120 }, params => {
  if (!params.packName) return { isError: true, message: '팩 이름 미입력' };
  return packService.searchPackByName(params.packName);
});
exports.getPackCids = packRoute({}, params => {
  if (!params.packId) return { isError: true, message: '팩 ID 미입력' };
  return packService.loadPackCids(params.packId, params.locale || 'ko');
});
exports.crawlPackCardsBatch = packRoute({ memory: "1GiB", timeoutSeconds: 300 }, params => {
  if (!params.packId && !Array.isArray(params.cids)) return { isError: true, message: '팩 ID 또는 카드 목록 미입력' };
  return packService.crawlPackCardsBatch(params);
});
