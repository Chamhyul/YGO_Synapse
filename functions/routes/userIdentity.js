const { onRequest } = require('firebase-functions/v2/https');
const { isLocal } = require('../services/publicReadTransport');
const { verifyAppCheck, verifyUser, getVerifiedAccountRole, setCors } = require('../utils/auth');
const { createUserIdentityHandler } = require('../services/userIdentityApi');
const options = { invoker: 'public', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, concurrency: 20 };
exports.verifyUserIdentity = onRequest(options, createUserIdentityHandler({ isLocal, verifyAppCheck, verifyUser, getVerifiedAccountRole, setCors }));
