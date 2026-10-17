const { forwardAdminRequest } = require('../../services/adminActionTransport');
const { onRequest } = require('firebase-functions/v2/https');
const { setCors, verifyAdmin, verifyAppCheck } = require('../../utils/auth');
const { startCardIllustrationsMigration } = require('../../services/cardIllustrationsMigrationService');

exports.migrateCardIllustrations = onRequest({
  invoker: 'public', memory: '256MiB', timeoutSeconds: 30,
}, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (await forwardAdminRequest(req, res, 'migrateCardIllustrations')) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed. Use POST.' });
  if (!(await verifyAppCheck(req, res))) return;
  if (!(await verifyAdmin(req, res))) return;
  try {
    const { httpStatus, ...result } = await startCardIllustrationsMigration();
    return res.status(httpStatus).json(result);
  } catch (error) {
    console.error('Card illustration migration start error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});
