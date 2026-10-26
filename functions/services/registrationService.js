const { getUserProfileRepository } = require('./userProfileRepository');

// 기존 회원의 동의 이력을 만들어내지 않는다. 문서가 없는 구형 인벤토리도 보존한다.
async function isRegisteredUser(uid) {
  return getUserProfileRepository().isRegistered(uid);
}

// 구형 저장소의 가입 판정/본문 읽기 계약은 그대로 유지한다.
// 프로필 writer만 검증된 가입 snapshot을 초기 본문 구성에 함께 전달한다.
async function readRegistrationProfile(uid) {
  const repository = getUserProfileRepository();
  if (typeof repository.readRegistrationProfile === 'function') return repository.readRegistrationProfile(uid);
  return { registered: await repository.isRegistered(uid) };
}

async function completeUserRegistration(uid, versions) {
  return getUserProfileRepository().completeRegistration(uid, versions);
}

module.exports = { isRegisteredUser, readRegistrationProfile, completeUserRegistration };
