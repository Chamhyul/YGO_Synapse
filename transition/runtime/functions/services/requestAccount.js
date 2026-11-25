'use strict';
// 요청·검증 단계 안에서만 공유한다. 새 권한 확정/잠금 획득 뒤에는 fresh로
// 새 단계를 시작하며, 요청 사이 또는 Auth 쓰기 전후로 재사용하지 않는다.
const requests = new WeakMap();
function requestAccount(req, auth, uid, { fresh = false } = {}) {
  if (!req || typeof req !== 'object') return auth.getUser(uid);
  let accounts = requests.get(req);
  if (!accounts) { accounts = new Map(); requests.set(req, accounts); }
  let users = accounts.get(auth);
  if (!users) { users = new Map(); accounts.set(auth, users); }
  if (fresh || !users.has(uid)) users.set(uid, Promise.resolve().then(() => auth.getUser(uid)));
  return users.get(uid);
}
function validateCurrentAccount(user, decoded, revokedCode = 'auth/id-token-revoked') {
  if (user.disabled) throw Object.assign(new Error('사용할 수 없는 계정입니다.'), { code: 'auth/user-disabled' });
  if (user.tokensValidAfterTime) {
    const after = Date.parse(user.tokensValidAfterTime), at = decoded.auth_time * 1000;
    if (!Number.isFinite(after) || !Number.isFinite(decoded.auth_time) || !Number.isFinite(at) || at < after) {
      throw Object.assign(new Error('인증이 철회되었거나 인증 시각이 유효하지 않습니다.'), { code: revokedCode });
    }
  }
  return user;
}

async function prepareFirebaseAccountCheck(auth, token, uid) {
  const decoded = await auth.verifyIdToken(token, false);
  const invalid = () => Object.assign(Error('유효한 계정을 확인할 수 없습니다.'), { code: 'auth/invalid-id-token' });
  if (decoded.uid !== uid || !Number.isFinite(decoded.auth_time) || !Number.isFinite(decoded.exp)) throw invalid();
  return async (readAccount = () => auth.getUser(uid)) => {
    if (decoded.exp <= Math.floor(Date.now() / 1000)) throw invalid();
    const account = await readAccount();
    if (account?.uid !== uid) throw invalid();
    return validateCurrentAccount(account, decoded);
  };
}

module.exports = { requestAccount, validateCurrentAccount, prepareFirebaseAccountCheck };
