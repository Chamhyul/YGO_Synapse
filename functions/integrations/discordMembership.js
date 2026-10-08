const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const ID = /^\d{17,20}$/;
// 사용자 동의 토큰으로 본인 계정과 본인의 서버 역할만 읽는다. 봇 토큰은 사용하지 않는다.
async function getDiscordMembershipWithCode({ code, redirectUri, clientId, clientSecret, guildId }, fetchImpl = fetch) {
  async function request(url, options, allowMissing = false) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch (_) { throw fail(503, 'DISCORD_UNAVAILABLE', 'Discord에 연결하지 못했습니다. 다시 인증해 주세요.'); }
    let data;
    try { data = await response.json(); } catch (_) { throw fail(503, 'DISCORD_UNAVAILABLE', 'Discord 응답을 확인하지 못했습니다.'); }
    if (allowMissing && response.status === 404 && [10004, 10007].includes(data.code)) return null;
    if (!response.ok) throw fail(response.status === 429 ? 429 : [400,401,403].includes(response.status) ? 403 : 503,
      'DISCORD_AUTH_FAILED', 'Discord 계정과 승인한 권한을 확인하고 다시 인증해 주세요.');
    return data;
  }
  const token = await request('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString()
  });
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [];
  if (typeof token.access_token !== 'string' || !token.access_token || /[\r\n]/.test(token.access_token)
      || !scopes.includes('identify') || !scopes.includes('guilds.members.read') || token.token_type?.toLowerCase() !== 'bearer') {
    throw fail(403, 'DISCORD_SCOPE_REQUIRED', '계정 확인과 서버 역할 조회 권한에 동의해 주세요.');
  }
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const user = await request('https://discord.com/api/v10/users/@me', { headers });
  if (!ID.test(user?.id)) throw fail(503, 'DISCORD_UNAVAILABLE', 'Discord 계정 정보를 확인하지 못했습니다.');
  const member = await request(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, { headers }, true);
  if (member && (!Array.isArray(member.roles) || !member.roles.every(role => typeof role === 'string' && ID.test(role))
      || (member.user && member.user.id !== user.id))) throw fail(503, 'DISCORD_UNAVAILABLE', 'Discord 역할 정보를 확인하지 못했습니다.');
  return { discordId: user.id, roles: member?.roles || [] };
}
module.exports = { getDiscordMembershipWithCode };
