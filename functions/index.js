/**
 * YGO Synapse - Firebase Functions
 * Phase 1: 카드 크롤링 API + Firestore 캐싱
 * [모듈화 적용됨]
 */

const { setGlobalOptions } = require("firebase-functions/v2/options");

// Firebase 초기화를 보장하기 위해 config를 가장 먼저 불러옵니다.
require("./config/firebase");

// 전역 옵션 설정
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

// 관리형 인스턴스는 아래에서 지정한 대상 라우트만 준비한다.
// 배포 탐색·로컬 에뮬레이터는 전체 export와 기존 메타정보를 유지한다.
const inventoryRuntime = process.env.K_SERVICE && process.env.K_REVISION
  && !process.env.FUNCTIONS_EMULATOR && !process.env.FIREBASE_EMULATOR_HUB
  && ['addCards', 'discardCards'].includes(process.env.FUNCTION_TARGET);
const claimsWorkerRuntime = process.env.K_SERVICE && process.env.K_REVISION
  && !process.env.FUNCTIONS_EMULATOR && !process.env.FIREBASE_EMULATOR_HUB
  && process.env.FUNCTION_TARGET === 'syncMembershipClaimsAfterProfile';
const inventorySnapshotRuntime = process.env.K_SERVICE && process.env.K_REVISION
  && !process.env.FUNCTIONS_EMULATOR && !process.env.FIREBASE_EMULATOR_HUB
  && ['refreshInventoryReadSnapshot', 'prepareInventoryReadSnapshot'].includes(process.env.FUNCTION_TARGET);
const authenticationRouteModules = Object.freeze({
  adminPages: './routes/admin/pages',
  adminBackend: './routes/admin/pages',
  startYoutubeMembershipVerification: './routes/youtubeMembership',
  verifyYoutubeMembership: './routes/youtubeMembership',
  startDiscordMembershipVerification: './routes/discordMembership',
  verifyDiscordMembership: './routes/discordMembership',
  getUserData: './routes/user',
});
const authenticationRuntime = process.env.K_SERVICE && process.env.K_REVISION
  && !process.env.FUNCTIONS_EMULATOR && !process.env.FIREBASE_EMULATOR_HUB
  && Object.hasOwn(authenticationRouteModules, process.env.FUNCTION_TARGET);
