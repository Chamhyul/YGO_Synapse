const { getUserProfileRepository } = require('./userProfileRepository');

// 기존 회원의 동의 이력을 만들어내지 않는다. 문서가 없는 구형 인벤토리도 보존한다.
async function isRegisteredUser(uid) {
  return getUserProfileRepository().isRegistered(uid);
}

async function completeUserRegistration(uid, versions) {
  return getUserProfileRepository().completeRegistration(uid, versions);
}

module.exports = { isRegisteredUser, completeUserRegistration };
