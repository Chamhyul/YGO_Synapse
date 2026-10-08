const { onRequest } = require('firebase-functions/v2/https');
const { db, admin, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_CLIENT_SECRET } = require('../config/firebase');
const { isLocal } = require('../services/publicReadTransport');
const { verifyAppCheck, verifyRegisteredUser, setCors } = require('../utils/auth');
const { forwardDiscordMembership } = require('../services/discordMembershipTransport');
const { createDiscordMembershipHandlers } = require('../services/discordMembership');
const { getDiscordMembershipWithCode } = require('../integrations/discordMembership');
const handlers = createDiscordMembershipHandlers({ db, auth: admin.auth(), isLocal, verifyAppCheck,
  verifyRegisteredUser, setCors, forward: forwardDiscordMembership,
  clientId: DISCORD_CLIENT_ID, guildId: DISCORD_GUILD_ID,
  getMembership: getDiscordMembershipWithCode, getClientSecret: () => DISCORD_CLIENT_SECRET.value() });
const options = { invoker: 'public', timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 };
exports.startDiscordMembershipVerification = onRequest(options, handlers.startDiscordMembershipVerification);
// 로컬 라우트는 비밀정보를 읽지 않으며 운영 라우트만 Secret Manager를 사용한다.
exports.verifyDiscordMembership = onRequest({ ...options, ...(isLocal() ? {} : { secrets: [DISCORD_CLIENT_SECRET] }) }, handlers.verifyDiscordMembership);
