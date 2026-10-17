const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { CARD_WORKER_OPTIONS } = require('../config/serviceAccounts');
const { processCardIllustrationsMigration } = require('../services/cardIllustrationsMigrationService');

exports.migrateCardIllustrationsTask = onTaskDispatched({
  ...CARD_WORKER_OPTIONS,
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1 },
  region: 'asia-northeast3',
  memory: '256MiB',
  timeoutSeconds: 540,
}, req => processCardIllustrationsMigration(req.data));
