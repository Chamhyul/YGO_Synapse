'use strict';
// JWT 서명·발급자·대상·만료는 Admin SDK가 검증한다. 최신 계정 한 번으로
// SDK의 disabled/철회 검사와 현재 Custom Claims 판정을 함께 수행한다.
async function currentAdminUser(auth, decoded, revokedCode, req, options) {
  const { requestAccount, validateCurrentAccount } = require('./requestAccount');
  return validateCurrentAccount(await requestAccount(req, auth, decoded.uid, options), decoded, revokedCode);
}
module.exports = { currentAdminUser };
