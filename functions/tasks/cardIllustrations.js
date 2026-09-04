const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { processCardIllustrationsMigration } = require('../services/cardIllustrationsMigrationService');

exports.migrateCardIllustrationsTask = onTaskDispatched({
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1 },
  region: 'asia-northeast3',
  memory: '256MiB',
  timeoutSeconds: 540,
}, req => processCardIllustrationsMigration(req.data));
