// 로컬 멤버십 검증은 운영 서버만 신뢰한다. 운영 권한키·임의 URL은 사용하지 않는다.
async function forwardYoutubeMembership(operation, body, headers, fetchImpl = fetch) {
  if (!['startYoutubeMembershipVerification', 'verifyYoutubeMembership'].includes(operation)) throw new Error('허용되지 않은 인증 요청');
  const authorization = headers?.authorization;
  const appCheck = headers?.['x-firebase-appcheck'];
  if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)
      || typeof appCheck !== 'string' || !appCheck || appCheck.length > 8192) throw new Error('인증 정보 누락');
  const response = await fetchImpl(`https://asia-northeast3-ygo-synapse.cloudfunctions.net/${operation}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: authorization, 'X-Firebase-AppCheck': appCheck },
    body: JSON.stringify(body)
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('응답 형식 오류');
  const result = await response.json();
  if (!response.ok || result?.success !== true) {
    // 운영의 고정 오류 코드만 전달하고 원문·토큰은 노출하지 않는다.
    const code = typeof result?.code === 'string' && /^YOUTUBE_[A-Z_]+$/.test(result.code) ? result.code : 'YOUTUBE_UNAVAILABLE';
    throw Object.assign(new Error('운영 서버에서 YouTube 인증을 완료하지 못했습니다. 다시 인증해 주세요.'),
      { code, status: [400, 401, 403, 429].includes(response.status) ? response.status : 503 });
  }
  return result;
}
module.exports = { forwardYoutubeMembership };
