const { onRequest } = require('firebase-functions/v2/https');
const { db } = require('../config/firebase');
const { isLocal } = require('../services/publicReadTransport');
const { verifyAppCheck, setCors } = require('../utils/auth');
const { createPublicCardReadHandler } = require('../services/publicCardReadApi');
const handler = createPublicCardReadHandler({ db, isLocal, verifyAppCheck, setCors,
  ...(globalThis.process?.env?.CARD_SERVICE_URL ? {
    readCards: body => require('../services/cardReadClient').getCardReadClient().readCards(body),
  } : {}),
});
const options = { invoker: 'public', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, concurrency: 20 };
exports.getPublicCardData = onRequest(options, handler);
Object.defineProperty(exports, 'verifyUserIdentity', { enumerable: true, get: () => require('./userIdentity').verifyUserIdentity });
