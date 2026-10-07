const { forwardAdminRequest } = require('../../services/adminActionTransport');
const { onRequest } = require('firebase-functions/v2/https');
const { setCors, verifyAdmin } = require('../../utils/auth');
const cardIndexService = require('../../services/cardIndexService');

exports.rebuildCardNames = onRequest({
  invoker: 'public', memory: '512MiB', timeoutSeconds: 540,
}, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (await forwardAdminRequest(req, res, 'rebuildCardNames')) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청을 사용하세요.' });
  if (!(await verifyAdmin(req, res))) return;
  try {
    const result = await cardIndexService.rebuildCardNames();
    return res.status(result.busy ? 409 : 200).json(result);
  } catch (error) {
    console.error('[CardManifest] 전체 재생성 실패', error);
    return res.status(500).json({ success: false, message: '카드 목록 재생성 실패. 대기 기록은 보존됩니다.' });
  }
});
