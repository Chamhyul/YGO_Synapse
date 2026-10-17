const { createLimiter } = require('./illustrationDelivery');
const { createPublicReadGuard } = require('./publicReadGuard');
function createUserIdentityHandler({ verifyUser, getVerifiedAccountRole, ...guardOptions }) {
  const prepare = createPublicReadGuard(guardOptions);
  const allowIdentity = createLimiter(120);
  return async function verifyUserIdentity(req, res) {
    if (!await prepare(req, res, allowIdentity)) return;
    const uid = await verifyUser(req, res);
    if (!uid) return;
    if (req.body?.includeAccountRole !== undefined && typeof req.body.includeAccountRole !== 'boolean') return res.status(400).json({ success: false });
    if (!req.body?.includeAccountRole) return res.json({ success: true, uid });
    try {
      const accountRole = await getVerifiedAccountRole(req, uid);
      return res.json({ success: true, uid, accountRole, accountRoleVersion: 1 });
    } catch (_) { return res.status(503).json({ success: false, code: 'ACCOUNT_ROLE_UNAVAILABLE', message: '현재 계정 권한을 확인하지 못했습니다.' }); }
  };
}
module.exports = { createUserIdentityHandler };
