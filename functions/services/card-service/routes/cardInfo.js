'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { db } = require('../config/firebase');
const { getCardApiAccess, validateCardApiReadEnvironment, withCardApiRequest } = require('../services/cardApiAccessRepository');
const { createCardInfoHandler } = require('../services/cardInfoApi');
const { createLimiter } = require('../services/illustrationDelivery');
// 카드 읽기는 기존 Firestore/읽기 어댑터를 유지하고 키·쿼터만 호스트 저장소에서 선택한다.
const allow = createLimiter(600);
let handler;
function configuredHandler() {
  if (handler) return handler;
  const access = getCardApiAccess({ db });
  handler = withCardApiRequest(createCardInfoHandler({ db, access, allow,
  ...(process.env.CARD_SERVICE_URL ? { read: async input => {
    const cards = await require('../services/cardReadClient').getCardReadClient().readCards(input.field === 'cid'
      ? { cids: [input.value] } : { field: input.field === 'name' ? 'names' : 'numbers', value: input.value, limit: 2 });
    if (cards.length > 1) throw Object.assign(new Error('여러 카드가 일치합니다.'), { status: 409, code: 'AMBIGUOUS_CARD' });
    return cards[0] ? { id: cards[0].cid, data: () => cards[0].data } : null;
  } } : {}),
}), access);
  return handler;
}
exports.getCardInfo = onRequest({ invoker: 'public', memory: '256MiB', timeoutSeconds: 30,
  maxInstances: 5, concurrency: 20 }, async (req, res) => {
  if ((process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB
      || process.env.FIREBASE_DATABASE_EMULATOR_HOST) && !process.env.FIRESTORE_EMULATOR_HOST) {
    return res.status(503).set('Cache-Control', 'private, no-store').json({ success: false, code: 'API_UNAVAILABLE' });
  }
  try {
    validateCardApiReadEnvironment();
    return await configuredHandler()(req, res);
  }
  catch (_) {
    return res.status(503).set('Cache-Control', 'private, no-store').json({ success: false, code: 'API_UNAVAILABLE' });
  }
});
