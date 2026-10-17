const { serializePublicCard } = require('./publicCardContract');
const { createLimiter } = require('./illustrationDelivery');
const { createPublicReadGuard } = require('./publicReadGuard');
function createPublicCardReadHandler({ db, readCards, ...guardOptions }) {
  const prepare = createPublicReadGuard(guardOptions);
  const allowCards = createLimiter(600);
  return async function getPublicCardData(req, res) {
    if (!await prepare(req, res, allowCards)) return;
    const { cids, field, value } = req.body || {};
    const batch = Array.isArray(cids) && cids.length > 0 && cids.length <= 100
      && cids.every(cid => typeof cid === 'string' && /^[1-9]\d{0,9}$/.test(cid)) && field === undefined && value === undefined;
    const query = cids === undefined && ['names', 'numbers'].includes(field)
      && typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
    if (!batch && !query) return res.status(400).json({ success: false });
    try {
      if (readCards) {
        const cards = await readCards(batch ? { cids } : { field, value, limit: 101 });
        if (cards.length > 100) return res.status(400).json({ success: false });
        return res.json({ success: true, cards: cards.map(card => serializePublicCard({ id: card.cid, data: () => card.data })) });
      }
      const docs = batch ? await db.getAll(...[...new Set(cids)].map(cid => db.collection('cards').doc(cid)))
        : (await db.collection('cards').where(field, 'array-contains', value).limit(101).get()).docs;
      if (docs.length > 100) return res.status(400).json({ success: false });
      return res.json({ success: true, cards: docs.filter(doc => doc.exists).map(serializePublicCard) });
    } catch (_) { return res.status(503).json({ success: false }); }
  };
}
module.exports = { createPublicCardReadHandler };
