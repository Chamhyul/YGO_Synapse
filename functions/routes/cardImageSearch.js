const { onRequest } = require('firebase-functions/v2/https');
const { setCors, verifyAppCheck } = require('../utils/auth');
const { classifyImages } = require('../services/draw2CardClassifierService');

exports.searchCardByImage = onRequest({
  invoker: 'public',
  memory: '1GiB',
  timeoutSeconds: 60,
  concurrency: 1,
}, async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청만 지원합니다.' });
  if (!(await verifyAppCheck(req, res))) return;

  const maxResults = Math.min(10, Math.max(1, Number(req.body?.maxResults) || 5));
  try {
    const images = Array.isArray(req.body?.images) ? req.body.images : [req.body?.image];
    const result = { regions: await classifyImages(images, { maxResults }) };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, ...result });
  } catch (error) {
    const inputError = /이미지|base64|카드 영역/.test(error.message);
    console.error('[searchCardByImage]', error.message);
    return res.status(inputError ? 400 : 500).json({
      success: false,
      message: inputError ? error.message : '이미지 검색을 완료하지 못했습니다.',
    });
  }
});
