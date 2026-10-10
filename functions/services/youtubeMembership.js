const { resolveAccountRole, normalizeSourceMembership, resolveEffectiveMembership } = require('./membershipPolicy');
const { randomBytes, createHash } = require('node:crypto');
const { createFirestoreMembershipCsvStore } = require('./membershipCsvService');
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => createHash('sha256').update(value).digest('hex');

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

function createYoutubeMembershipHandlers({ db, auth, isLocal, verifyAppCheck, verifyRegisteredUser, setCors,
  forward, fetchImpl = fetch, now = Date.now }) {
  async function handle(req, res, operation) {
    setCors(res, req);
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청만 허용합니다.' });
    if (!(await verifyAppCheck(req, res))) return;
    const uid = await verifyRegisteredUser(req, res);
    if (!uid) return;
    const body = req.body || {};
    try {
      if (typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'YOUTUBE_INVALID_REQUEST', '인증 요청 형식이 올바르지 않습니다.');
      if ('userChannelId' in body || req.query?.userChannelId) throw fail(400, 'YOUTUBE_PROOF_REQUIRED', '채널 ID 대신 YouTube 인증을 진행해 주세요.');
      if (isLocal()) {
        // 로컬은 자격증명 없이 고정 운영 API에서 검증하고, 결과만 로컬에 저장한다.
        const result = await forward(operation, { ...body, localOnly: true }, req.headers);
        if (result.uid !== uid) throw fail(403, 'YOUTUBE_SESSION_CHANGED', '인증한 서비스 계정이 변경되었습니다.');
        if (operation === 'verifyYoutubeMembership') {
          if (result.sourceMembership?.type !== 'csv' || result.sourceMembership?.verificationProvider !== 'youtube' || result.sourceMembership?.verificationVersion !== 2 || !CHANNEL.test(result.sourceMembership?.userChannelId)) throw fail(503, 'YOUTUBE_UNAVAILABLE', '검증 결과를 확인하지 못했습니다.');
          await db.collection('users').doc(uid).set({ settings: { membership: result.sourceMembership } }, { merge: true });
        }
        return res.json(result);
      }
      const ref = db.collection('youtube_membership_verifications').doc(uid);
      if (operation === 'startYoutubeMembershipVerification') {
        if (body.localOnly !== undefined && typeof body.localOnly !== 'boolean') throw fail(400, 'YOUTUBE_INVALID_REQUEST', '인증 요청 형식이 올바르지 않습니다.');
        const verificationId = randomBytes(32).toString('hex');
        const startedAt = now();
        await db.runTransaction(async tx => {
          const previous = (await tx.get(ref)).data();
          if (previous && startedAt - previous.startedAt < 3000) throw fail(429, 'YOUTUBE_TOO_MANY_REQUESTS', '잠시 후 다시 인증해 주세요.');
          tx.set(ref, { nonceHash: hash(verificationId), startedAt, expiresAt: startedAt + 300000,
            consumed: false, localOnly: body.localOnly === true });
        });
        return res.json({ success: true, uid, verificationId });
      }
      const { verificationId, accessToken } = body;
      if (typeof verificationId !== 'string' || !/^[a-f0-9]{64}$/.test(verificationId)
          || typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192 || /[\r\n]/.test(accessToken)) {
        throw fail(400, 'YOUTUBE_PROOF_REQUIRED', '유효한 YouTube 인증 정보가 필요합니다.');
      }
      const nonceHash = hash(verificationId);
      let localOnly;
      await db.runTransaction(async tx => {
        const state = (await tx.get(ref)).data();
        if (!state || state.nonceHash !== nonceHash || state.consumed || state.expiresAt <= now()) {
          throw fail(403, 'YOUTUBE_VERIFICATION_EXPIRED', '인증이 만료되었거나 이미 사용되었습니다. 다시 인증해 주세요.');
        }
        localOnly = state.localOnly;
        tx.update(ref, { consumed: true });
      });
      // 토큰은 이 요청에서만 사용하며 DB·오류 로그에 저장하지 않는다.
      const channelId = await getOwnedYoutubeChannel(accessToken, fetchImpl);
      const account = await auth.getUser(uid);
      if (account.disabled) throw fail(401, 'AUTH_INVALID', '사용할 수 없는 계정입니다.');
      const claims = account.customClaims || {};
      const role = resolveAccountRole(claims);
      const csv = await createFirestoreMembershipCsvStore(db).readMember(channelId);
      const active = !!csv;
      const membership = { status: active ? 'active' : 'none', type: 'csv',
        levelName: csv ? csv.levelName || '유튜브 멤버십' : '일반',
        userChannelId: channelId, verificationVersion: 2, verificationProvider: 'youtube', lastChecked: now() };
      await db.runTransaction(async tx => {
        const state = (await tx.get(ref)).data();
        if (!state || state.nonceHash !== nonceHash || !state.consumed || state.expiresAt <= now()) {
          throw fail(403, 'YOUTUBE_VERIFICATION_EXPIRED', '인증 상태가 변경되었습니다. 다시 인증해 주세요.');
        }
        if (!localOnly) tx.set(db.collection('users').doc(uid), { settings: { membership } }, { merge: true });
      });
      const effective = resolveEffectiveMembership(role, membership);
      return res.json({ success: true, uid, membership: effective, sourceMembership: membership, isMemberActive: effective.status === 'active' });
    } catch (error) {
      // Google 오류 객체에는 인증 정보가 포함될 수 있어 원문을 기록하지 않는다.
      const expected = typeof error.code === 'string' && /^(YOUTUBE_|AUTH_INVALID$)/.test(error.code);
      return res.status(expected ? error.status : 503).json({ success: false,
        code: expected ? error.code : 'YOUTUBE_UNAVAILABLE',
        message: expected ? error.message : '멤버십을 확인하지 못했습니다. 다시 인증해 주세요.' });
    }
  }
  return {
    startYoutubeMembershipVerification: (req, res) => handle(req, res, 'startYoutubeMembershipVerification'),
    verifyYoutubeMembership: (req, res) => handle(req, res, 'verifyYoutubeMembership')
  };
}
// 소유 확인 없이 저장된 과거 CSV 결과는 조회 시 재인증 대상으로 반환한다.
function sanitizeYoutubeMembership(settings) {
  if (settings?.membership?.type !== 'csv') return settings;
  return { ...settings, membership: normalizeSourceMembership(settings.membership) };
}

module.exports = { createYoutubeMembershipHandlers, getOwnedYoutubeChannel, sanitizeYoutubeMembership };
