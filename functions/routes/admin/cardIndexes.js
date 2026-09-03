const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../config/firebase');
const { setCors, verifyUser } = require('../../utils/auth');
const cardIndexService = require('../../services/cardIndexService');

exports.rebuildAllCardIndexes = onRequest({
  invoker: 'public', memory: '1GiB', timeoutSeconds: 540,
}, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청을 사용하세요.' });
  const uid = await verifyUser(req, res);
  if (!uid) return;
  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    if (!(claims.admin === true || claims.role === 'owner' || claims.role === 'admin')) {
      return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
    }
    const result = await cardIndexService.rebuildAllCardIndexes();
    return res.status(result.busy ? 409 : 200).json(result);
  } catch (error) {
    console.error('[CardManifest] 전체 재생성 실패', error);
    return res.status(500).json({ success: false, message: '카드 목록 재생성 실패. 대기 기록은 보존됩니다.' });
  }
});
