'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { db } = require('../config/firebase');
const { createCardApiAccess } = require('../services/cardApiAccess');
const { createCardInfoHandler } = require('../services/cardInfoApi');
const { createLimiter } = require('../services/illustrationDelivery');
// 에뮬레이터도 키를 필수로 검사하며 로컬 Firestore만 사용한다.
const handler = createCardInfoHandler({ db, access: createCardApiAccess(db), allow: createLimiter(600) });
exports.getCardInfo = onRequest({ invoker: 'public', memory: '256MiB', timeoutSeconds: 30,
  maxInstances: 5, concurrency: 20 }, async (req, res) => {
  if ((process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB) && !process.env.FIRESTORE_EMULATOR_HOST) {
    return res.status(503).set('Cache-Control', 'private, no-store').json({ success: false, code: 'API_UNAVAILABLE' });
  }
  return handler(req, res);
});
