/**
 * YGO Synapse - Firebase Functions
 * Phase 1: 카드 크롤링 API + Firestore 캐싱
 * [모듈화 적용됨]
 */

const { setGlobalOptions } = require("firebase-functions/v2");

// Firebase 초기화를 보장하기 위해 config를 가장 먼저 불러옵니다.
require("./config/firebase");

// 전역 옵션 설정
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

// 라우트 모듈 불러오기 및 V2 Endpoint 내보내기 (Export)

// 1. 카드 기능 모음
const cardRoutes = require("./routes/card");
exports.searchCardByNo = cardRoutes.searchCardByNo;
exports.searchCardByName = cardRoutes.searchCardByName;
exports.getCardFullMetaByCid = cardRoutes.getCardFullMetaByCid;
exports.getCardsMetaBatch = cardRoutes.getCardsMetaBatch;
exports.crawlCardMetaByName = cardRoutes.crawlCardMetaByName;
exports.getRamMemoryStats = cardRoutes.getRamMemoryStats;
exports.searchCard = cardRoutes.searchCard;
exports.addCards = cardRoutes.addCards;
exports.moveCards = cardRoutes.moveCards;
exports.discardCards = cardRoutes.discardCards;
exports.suggestCardNames = cardRoutes.suggestCardNames;
exports.syncCardManifestToStorage = cardRoutes.syncCardManifestToStorage;

// 2. 팩 기능 모음
const packRoutes = require("./routes/pack");
exports.searchPackNew = packRoutes.searchPackNew;
exports.getPackCids = packRoutes.getPackCids;
exports.crawlPackBatchNew = packRoutes.crawlPackBatchNew;

// 3. 사용자 관련 모음
const userRoutes = require("./routes/user");
exports.getInitialData = userRoutes.getInitialData;
exports.getUserData = userRoutes.getUserData;
exports.updateUserSettings = userRoutes.updateUserSettings;
exports.clearUserData = userRoutes.clearUserData;
exports.updateNickname = userRoutes.updateNickname;

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

// 6. 자동 크롤링 모음
const schedulerRoutes = require("./routes/scheduler");
exports.autoCrawlFull = schedulerRoutes.autoCrawlFull;
exports.autoCrawlQuick = schedulerRoutes.autoCrawlQuick;
exports.autoCrawlTask = schedulerRoutes.autoCrawlTask;
exports.triggerAutoCrawl = schedulerRoutes.triggerAutoCrawl;
exports.migrateCardNumbersField = schedulerRoutes.migrateCardNumbersField;

// 7. 관리 도구 모음
const buildIndexRoutes = require("./routes/buildIndex");
exports.buildIndex = buildIndexRoutes.buildIndex;



// 공지 및 시스템 관리자 권한 API
const noticesAdminRoutes = require("./routes/noticesAdmin");
exports.manageNotice = noticesAdminRoutes.manageNotice;
exports.manageAdminRole = noticesAdminRoutes.manageAdminRole;

// 8. 덱 기능 모음
const deckRoutes = require("./routes/deck");
exports.searchDeck = deckRoutes.searchDeck;
exports.getDeckCards = deckRoutes.getDeckCards;


