const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../config/firebase');
const { setCors, verifyUser, verifyAppCheck } = require('../../utils/auth');
const { startCardIllustrationsMigration } = require('../../services/cardIllustrationsMigrationService');

exports.migrateCardIllustrations = onRequest({
  invoker: 'public', memory: '256MiB', timeoutSeconds: 30,
}, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed. Use POST.' });
  if (!(await verifyAppCheck(req, res))) return;
  const uid = await verifyUser(req, res);
  if (!uid) return;
  try {
    const claims = (await admin.auth().getUser(uid)).customClaims || {};
    if (claims.admin !== true && claims.role !== 'owner' && claims.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: 관리자 권한이 필요합니다.' });
    }
    const { httpStatus, ...result } = await startCardIllustrationsMigration();
    return res.status(httpStatus).json(result);
  } catch (error) {
    console.error('Card illustration migration start error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});
