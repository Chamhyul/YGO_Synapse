const { createLimiter } = require('./illustrationDelivery');
function createPublicReadHandlers({ isLocal, verifyAppCheck, verifyUser, getVerifiedAccountRole, db, setCors }) {
  const allowCards = createLimiter(600);
  const allowIdentity = createLimiter(120);
  async function prepare(req, res, allow) {
    setCors(res, req);
    res.set('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return false; }
    if (isLocal()) { res.status(503).json({ success: false }); return false; }
    if (req.method !== 'POST') { res.status(405).json({ success: false }); return false; }
    if (!await verifyAppCheck(req, res)) return false;
    if (!allow(req.ip)) { res.status(429).json({ success: false }); return false; }
    res.set('X-YGO-Public-Read', '1');
    return true;
  }
  const serialize = doc => {
    const data = doc.data();
    // 공개 카드의 필요한 필드만 반환하고 내부 이력은 노출하지 않는다.
    return { cid: doc.id, data: { names: data.names || [], numbers: data.numbers || [], info: data.info || {} } };
  };
  return {
    async getPublicCardData(req, res) {
      if (!await prepare(req, res, allowCards)) return;
      const { cids, field, value } = req.body || {};
      const batch = Array.isArray(cids) && cids.length > 0 && cids.length <= 100
        && cids.every(cid => typeof cid === 'string' && /^[1-9]\d{0,9}$/.test(cid)) && field === undefined && value === undefined;
      const query = cids === undefined && ['names', 'numbers'].includes(field)
        && typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
      if (!batch && !query) return res.status(400).json({ success: false });
      try {
        const docs = batch ? await db.getAll(...[...new Set(cids)].map(cid => db.collection('cards').doc(cid)))
          : (await db.collection('cards').where(field, 'array-contains', value).limit(101).get()).docs;
        if (docs.length > 100) return res.status(400).json({ success: false });
        return res.json({ success: true, cards: docs.filter(doc => doc.exists).map(serialize) });
      } catch (_) { return res.status(503).json({ success: false }); }
    },
    async verifyUserIdentity(req, res) {
      if (!await prepare(req, res, allowIdentity)) return;
      const uid = await verifyUser(req, res);
      if (!uid) return;
      if (req.body?.includeAccountRole !== undefined && typeof req.body.includeAccountRole !== 'boolean') return res.status(400).json({ success: false });
      if (!req.body?.includeAccountRole) return res.json({ success: true, uid });
      try {
        const accountRole = await getVerifiedAccountRole(req, uid);
        return res.json({ success: true, uid, accountRole, accountRoleVersion: 1 });
      } catch (_) { return res.status(503).json({ success: false, code: 'ACCOUNT_ROLE_UNAVAILABLE', message: '현재 계정 권한을 확인하지 못했습니다.' }); }
    },
  };
}
module.exports = { createPublicReadHandlers };
