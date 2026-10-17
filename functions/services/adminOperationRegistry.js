// 관리자 인증은 각 기존 핸들러가 수행한다. 이 목록은 전달 대상만 구분한다.
const CARD_OPERATIONS = Object.freeze(['triggerAutoCrawl', 'migrateCardNumbersField', 'rebuildCardNames', 'migrateCardIllustrations']);
const SERVICE_OPERATIONS = Object.freeze(['checkAdminAccess', 'manageNotice', 'manageAdminRole', 'uploadMembershipCsv']);
const ADMIN_OPERATIONS = Object.freeze([...SERVICE_OPERATIONS, ...CARD_OPERATIONS]);
function createAdminOperationResolver({ resolveCardOperation, resolveServiceOperation }) {
  return operation => {
    if (CARD_OPERATIONS.includes(operation)) return resolveCardOperation(operation);
    if (SERVICE_OPERATIONS.includes(operation)) return resolveServiceOperation(operation);
    throw new Error('허용되지 않은 관리자 작업입니다.');
  };
}
module.exports = { CARD_OPERATIONS, SERVICE_OPERATIONS, ADMIN_OPERATIONS, createAdminOperationResolver };
