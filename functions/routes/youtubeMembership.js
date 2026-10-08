const { onRequest } = require('firebase-functions/v2/https');
const { db, admin } = require('../config/firebase');
const { isLocal } = require('../services/publicReadTransport');
const { verifyAppCheck, verifyRegisteredUser, setCors } = require('../utils/auth');
const { forwardYoutubeMembership } = require('../services/youtubeMembershipTransport');
const { createYoutubeMembershipHandlers } = require('../services/youtubeMembership');
const handlers = createYoutubeMembershipHandlers({ db, auth: admin.auth(), isLocal,
  verifyAppCheck, verifyRegisteredUser, setCors, forward: forwardYoutubeMembership });
const options = { invoker: 'public', timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 };
exports.startYoutubeMembershipVerification = onRequest(options, handlers.startYoutubeMembershipVerification);
exports.verifyYoutubeMembership = onRequest(options, handlers.verifyYoutubeMembership);
