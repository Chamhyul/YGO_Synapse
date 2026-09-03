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

// HTTP 라우트 등록. 실제 처리 로직은 서비스·크롤러에서 수행합니다.

// 1. 카드 기능 모음
const cardRoutes = require("./routes/card");
exports.searchCardByNo = cardRoutes.searchCardByNo;
exports.searchCardByName = cardRoutes.searchCardByName;
exports.getCardMetadata = cardRoutes.getCardMetadata;
exports.getCardsMetaBatch = cardRoutes.getCardsMetaBatch;
exports.crawlCardMetaByName = cardRoutes.crawlCardMetaByName;
exports.getRamMemoryStats = cardRoutes.getRamMemoryStats;
exports.searchCard = cardRoutes.searchCard;
exports.resolveCardNames = cardRoutes.resolveCardNames;
exports.addCards = cardRoutes.addCards;
exports.moveCards = cardRoutes.moveCards;
exports.discardCards = cardRoutes.discardCards;
exports.suggestCardNames = cardRoutes.suggestCardNames;

// 2. 팩 기능 모음
const packRoutes = require("./routes/pack");
exports.searchPack = packRoutes.searchPack;
exports.getPackCids = packRoutes.getPackCids;
exports.crawlPackCardsBatch = packRoutes.crawlPackCardsBatch;

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

// 관리자용 HTTP 라우트
const crawlerAdmin = require("./routes/admin/autoCrawler");
const cardNumbersAdmin = require("./routes/admin/cardNumbers");
const cardIndexesAdmin = require("./routes/admin/cardIndexes");
exports.triggerAutoCrawl = crawlerAdmin.triggerAutoCrawl;
exports.migrateCardNumbersField = cardNumbersAdmin.migrateCardNumbersField;
exports.rebuildCardNames = cardIndexesAdmin.rebuildCardNames;

// 예약 실행 및 작업 큐 진입점
const crawlerSchedules = require("./schedules/autoCrawler");
exports.autoCrawlFull = crawlerSchedules.autoCrawlFull;
exports.autoCrawlQuick = crawlerSchedules.autoCrawlQuick;
exports.processCardIndexTask = require("./tasks/cardIndexes").processCardIndexTask;
exports.processCardIndexUpdates = require("./schedules/cardIndexes").processCardIndexUpdates;
exports.autoCrawlTask = require("./tasks/autoCrawler").autoCrawlTask;
exports.migrateCardNumbersTask = require("./tasks/cardNumbers").migrateCardNumbersTask;

// 공지 및 시스템 관리자 권한 API
const noticesAdminRoutes = require("./routes/admin/notices");
exports.manageNotice = noticesAdminRoutes.manageNotice;
exports.manageAdminRole = noticesAdminRoutes.manageAdminRole;

// 8. 덱 기능 모음
const deckRoutes = require("./routes/deck");
exports.searchDeck = deckRoutes.searchDeck;
exports.getDeckCards = deckRoutes.getDeckCards;


// 클라이언트 전환 기간에만 유지합니다. 기존 탭과 이전 클라이언트의 주소 호환용입니다.
exports.searchPackNew = packRoutes.searchPack;
exports.crawlPackBatchNew = packRoutes.crawlPackCardsBatch;
exports.getCardFullMetaByCid = cardRoutes.getCardMetadata;
