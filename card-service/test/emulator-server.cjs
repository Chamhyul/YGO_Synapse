'use strict';
const env = process.env;
if (env.NODE_ENV !== 'test' || env.CARD_PROJECT_ID !== 'demo-card-read'
  || env.CARD_STORAGE_BUCKET !== 'demo-card-read-assets' || env.CARD_READ_BACKEND !== 'firestore'
  || env.FIRESTORE_EMULATOR_HOST !== 'emulators:8085'
  || env.FIREBASE_STORAGE_EMULATOR_HOST !== 'emulators:9199') throw Error('격리된 demo 검사 설정만 허용합니다.');
const server = require('../runtime/app').createReadApp({
  ...require('../runtime/backend').createBackend(env),
  authenticate: async req => req.headers.authorization === 'Bearer synthetic-card-service-token',
}).listen(8080, '0.0.0.0');
process.once('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 8000).unref(); });
