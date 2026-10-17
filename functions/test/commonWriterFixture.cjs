'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { open } = require('../../integration/user-migration/connection.cjs');
const { resolveProfileWriterConfig } = require('../config/userProfileWriter');
const { createUserWriterRuntime } = require('../services/userProfileWriterRuntime');
async function fixture() {
  // 실제 SDK는 open()의 demo guard와 내부 에뮬레이터만 사용한다. 운영 설정/metadata는 합성 주입한다.
  const runId = randomBytes(16).toString('hex'), connection = open(runId);
  const target = { id: 'synthetic-user-data', projectId: 'synthetic-runtime', instanceId: 'synthetic-user-data', location: 'asia-southeast1', databaseURL: 'https://synthetic-user-data.asia-southeast1.firebasedatabase.app/', writerRunId: runId };
  const env = { NODE_ENV: 'production', USER_STORAGE_BACKEND: 'rtdb', USER_STORAGE_MODE: 'production', USER_PROFILE_WRITER_MODE: 'production', USER_PROFILE_WRITER_RUN_ID: runId,
    GCLOUD_PROJECT: target.projectId, USER_STORAGE_TARGET: target.id, USER_DATABASE_URL: target.databaseURL, K_SERVICE: 'synthetic-service', K_REVISION: 'synthetic-revision' };
  const resolve = value => resolveProfileWriterConfig(value || env, [target]), config = resolve();
  const auth = { getUser: (...args) => connection.auth.getUser(...args), setCustomUserClaims: (...args) => connection.auth.setCustomUserClaims(...args), listUsers: (...args) => connection.auth.listUsers(...args),
    verifyIdToken: async token => { if (!['member', 'owner'].includes(token)) throw Object.assign(Error('synthetic'), { code: 'auth/invalid-id-token' }); return { uid: `${runId}-${token}` }; },
    createSessionCookie: async () => 'synthetic-session', verifySessionCookie: async () => ({ uid: `${runId}-owner`, auth_time: Math.floor(Date.now()/1000) }) };
  const runtime = createUserWriterRuntime({ resolveConfig: () => resolve(), createConnection: () => ({ database: connection.targetDatabase, close: connection.close }),
    createProductionServices: () => ({ db: connection.db, bucket: connection.bucket, auth }) });
  const binding = runtime.getProfileWriterBinding(), cache = new Map(), overrides = new Map();
  const mock = (name, value) => overrides.set(path.join(root, name), value);
  mock('functions/config/userProfileWriter.js', { resolveProfileWriterConfig: resolve, productionWriterRequested: value => (value || env).USER_STORAGE_MODE === 'production' });
  mock('functions/config/userStorage.js', { ...require('../config/userStorage'), resolveUserStorageConfig: () => config });
  mock('functions/services/userProfileWriterRuntime.js', runtime);
  mock('functions/config/firebase.js', { db: connection.db, admin: { auth: () => auth, storage: () => ({ bucket: () => connection.bucket }) },
    FieldValue: require('firebase-admin/firestore').FieldValue, getBucket: () => connection.bucket,
    DISCORD_CLIENT_ID: 'synthetic', DISCORD_GUILD_ID: 'synthetic', DISCORD_CLIENT_SECRET: { value: () => 'synthetic' } });
  mock('functions/services/publicReadTransport.js', { withPublicReadRequest: handler => handler, isLocal: () => false });
  mock('functions/utils/auth.js', { setCors() {}, verifyAppCheck: async () => true,
    verifyUser: async req => (await auth.verifyIdToken((req.headers.authorization || '').slice(7))).uid,
    verifyRegisteredUser: async (req, res) => { const uid = (await auth.verifyIdToken((req.headers.authorization || '').slice(7))).uid;
      if (!await binding.repository.isRegistered(uid)) { res.status(403).json({ success: false }); return; } return uid; },
    getVerifiedAccountRole: async (_req, uid) => { const user = await auth.getUser(uid); return user.customClaims?.role || 'none'; } });
  mock('functions/integrations/discordMembership.js', { getDiscordMembershipWithCode: async () => ({ roles: [], discordId: '123456789012345678' }) });
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (overrides.has(filename)) return overrides.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!/\.(js|cjs)$/.test(filename) || filename.includes('/node_modules/')) return require(filename);
    const loaded = new Module(filename, module), standard = Module.createRequire(filename);
    loaded.filename = filename; loaded.environment = env; cache.set(filename, loaded);
    loaded.require = name => {
      if (name === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
      if (name.startsWith('.')) return load(standard.resolve(name));
      return standard(name);
    };
    loaded._compile(`'use strict'; const process = { env: module.environment, argv: [], stdout: { write() {} }, stderr: { write() {} } };\n${fs.readFileSync(filename, 'utf8').replace(/^#!.*\r?\n/, '')}`, filename);
    return loaded.exports;
  }
  await connection.auth.createUser({ uid: `${runId}-member` });
  await connection.auth.createUser({ uid: `${runId}-owner` });
  await connection.auth.setCustomUserClaims(`${runId}-owner`, { role: 'owner', admin: true });
  return { env, config, connection, runtime, binding, load, mock, uid: `${runId}-member`, owner: `${runId}-owner`, close: runtime.closeProfileWriterRuntime };
}
function response() {
  return { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; }, type() { return this; }, redirect(...args) { this.redirected = args; return this; } };
}
async function call(handler, { method = 'POST', body = {}, query = {}, token = 'member', url = '/', headers = {} } = {}) {
  const res = response(); await handler({ method, body, query, headers: { authorization: `Bearer ${token}`, ...headers }, ip: '127.0.0.1', url, originalUrl: url, protocol: 'https', get: name => headers[name.toLowerCase()] }, res); return res;
}
module.exports = { fixture, response, call };
