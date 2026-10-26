'use strict';

// 라우트의 실제 공통 조회 구현에 같은 합성 저장소·인증 경계를 전달한다.
// 기본 Firebase 앱이나 운영 SDK 연결로 대체하지 않는다.
function loadLoginUserData(loadSource, mocks, environment) {
  return loadSource('services/loginUserData.js', {
    './membershipPolicy': require('../services/membershipPolicy'),
    './inventoryRequestTiming': require('../services/inventoryRequestTiming'),
    './userProfileRepository': mocks['../services/userProfileRepository'],
    '../utils/auth': mocks['../utils/auth'],
    '../utils/inventoryStorage': mocks['../utils/inventoryStorage'],
    './inventoryMigrationService': mocks['../services/inventoryMigrationService'],
    './membershipClaims': mocks['../services/membershipClaims'],
    './user-storage/membershipStore': require('../services/user-storage/membershipStore'),
  }, environment);
}

module.exports = { loadLoginUserData };
