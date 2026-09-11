// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const PREFIX = 'private/illustrations';
const INDEX = 'private/illustrations-index.json';

function parseRequest(path) {
  const match = /^\/api\/illustrations\/([1-9]\d{0,9})(?:_([1-9]\d{0,3})\.webp|\.json)$/.exec(path);
  return match ? { cid: match[1], ciid: match[2] || null } : null;
}

function cardIndex(index, cid) {
  const files = {};
  for (const [key, item] of Object.entries(index.files || {})) {
    if (!key.startsWith(`${cid}_`) || !/^[1-9]\d{0,9}_[1-9]\d{0,3}$/.test(key)) continue;
    // Never send object paths, hashes, download tokens, or other cards to clients.
    files[key] = { sourceImageId: item.sourceImageId, transform: item.transform,
      cdnAvailable: item.cdnAvailable };
  }
  return { files };
}

function createHandler({ download, allow }) {
  let cachedIndex;
  let expires = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.status(405).end();
    const input = parseRequest(req.path);
    if (!input) return res.status(404).end();
    if (!allow(req.ip)) return res.status(429).end();
    try {
      if (input.ciid) {
        const bytes = await download(`${PREFIX}/${input.cid}_${input.ciid}.webp`);
        res.setHeader('Content-Type', 'image/webp');
        return res.status(200).send(bytes);
      }
      if (!cachedIndex || Date.now() >= expires) {
        cachedIndex = JSON.parse((await download(INDEX)).toString('utf8'));
        expires = Date.now() + 60000;
      }
      return res.json(cardIndex(cachedIndex, input.cid));
    } catch (error) {
      return res.status(error.code === 404 || /HTTP 404/.test(error.message) ? 404 : 503).end();
    }
  };
}

// Per-instance burst guard, not a distributed anti-scraping guarantee.
function createLimiter(limit = 180, windowMs = 60000) {
  const clients = new Map();
  return ip => {
    const now = Date.now();
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
    let value = clients.get(ip);
    if (!value) {
      if (clients.size >= 10000) return false;
      clients.set(ip, value = { count: 0, until: now + windowMs });
    }
    return ++value.count <= limit;
  };
}
module.exports = { PREFIX, INDEX, parseRequest, cardIndex, createHandler, createLimiter };
