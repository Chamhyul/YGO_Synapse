// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { downloadProductionFile } = require('../config/firebase');
const { isLocal } = require('../services/publicReadTransport');
const { createHandler, createLimiter, createProductionIllustrationHandler } = require('../services/illustrationDelivery');

exports.getIllustration = onRequest({ invoker: 'public', memory: '256MiB',
  timeoutSeconds: 15, maxInstances: 5, concurrency: 20 },
(req, res) => (isLocal() ? localHandler : productionHandler)(req, res));
const localHandler = createProductionIllustrationHandler();
const productionHandler = createHandler({ download: downloadProductionFile, allow: createLimiter() });
