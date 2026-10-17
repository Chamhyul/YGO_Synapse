const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { CARD_WORKER_OPTIONS } = require('../config/serviceAccounts');
const { resumeAutoCrawl } = require("../services/autoCrawlerService");

exports.autoCrawlTask = onTaskDispatched({
  ...CARD_WORKER_OPTIONS,
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 60,
  },
  rateLimits: {
    maxConcurrentDispatches: 1,
  },
  region: "asia-northeast3",
  memory: "512MiB",
  timeoutSeconds: 540,
}, async (req) => {
  return resumeAutoCrawl(req.data);
});
