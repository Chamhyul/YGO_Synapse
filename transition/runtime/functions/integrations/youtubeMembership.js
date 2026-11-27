'use strict';
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// 채널 ID는 요청 본문에서 받지 않는다. Google이 인증한 계정의 채널만 사용한다.
async function getOwnedYoutubeChannel(accessToken, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50', {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
  } catch (_) { throw fail(503, 'YOUTUBE_UNAVAILABLE', 'YouTube에 연결하지 못했습니다. 다시 인증해 주세요.'); }
  if (!response.ok) throw fail(response.status === 401 ? 401 : response.status === 403 ? 403 : 503,
    'YOUTUBE_AUTH_FAILED', 'YouTube 채널을 확인하지 못했습니다. 계정과 승인한 권한을 확인해 주세요.');
  let data;
  try { data = await response.json(); } catch (_) { throw fail(503, 'YOUTUBE_UNAVAILABLE', 'YouTube 응답을 확인하지 못했습니다.'); }
  if (!Array.isArray(data.items) || data.items.length !== 1 || !CHANNEL.test(data.items[0]?.id)) {
    throw fail(400, 'YOUTUBE_CHANNEL_REQUIRED', '사용할 YouTube 채널 하나를 선택한 계정으로 다시 인증해 주세요.');
  }
  return data.items[0].id;
}

module.exports = { getOwnedYoutubeChannel };
