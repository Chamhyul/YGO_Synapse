'use strict';
const { randomBytes,createHmac,timingSafeEqual } = require('node:crypto');
const { prepareFirebaseAccountCheck } = require('../../functions/services/requestAccount');
const idToken = header => /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header || '')?.[1];
const unauthorized = () => Object.assign(Error('UNAUTHORIZED'), { status: 401 });
function createAuthentication(config, {
  firebaseAuth=app=>require('firebase-admin/auth').getAuth(app),
  firebaseAppCheck=app=>require('firebase-admin/app-check').getAppCheck(app),
}={}) {
  const sessions = new Map();
  const signing=config.sessionSecret||process.env.TRANSITION_SESSION_SECRET;
  const mac=value=>createHmac('sha256',signing).update(value).digest('base64url');
  let firebaseApp;
  function getApp() {
    const { initializeApp, applicationDefault } = require('firebase-admin/app');
    return firebaseApp ||= initializeApp({ projectId: config.projectId, credential: applicationDefault() }, 'synapse-transition');
  }
  async function verifyAppCheck(token) {
    if (config.mode === 'demo') return;
    if (!token) throw Object.assign(Error('APPCHECK_REQUIRED'), { status: 401 });
    try { await firebaseAppCheck(getApp()).verifyToken(token); }
    catch (_) { throw Object.assign(Error('APPCHECK_INVALID'), { status: 401 }); }
  }
  function createDemoSession() {
    if (config.mode !== 'demo') throw Object.assign(Error('NOT_FOUND'), { status: 404 });
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt < now) sessions.delete(key);
    if (sessions.size >= 500) throw Object.assign(Error('DEMO_BUSY'), { status: 429 });
    let token;
    const session = { uid: `demo-${randomBytes(16).toString('hex')}`, expiresAt: now + 2 * 60 * 60 * 1000 };
    if(signing){const data=Buffer.from(JSON.stringify(session)).toString('base64url');token=data+'.'+mac(data);}else{token=randomBytes(32).toString('base64url');sessions.set(token,session);}
    return { ...session, token };
  }
  async function verify(header) {
    const token = idToken(header);
    if (!token || token.length > 8192) throw Object.assign(Error('UNAUTHORIZED'), { status: 401 });
    if (config.mode === 'demo') {
      let session;
      if(signing){const [data,signature,...extra]=token.split('.');const expected=data&&mac(data);if(extra.length||!signature||signature.length!==expected?.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Object.assign(Error('UNAUTHORIZED'),{status:401});try{session=JSON.parse(Buffer.from(data,'base64url'));}catch(_){throw Object.assign(Error('UNAUTHORIZED'),{status:401});}if(!/^demo-[a-f0-9]{32}$/.test(session.uid)||!Number.isSafeInteger(session.expiresAt))throw Object.assign(Error('UNAUTHORIZED'),{status:401});}
      else session=sessions.get(token);
      if (!session || session.expiresAt < Date.now()) throw Object.assign(Error('UNAUTHORIZED'), { status: 401 });
      return session.uid;
    }
    try { return (await firebaseAuth(getApp()).verifyIdToken(token, true)).uid; }
    catch (_) { throw Object.assign(Error('UNAUTHORIZED'), { status: 401 }); }
  }
  async function readAccountRecord(uid) {
    let timer;
    try {
      const account = await Promise.race([firebaseAuth(getApp()).getUser(uid), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('ACCOUNT_UNAVAILABLE')), 8000);
      })]);
      if (account.uid !== uid || account.disabled) throw Object.assign(Error('UNAUTHORIZED'), { status: 401 });
      return account;
    } catch (error) {
      if (error.message === 'UNAUTHORIZED' || error.code === 'auth/user-not-found') throw Object.assign(Error('UNAUTHORIZED'), { status: 401 });
      throw Object.assign(Error('ACCOUNT_UNAVAILABLE'), { status: 503 });
    } finally { clearTimeout(timer); }
  }
  function accountSummary(account) {
    const { role, admin, ygoMembership } = account.customClaims || {};
    return { uid: account.uid, customClaims: { role, admin, ygoMembership } };
  }
  async function currentAccount(uid) {
    if (config.mode === 'demo') return { uid, customClaims: {} };
    return accountSummary(await readAccountRecord(uid));
  }
  async function prepareMembershipAccount(header, uid) {
    const token = idToken(header);
    if (!token || token.length > 8192) throw unauthorized();
    let recheck;
    try { recheck = await prepareFirebaseAccountCheck(firebaseAuth(getApp()), token, uid); }
    catch (_) { throw unauthorized(); }
    return async () => {
      try { return accountSummary(await recheck(() => readAccountRecord(uid))); }
      catch (error) {
        if (error.message === 'ACCOUNT_UNAVAILABLE') throw error;
        throw unauthorized();
      }
    };
  }
  const enqueueMembershipClaims = config.mode === 'firebase' && config.environment === 'production'
    ? require('../../functions/services/supabaseMembershipClaimsDispatch').createMembershipClaimsEnqueue(
      () => require('firebase-admin/functions').getFunctions(getApp()), config)
    : undefined;
  return { createDemoSession, verify, verifyAppCheck, currentAccount, prepareMembershipAccount, enqueueMembershipClaims };
}
module.exports = { createAuthentication };
