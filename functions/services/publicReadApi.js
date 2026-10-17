// 기존 내부 계약을 유지하는 조합 함수.
const { createPublicCardReadHandler } = require('./publicCardReadApi');
const { createUserIdentityHandler } = require('./userIdentityApi');
function createPublicReadHandlers(options) {
  return { getPublicCardData: createPublicCardReadHandler(options), verifyUserIdentity: createUserIdentityHandler(options) };
}
module.exports = { createPublicReadHandlers };
