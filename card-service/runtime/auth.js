'use strict';
function createAuthenticator(env, verify) {
  if (env.CARD_READ_BACKEND === 'fixture') {
    if (env.NODE_ENV !== 'test' || env.CARD_SERVICE_AUTH !== 'fixture') throw new Error('합성 인증은 격리 검사에서만 사용합니다.');
    return async req => req.headers.authorization === 'Bearer synthetic-card-service-token';
  }
  if (env.CARD_SERVICE_AUTH !== 'oidc' || !env.CARD_SERVICE_AUDIENCE || !env.CARD_SERVICE_CALLERS) {
    throw new Error('카드 서비스 audience와 허용 호출 계정 설정이 필요합니다.');
  }
  const allowed = new Set(env.CARD_SERVICE_CALLERS.split(',').map(value => value.trim()).filter(Boolean));
  let verifier;
  const verifyToken = verify || (async idToken => {
    const { OAuth2Client } = require('google-auth-library');
    verifier ||= new OAuth2Client();
    const ticket = await verifier.verifyIdToken({ idToken, audience: env.CARD_SERVICE_AUDIENCE });
    return ticket.getPayload();
  });
  return async req => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer \S+$/.test(header) || header.length > 8192) return false;
    const payload = await verifyToken(header.slice(7));
    return !!payload && ['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
      && payload.aud === env.CARD_SERVICE_AUDIENCE && payload.exp > Date.now() / 1000
      && payload.email_verified === true && allowed.has(payload.email);
  };
}
module.exports = { createAuthenticator };
