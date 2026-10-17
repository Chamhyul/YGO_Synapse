'use strict';
// 실제 서비스 서버의 인증을 바꾸지 않는 전용 합성 실행 진입점.
const env = process.env;
if (env.NODE_ENV !== 'test' || env.GCLOUD_PROJECT !== 'demo-main-read'
  || env.STORAGE_BUCKET !== 'demo-main-read-assets' || env.CARD_READ_BACKEND !== 'fixture'
  || env.CARD_SERVICE_AUTH !== 'fixture' || env.FIRESTORE_EMULATOR_HOST !== 'emulators:8085'
  || env.FIREBASE_STORAGE_EMULATOR_HOST !== 'emulators:9199') throw Error('격리된 demo 검사 설정만 허용합니다.');
const auth = require('../utils/auth');
auth.verifyAppCheck = async (req, res) => {
  if (req.headers['x-firebase-appcheck'] === 'synthetic-app-check') return true;
  res.status(401).json({ success: false, code: 'APPCHECK_REQUIRED' }); return false;
};
auth.verifyRegisteredUser = async (req, res) => {
  if (!await auth.verifyAppCheck(req, res)) return null;
  if (req.headers.authorization === 'Bearer synthetic-user-token') return 'synthetic-reader';
  res.status(401).json({ success: false, code: 'AUTH_INVALID' }); return null;
};
require('../services/publicReadTransport').isLocal = () => false;
const routes = new Set(['getPublicCardData', 'getInitialData', 'getCardsMetaBatch', 'resolveCardNames', 'getCardInfo', 'addCards']);
const server = require('../server').createMainApp(env, { routes }).listen(8080, '0.0.0.0');
process.once('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 8000).unref(); });
