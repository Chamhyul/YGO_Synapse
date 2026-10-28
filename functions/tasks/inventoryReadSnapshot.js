'use strict';
const { onValueWritten } = require('firebase-functions/v2/database');
const { createInventorySnapshotWorker } = require('../services/inventorySnapshotWorker');
const options = { instance: 'ygo-synapse-default-rtdb', region: 'asia-southeast1', retry: true,
  timeoutSeconds: 60, memory: '256MiB', maxInstances: 3, concurrency: 1 };
exports.refreshInventoryReadSnapshot = onValueWritten({ ...options, ref: '/inventories/{userKey}/revision' }, createInventorySnapshotWorker());
exports.prepareInventoryReadSnapshot = onValueWritten({ ...options, ref: '/inventoryReadSnapshotRequests/{runKey}/{userKey}' }, createInventorySnapshotWorker());
