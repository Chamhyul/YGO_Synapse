'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { createLookupMaintenance } = require('../services/membershipCsvLookupMaintenance');
exports.membershipCsvPrepareLookup = onRequest({ invoker: 'private', memory: '256MiB',
  maxInstances: 1, concurrency: 1, timeoutSeconds: 120 }, createLookupMaintenance({
  select: () => require('../services/membershipProviderRuntime').resolveMembershipProviderRuntime(),
}));
