const { onRequest } = require('firebase-functions/v2/https');
const { createAdminOperationRequestHandler } = require('../../services/adminActionTransport');
const { createAdminOperationResolver } = require('../../services/adminOperationRegistry');
const serviceRoutes = {
  checkAdminAccess: './access', manageNotice: './notices', manageAdminRole: './notices',
  uploadMembershipCsv: '../integration',
};
const cardRoutes = {
  triggerAutoCrawl: './autoCrawler', migrateCardNumbersField: './cardNumbers',
  rebuildCardNames: './cardIndexes', migrateCardIllustrations: './cardIllustrations',
};
// 현재는 같은 프로세스의 기존 핸들러를 호출한다. 원격 API나 계정 전환을 활성화하지 않는다.
const resolveOperation = createAdminOperationResolver({
  resolveCardOperation: operation => require(cardRoutes[operation])[operation],
  resolveServiceOperation: operation => require(serviceRoutes[operation])[operation],
});
exports.adminHandleOperationRequest = onRequest(
  { invoker: 'public', timeoutSeconds: 540, memory: '512MiB' },
  createAdminOperationRequestHandler(resolveOperation)
);
