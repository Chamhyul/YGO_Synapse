const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { processCardNumbersMigration } = require("../services/cardNumbersMigrationService");

exports.migrateCardNumbersTask = onTaskDispatched({
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
  rateLimits: { maxConcurrentDispatches: 1 },
  region: "asia-northeast3",
  memory: "512MiB",
  timeoutSeconds: 120,
}, async (req) => {
  return processCardNumbersMigration(req.data);
});