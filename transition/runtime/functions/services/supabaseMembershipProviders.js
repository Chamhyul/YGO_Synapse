'use strict';

const { getDiscordMembershipWithCode, DISCORD_REDIRECTS, discordMembershipLevel, discordAuthorizationUrl } =
  require('../integrations/discordMembership.js');
const { getOwnedYoutubeChannel } = require('../integrations/youtubeMembership.js');

const unavailable = () => Object.assign(Error('MEMBERSHIP_PROVIDER_UNAVAILABLE'), { status:503 });
const changed = () => Object.assign(Error('MEMBERSHIP_ROSTER_CHANGED'), { status:409 });

function createMembershipProviders({ database, discord, fetchImpl = fetch }) {
  async function roster(client, channelId = null) {
    const { rows:[row] } = await client.query(`
      select state.revision::text, member.level_name as "levelName"
      from app.youtube_roster_state state
      left join app.youtube_roster_members member on member.channel_id=$1
      where state.singleton`, [channelId]);
    if (!row) throw unavailable();
    return row;
  }
  const providers = {
    youtube:{
      ready:()=>roster(database.pool),
      async verify(accessToken) {
        const accountId = await getOwnedYoutubeChannel(accessToken, fetchImpl);
        const { revision, levelName } = await roster(database.pool, accountId);
        return { accountId, levelName, status:levelName ? 'active' : 'none', rosterRevision:revision };
      },
      async confirm(client, result) {
        if ((await roster(client)).revision !== result.rosterRevision) throw changed();
      },
    },
  };
  if (discord) {
    const { clientId, guildId, clientSecret, redirectUri } = discord;
    if (![clientId,guildId].every(value=>typeof value==='string' && /^\d{17,20}$/.test(value)) ||
        typeof clientSecret!=='string' || !clientSecret || !DISCORD_REDIRECTS.has(redirectUri)) throw unavailable();
    providers.discord = {
      authorizationUrl:(nonce, redirect = redirectUri)=>discordAuthorizationUrl(clientId,redirect,nonce),
      async verify(code, redirect = redirectUri) {
        if (!DISCORD_REDIRECTS.has(redirect)) throw unavailable();
        const { discordId:accountId, roles } = await getDiscordMembershipWithCode({ code,...discord,redirectUri:redirect },fetchImpl,(_stage,work)=>work());
        const levelName = discordMembershipLevel(roles);
        return { accountId, levelName, status:levelName ? 'active' : 'none' };
      },
    };
  }
  return providers;
}

module.exports = { createMembershipProviders };
