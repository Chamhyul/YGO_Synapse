const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../config/firebase');
const { setCors } = require('../../utils/auth');
const { safeErrorSummary } = require('../../utils/safeError');

function createAccessHandler(auth, cors, summarizeError) {
  return async (req, res) => {
    cors(res, req);
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || !header.slice(7)) {
      return res.status(401).json({ success: false });
    }
    let decoded;
    try {
      // 철회된 토큰과 비활성 계정도 거부한다. 에뮬레이터 JWT 우회는 사용하지 않는다.
      decoded = await auth.verifyIdToken(header.slice(7), true);
    } catch (_) {
      return res.status(401).json({ success: false });
    }
    try {
      const user = await auth.getUser(decoded.uid);
      if (user.disabled) return res.status(401).json({ success: false });
      const claims = user.customClaims || {};
      const isAdmin = claims.admin === true || claims.role === 'admin' || claims.role === 'owner';
      if (!isAdmin) return res.status(403).json({ success: false });
      if (req.body?.scope === 'settings' && claims.role !== 'owner') {
        return res.status(403).json({ success: false });
      }
      return res.json({ success: true, role: claims.role === 'owner' ? 'owner' : 'admin' });
    } catch (error) {
      console.error('[AdminAccess] 권한 확인 실패:', summarizeError(error));
      return res.status(503).json({ success: false });
    }
  };
}

exports.createAccessHandler = createAccessHandler;
exports.checkAdminAccess = onRequest(
  { invoker: 'public', timeoutSeconds: 30, memory: '256MiB' },
  createAccessHandler(admin.auth(), setCors, safeErrorSummary)
);
