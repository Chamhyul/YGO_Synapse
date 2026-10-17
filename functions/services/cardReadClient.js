'use strict';
const { validatePublicCards } = require('./publicCardContract');
const MAX_BYTES = 4 * 1024 * 1024;
const unavailable = () => Object.assign(new Error('카드 조회 서버에 연결할 수 없습니다.'), {
  status: 503, code: 'CARD_READ_UNAVAILABLE',
});
function settings(env) {
  if (!env.CARD_SERVICE_URL) return null;
  let url; try { url = new URL(env.CARD_SERVICE_URL); } catch (_) { throw unavailable(); }
  const fixture = env.CARD_SERVICE_AUTH === 'fixture';
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (!fixture && url.protocol !== 'https:')
      || (fixture && (env.NODE_ENV !== 'test' || env.CARD_READ_BACKEND !== 'fixture'
        || url.protocol !== 'http:' || !['card', '127.0.0.1', 'localhost'].includes(url.hostname)))
      || (!fixture && ![undefined, 'oidc'].includes(env.CARD_SERVICE_AUTH))) throw unavailable();
  return { origin: url.origin, audience: env.CARD_SERVICE_AUDIENCE || url.origin, fixture };
}
function createCardReadClient({ env = process.env, fetchImpl = fetch, tokenProvider, timeoutMs = 10000 } = {}) {
  const config = settings(env);
  if (!config) throw unavailable();
  let identityClient;
  const identity = tokenProvider || (async () => {
    if (config.fixture) return 'synthetic-card-service-token';
    const { google } = require('googleapis');
    identityClient ||= await new google.auth.GoogleAuth().getIdTokenClient(config.audience);
    const headers = await identityClient.getRequestHeaders();
    const authorization = headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw unavailable();
    return authorization.slice(7);
  });
  async function request(route, body) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const token = await identity();
        const response = await fetchImpl(config.origin + route, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!response.ok || response.headers.get('X-YGO-Card-Read') !== '1'
          || !response.headers.get('content-type')?.includes('application/json')) throw unavailable();
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { controller.abort(); throw unavailable(); }
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value?.success !== true) throw unavailable();
        return value;
      })(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
      })]);
    } catch (_) { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({
    async readCards(body) {
      const result = await request('/v1/cards/read', body);
      try {
        if (!Array.isArray(result.cards)) throw unavailable();
        const ids = new Set();
        for (let offset = 0; offset < result.cards.length; offset += 100) {
          validatePublicCards({ success: true, cards: result.cards.slice(offset, offset + 100) });
        }
        for (const card of result.cards) {
          if (ids.has(card.cid) || body.cids && !body.cids.includes(card.cid)
            || Array.isArray(card.data.info) || card.data.names.some(n => typeof n !== 'string')
            || card.data.numbers.some(n => typeof n !== 'string')) throw unavailable();
          ids.add(card.cid);
        }
        return result.cards;
      } catch (_) { throw unavailable(); }
    },
    async readResources() {
      const { resources } = await request('/v1/resources/read', {});
      for (const [name, format] of Object.entries({ cardManifest: 'card-manifest-v2', packs: 'packs-v1', rarity: 'rarity-langs-v1' })) {
        const item = resources?.[name];
        if (!item || typeof item.available !== 'boolean' || item.format !== format
          || !Number.isFinite(item.updatedAt) || (item.available
            ? typeof item.generation !== 'string' || typeof item.url !== 'string'
            : item.url !== null || item.generation !== null)) throw unavailable();
        if (item.available) {
          let url; try { url = new URL(item.url); } catch (_) { throw unavailable(); }
          if (url.username || url.password || (!config.fixture && url.protocol !== 'https:')
            || !['http:', 'https:'].includes(url.protocol)) throw unavailable();
        }
      }
      return Object.fromEntries(['cardManifest', 'packs', 'rarity'].map(key => [key, resources[key]]));
    },
  });
}
let client;
function getCardReadClient() { return client ||= createCardReadClient(); }
module.exports = { createCardReadClient, getCardReadClient, settings };
