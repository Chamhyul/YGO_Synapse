const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { CARD_WORKER_OPTIONS } = require('../config/serviceAccounts');
const { processCardNumbersMigration } = require("../services/cardNumbersMigrationService");

exports.migrateCardNumbersTask = onTaskDispatched({
  ...CARD_WORKER_OPTIONS,
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
  rateLimits: { maxConcurrentDispatches: 1 },
  region: "asia-northeast3",
  memory: "256MiB",
  timeoutSeconds: 120,
}, async (req) => {
  return processCardNumbersMigration(req.data);
});
