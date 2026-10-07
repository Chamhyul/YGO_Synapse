const { onRequest } = require('firebase-functions/v2/https');
const { createAdminOperationRequestHandler } = require('../../services/adminActionTransport');
const routes = {
  checkAdminAccess: './access', manageNotice: './notices', manageAdminRole: './notices',
  triggerAutoCrawl: './autoCrawler', migrateCardNumbersField: './cardNumbers',
  rebuildCardNames: './cardIndexes', migrateCardIllustrations: './cardIllustrations',
  uploadMembershipCsv: '../integration',
};
exports.adminHandleOperationRequest = onRequest(
  { invoker: 'public', timeoutSeconds: 540, memory: '512MiB' },
  createAdminOperationRequestHandler(operation => require(routes[operation])[operation])
);