if (inventorySnapshotRuntime) {
  exports[process.env.FUNCTION_TARGET] = require('./tasks/inventoryReadSnapshot')[process.env.FUNCTION_TARGET];
} else if (claimsWorkerRuntime) {
  exports.syncMembershipClaimsAfterProfile = require('./tasks/membershipClaims').syncMembershipClaimsAfterProfile;
} else if (inventoryRuntime) {
  const inventoryRoutes = require('./routes/inventory');
  exports[process.env.FUNCTION_TARGET] = inventoryRoutes[process.env.FUNCTION_TARGET];
} else if (authenticationRuntime) {
  // 같은 SDK 진입점을 그대로 사용하며 현재 인증·저장·복구 검사는 생략하지 않는다.
  const target = process.env.FUNCTION_TARGET;
  exports[target] = require(authenticationRouteModules[target])[target];
} else {
// HTTP 라우트 등록. 실제 처리 로직은 서비스·크롤러에서 수행합니다.

// 1. 카드 기능 모음
const cardRoutes = require("./routes/cardCatalog");
exports.searchCardByNo = cardRoutes.searchCardByNo;
exports.searchCardByName = cardRoutes.searchCardByName;
exports.getCardMetadata = cardRoutes.getCardMetadata;
exports.getCardsMetaBatch = cardRoutes.getCardsMetaBatch;
exports.crawlCardMetaByName = cardRoutes.crawlCardMetaByName;
exports.getRamMemoryStats = cardRoutes.getRamMemoryStats;
exports.searchCard = cardRoutes.searchCard;
exports.resolveCardNames = cardRoutes.resolveCardNames;
const inventoryRoutes = require("./routes/inventory");
exports.addCards = inventoryRoutes.addCards;
exports.moveCards = inventoryRoutes.moveCards;
exports.discardCards = inventoryRoutes.discardCards;
exports.suggestCardNames = cardRoutes.suggestCardNames;
exports.searchCardByImage = require('./routes/cardImageSearch').searchCardByImage;
exports.getIllustration = require('./routes/illustrationDelivery').getIllustration;

// 2. 팩 기능 모음
const packRoutes = require("./routes/pack");
exports.searchPack = packRoutes.searchPack;
exports.getPackCids = packRoutes.getPackCids;
exports.crawlPackCardsBatch = packRoutes.crawlPackCardsBatch;

// 3. 사용자 관련 모음
const userRoutes = require("./routes/user");
exports.getInitialData = require("./routes/initialData").getInitialData;
exports.getUserData = userRoutes.getUserData;
exports.updateUserSettings = userRoutes.updateUserSettings;
exports.clearUserData = userRoutes.clearUserData;
exports.updateNickname = userRoutes.updateNickname;
const registrationRoutes = require('./routes/registration');
exports.getRegistrationStatus = registrationRoutes.getRegistrationStatus;
exports.completeRegistration = registrationRoutes.completeRegistration;

// 4. 데이터 이관 모음
const migrationRoutes = require("./routes/migration");
exports.migrateFromSheet = migrationRoutes.migrateFromSheet;
exports.migrateFromData = migrationRoutes.migrateFromData;

// 5. 외부 연동 모음
const integrationRoutes = require("./routes/integration");
exports.checkSheet = integrationRoutes.checkSheet;
exports.checkMembershipDiscord = integrationRoutes.checkMembershipDiscord;
exports.checkMembershipCsv = integrationRoutes.checkMembershipCsv;
exports.uploadMembershipCsv = integrationRoutes.uploadMembershipCsv;

// 관리자용 HTTP 라우트
const crawlerAdmin = require("./routes/admin/autoCrawler");
const cardNumbersAdmin = require("./routes/admin/cardNumbers");
const cardIndexesAdmin = require("./routes/admin/cardIndexes");
const cardIllustrationsAdmin = require("./routes/admin/cardIllustrations");
exports.triggerAutoCrawl = crawlerAdmin.triggerAutoCrawl;
exports.migrateCardNumbersField = cardNumbersAdmin.migrateCardNumbersField;
exports.rebuildCardNames = cardIndexesAdmin.rebuildCardNames;
exports.migrateCardIllustrations = cardIllustrationsAdmin.migrateCardIllustrations;

// 예약 실행 및 작업 큐 진입점
const crawlerSchedules = require("./schedules/autoCrawler");
exports.autoCrawlFull = crawlerSchedules.autoCrawlFull;
exports.autoCrawlQuick = crawlerSchedules.autoCrawlQuick;
exports.compactUserWriterHistory = require('./schedules/userWriterHistory').compactUserWriterHistory;
exports.syncMembershipClaimsAfterProfile = require('./tasks/membershipClaims').syncMembershipClaimsAfterProfile;
Object.assign(exports, require('./tasks/inventoryReadSnapshot'));
exports.processCardIndexTask = require("./tasks/cardIndexes").processCardIndexTask;
exports.autoCrawlTask = require("./tasks/autoCrawler").autoCrawlTask;
exports.migrateCardNumbersTask = require("./tasks/cardNumbers").migrateCardNumbersTask;
exports.migrateCardIllustrationsTask = require("./tasks/cardIllustrations").migrateCardIllustrationsTask;

// 공지 및 시스템 관리자 권한 API
const noticesAdminRoutes = require("./routes/admin/notices");
exports.manageNotice = noticesAdminRoutes.manageNotice;
exports.manageAdminRole = noticesAdminRoutes.manageAdminRole;
exports.checkAdminAccess = require('./routes/admin/access').checkAdminAccess;
exports.adminHandleOperationRequest = require('./routes/admin/actions').adminHandleOperationRequest;

// 8. 덱 기능 모음
const deckRoutes = require("./routes/deck");
exports.searchDeck = deckRoutes.searchDeck;
exports.getDeckCards = deckRoutes.getDeckCards;


// 클라이언트 전환 기간에만 유지합니다. 기존 탭과 이전 클라이언트의 주소 호환용입니다.
exports.searchPackNew = packRoutes.searchPack;
exports.crawlPackBatchNew = packRoutes.crawlPackCardsBatch;
exports.getCardFullMetaByCid = cardRoutes.getCardMetadata;

// 세션 쿠키를 검증한 뒤 관리자 독립 문서를 제공한다.
exports.adminPages = require("./routes/admin/pages").adminPages;
exports.adminBackend = require("./routes/admin/pages").adminBackend;

// 키 없는 로컬 공개 조회와 실제 사용자 확인을 위한 운영 진입점.
const publicReadRoutes = require("./routes/publicRead");
exports.getPublicCardData = publicReadRoutes.getPublicCardData;
exports.verifyUserIdentity = require("./routes/userIdentity").verifyUserIdentity;

// YouTube 채널 소유를 확인한 뒤 기존 CSV 목록과 비교한다.
const youtubeMembershipRoutes = require("./routes/youtubeMembership");
exports.startYoutubeMembershipVerification = youtubeMembershipRoutes.startYoutubeMembershipVerification;
exports.verifyYoutubeMembership = youtubeMembershipRoutes.verifyYoutubeMembership;

const discordMembershipRoutes = require('./routes/discordMembership');
exports.startDiscordMembershipVerification = discordMembershipRoutes.startDiscordMembershipVerification;
exports.verifyDiscordMembership = discordMembershipRoutes.verifyDiscordMembership;

// 제삼자용 API 키 기반 DB 전용 카드 조회.
exports.getCardInfo = require('./routes/cardInfo').getCardInfo;

// Cloud IAM 전용: 승인된 운영 보조 색인 준비/읽기 대조. 사용자 API가 아니다.
exports.membershipCsvPrepareLookup = require('./routes/membershipCsvLookup').membershipCsvPrepareLookup;

}
