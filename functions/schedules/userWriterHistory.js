'use strict';
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { createWriterHistoryMaintenanceHandler } = require('../services/writerHistoryMaintenance');

// 배포 탐색 시에도 확정 가능한 기존 Job 계정을 사용한다. 일반 함수/카드 계정은 유지한다.
const emulator = Object.entries(process.env).some(([key, value]) => key.includes('EMULATOR') && value);
const account = !emulator && process.env.GCLOUD_PROJECT === 'ygo-synapse'
  ? { serviceAccount: 'user-storage-writer@ygo-synapse.iam.gserviceaccount.com' } : {};

exports.compactUserWriterHistory = onSchedule({
  ...account,
  schedule: '* * * * *', timeZone: 'Asia/Seoul', region: 'asia-northeast3',
  memory: '256MiB', cpu: 1, timeoutSeconds: 120, concurrency: 1, maxInstances: 1,
  retryCount: 3, minBackoffSeconds: 30, maxBackoffSeconds: 120,
}, createWriterHistoryMaintenanceHandler());
