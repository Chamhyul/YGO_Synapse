'use strict';
const { resolveRtdbConfig } = require('../../functions/config/userStorage');
const fail = () => Object.assign(new Error('demo 리허설 설정이 필요합니다.'), { code: 'MIGRATION_CONFIG_INVALID' });
function validate(env = process.env) {
  const config = resolveRtdbConfig(env), base = config.emulatorHost.slice(0, config.emulatorHost.lastIndexOf(':'));
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    if (typeof env[key] !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\]|emulators):[1-9][0-9]{0,4}$/.test(env[key])
        || env[key].slice(0, env[key].lastIndexOf(':')) !== base || Number(env[key].split(':').at(-1)) > 65535) throw fail();
  }
  if (['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'FIREBASE_CONFIG', 'USER_STORAGE_TARGET']
      .some(key => env[key])) throw fail();
  if (env.STORAGE_EMULATOR_HOST && env.STORAGE_EMULATOR_HOST !== `http://${env.FIREBASE_STORAGE_EMULATOR_HOST}`) throw fail();
  return config;
}
function open(runId) {
  const config = validate(); if (!/^[a-f0-9]{32}$/.test(runId)) throw fail();
  const load = require('node:module').createRequire(require('node:path').resolve(__dirname, '../../functions/package.json'));
  const { initializeApp, deleteApp } = load('firebase-admin/app');
  const app = initializeApp({ projectId: config.projectId, databaseURL: config.databaseURL,
    storageBucket: `${config.projectId}-${runId}.appspot.com`,
    credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, `rehearsal-${runId}-${require('node:crypto').randomBytes(6).toString('hex')}`);
  // Firestore/Storage 클라이언트는 고정 에뮬레이터 주소와 시험 인증만 사용한다. ADC를 탐색하지 않는다.
  const db = new (load('@google-cloud/firestore').Firestore)({ projectId: config.projectId, host: process.env.FIRESTORE_EMULATOR_HOST, ssl: false });
  const authClient = new (load('google-auth-library').OAuth2Client)();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3600000 });
  const storage = new (load('@google-cloud/storage').Storage)({ projectId: config.projectId,
    apiEndpoint: `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`, authClient, useAuthWithCustomEndpoint: true });
  const database = load('firebase-admin/database').getDatabase(app);
  const scopedDb = { collection: name => db.collection(`rehearsals/${runId}/${name}`), runTransaction: callback => db.runTransaction(callback), batch: () => db.batch() };
  const prefix = `rehearsals/${runId}/destination`;
  let closing;
  return { config, db: scopedDb, database, targetDatabase: { ref: name => database.ref(`${prefix}/${name}`) },
    bucket: storage.bucket(`${config.projectId}-${runId}.appspot.com`), auth: load('firebase-admin/auth').getAuth(app),
    close() { return closing ||= (async () => { database.goOffline(); await db.terminate(); await deleteApp(app); })(); } };
}
module.exports = { validate, open };
