const { onRequest } = require('firebase-functions/v2/https');
const { db, FieldValue } = require('../config/firebase');
const { setCors, verifyUser, verifyAppCheck } = require('../utils/auth');
const { safeErrorSummary } = require('../utils/safeError');
const { isRegisteredUser } = require('../services/registrationService');

// 공개 문서의 SHA-256. 문서를 변경할 때 이 버전도 함께 갱신한다.
const CONSENT_VERSIONS = Object.freeze({
  terms: 'a189fde0dce4ec14f7ae6b8b495674e42b455f1d453d785084ffd5a083dca7ca',
  privacy: '227208e70b6de548fd8e081b50a0b01dd2adc6537d3c8d05fa80e60879ada2e8',
});

async function prepare(req, res, method) {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return null; }
  if (req.method !== method) { res.status(405).json({ success: false, message: `${method} 요청을 사용하세요.` }); return null; }
  if (!(await verifyAppCheck(req, res))) return null;
  return verifyUser(req, res);
}

exports.getRegistrationStatus = onRequest({ invoker: 'public' }, async (req, res) => {
  const uid = await prepare(req, res, 'GET');
  if (!uid) return;
  try {
    return res.json({ success: true, registered: await isRegisteredUser(uid), consentVersions: CONSENT_VERSIONS });
  } catch (error) {
    console.error('Registration status failed:', safeErrorSummary(error));
    return res.status(503).json({ success: false, message: '가입 상태를 확인하지 못했습니다. 다시 시도해 주세요.' });
  }
});

exports.completeRegistration = onRequest({ invoker: 'public' }, async (req, res) => {
  const uid = await prepare(req, res, 'POST');
  if (!uid) return;
  const { agreements, consentVersions } = req.body || {};
  if (agreements?.terms !== true || agreements?.privacy !== true) {
    return res.status(400).json({ success: false, message: '이용 약관과 개인정보 처리방침에 모두 동의해 주세요.' });
  }
  if (consentVersions?.terms !== CONSENT_VERSIONS.terms || consentVersions?.privacy !== CONSENT_VERSIONS.privacy) {
    return res.status(409).json({ success: false, code: 'CONSENT_VERSION_CHANGED', message: '문서가 변경되었습니다. 동의 화면을 다시 열어 주세요.' });
  }
  try {
    // 기존 데이터·가입일·동의 기록을 덮어쓰지 않는다. 재요청도 같은 결과를 반환한다.
    if (!(await isRegisteredUser(uid))) {
      const ref = db.collection('users').doc(uid);
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) return;
        transaction.create(ref, {
          createdAt: FieldValue.serverTimestamp(),
          registration: {
            completed: true,
            consent: { terms: CONSENT_VERSIONS.terms, privacy: CONSENT_VERSIONS.privacy,
              acceptedAt: FieldValue.serverTimestamp() },
          },
        });
      });
    }
    return res.json({ success: true, registered: true });
  } catch (error) {
    console.error('Registration completion failed:', safeErrorSummary(error));
    return res.status(503).json({ success: false, message: '가입을 완료하지 못했습니다. 다시 시도해 주세요.' });
  }
});
