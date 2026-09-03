const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { runCardIndexTask } = require('../services/cardIndexTaskService');

exports.processCardIndexTask = onTaskDispatched({
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1 },
  memory: '512MiB', timeoutSeconds: 540, maxInstances: 1,
}, async req => runCardIndexTask(req.data?.runId));
