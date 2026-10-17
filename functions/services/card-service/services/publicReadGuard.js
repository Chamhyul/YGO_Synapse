const { VERSION } = require('./publicCardContract');
function createPublicReadGuard({ isLocal, verifyAppCheck, setCors }) {
  return async function prepare(req, res, allow) {
    setCors(res, req);
    res.set('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return false; }
    if (isLocal()) { res.status(503).json({ success: false }); return false; }
    if (req.method !== 'POST') { res.status(405).json({ success: false }); return false; }
    if (!await verifyAppCheck(req, res)) return false;
    if (!allow(req.ip)) { res.status(429).json({ success: false }); return false; }
    res.set('X-YGO-Public-Read', VERSION);
    return true;
  };
}
module.exports = { createPublicReadGuard };
