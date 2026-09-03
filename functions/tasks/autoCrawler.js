const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { resumeAutoCrawl } = require("../services/autoCrawlerService");

exports.autoCrawlTask = onTaskDispatched({
  retryConfig: {
    maxAttempts: 1,
    minBackoffSeconds: 60,
  },
  rateLimits: {
    maxConcurrentDispatches: 1,
  },
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (req) => {
  return resumeAutoCrawl(req.data);
});

