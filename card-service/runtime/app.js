'use strict';
const express = require('express');
const { serializePublicCard } = require('../src/services/publicCardContract');
const { createCardResourcesReader } = require('../src/services/cardResources');

function createReadApp({ db, resources, authenticate }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ success: true, service: 'card-read' }));
  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try { if (!await authenticate(req)) return res.status(401).json({ success: false }); }
    catch (_) { return res.status(401).json({ success: false }); }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.post('/v1/cards/read', async (req, res) => {
    const { cids, field, value, limit } = req.body || {};
    const batch = Array.isArray(cids) && cids.length > 0 && cids.length <= 100
      && cids.every(cid => typeof cid === 'string' && /^[1-9]\d{0,9}$/.test(cid))
      && field === undefined && value === undefined && limit === undefined;
    const query = cids === undefined && ['names', 'numbers'].includes(field)
      && typeof value === 'string' && value.trim().length > 0 && value.length <= 300
      && (limit === undefined || Number.isInteger(limit) && limit >= 1 && limit <= 101);
    if ((!batch && !query) || Object.keys(req.body).some(key => !['cids', 'field', 'value', 'limit'].includes(key))) {
      return res.status(400).json({ success: false });
    }
    try {
      let docs;
      if (batch) docs = await db.getAll(...[...new Set(cids)].map(cid => db.collection('cards').doc(cid)));
      else {
        let query = db.collection('cards').where(field, 'array-contains', value);
        if (limit) query = query.limit(limit);
        docs = (await query.get()).docs;
      }
      const cards = docs.filter(doc => doc.exists).map(doc => {
        const card = serializePublicCard(doc), data = doc.data();
        // 상세 응답에 필요한 카드 필드만 추가한다. 내부 이력·다른 컬렉션은 노출하지 않는다.
        if (typeof data.name === 'string') card.data.name = data.name;
        if (data.raritiesByNo && typeof data.raritiesByNo === 'object' && !Array.isArray(data.raritiesByNo)) {
          card.data.raritiesByNo = data.raritiesByNo;
        }
        return card;
      });
      return res.set('X-YGO-Card-Read', '1').json({ success: true, cards });
    } catch (_) { return res.status(503).json({ success: false }); }
  });
  const readResources = createCardResourcesReader(resources);
  app.post('/v1/resources/read', async (req, res) => {
    if (!req.body || Object.keys(req.body).length) return res.status(400).json({ success: false });
    try { return res.set('X-YGO-Card-Read', '1').json({ success: true, resources: await readResources() }); }
    catch (_) { return res.status(503).json({ success: false }); }
  });
  app.use((_req, res) => res.status(404).json({ success: false }));
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ success: false }));
  return app;
}
module.exports = { createReadApp };
