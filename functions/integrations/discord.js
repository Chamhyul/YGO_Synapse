const axios = require("axios");

/**
 * OAuth Code를 이용해 Discord Access Token 및 사용자 정보를 취득합니다.
 */
async function getDiscordUserWithCode(code, redirectUri, clientId, clientSecret) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri
  });

  try {
    const tokenRes = await axios.post("https://discord.com/api/v10/oauth2/token", params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const accessToken = tokenRes.data.access_token;

    const userRes = await axios.get("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return {
      id: userRes.data.id,
      username: userRes.data.username,
      discriminator: userRes.data.discriminator,
      avatar: userRes.data.avatar
    };
  } catch (err) {
    if (err.response) {
      console.error("[Discord OAuth Error]", err.config?.url, err.response.status, JSON.stringify(err.response.data));
    }
    throw err;
  }
}

/**
 * Bot Token을 이용해 해당 유저가 특정 디스코드 서버(Guild)의 멤버인지, 
 * 그리고 지정된 멤버십 Role ID를 소지하고 있는지 검사합니다.
 */
async function checkGuildMemberRole(botToken, guildId, discordUserId, targetRoleId) {
  try {
    const memberRes = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`, {
      headers: {
        Authorization: `Bot ${botToken}`
      }
    });

    const roles = memberRes.data.roles || [];
    const hasRole = roles.includes(targetRoleId);

    return {
      isMember: true,
      hasRole: hasRole,
      roles: roles,
      user: memberRes.data.user
    };
  } catch (err) {
    if (err.response) {
      console.error("[Discord API Error]", err.config?.url, err.response.status, JSON.stringify(err.response.data));
      if (err.response.status === 404) {
        // 해당 디스코드 서버에 가입되어 있지 않은 경우
        return {
          isMember: false,
          hasRole: false,
          roles: []
        };
      }
    }
    throw err;
  }
}

module.exports = {
  getDiscordUserWithCode,
  checkGuildMemberRole
};
