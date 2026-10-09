'use strict';
const { LOCALES, toStoredInfo } = require('../utils/cardSchema');
const { failure, validOrigin } = require('./cardApiAccess');
// 기존 이름 조회와 같은 공백·불가시 문자·NFC 정규화를 사용한다.
const normalizeText = value => value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().normalize('NFC');
const STATS = ['card_type', 'properties', 'lv', 'attribute', 'race', 'atk', 'def', 'pendulum_scale'];
function parseQuery(query = {}) {
  if (Object.keys(query).some(k => !['cid', 'name', 'number', 'locale', 'langOnly'].includes(k)) ||
    Object.values(query).some(v => typeof v !== 'string') ||
    ['cid', 'name', 'number'].filter(k => Object.hasOwn(query, k)).length !== 1) throw failure(400, 'INVALID_QUERY');
  const field = ['cid', 'name', 'number'].find(k => Object.hasOwn(query, k));
  const value = field === 'name' ? normalizeText(query.name) : query[field].trim();
  if (!value || query[field].length > 200 || (field === 'cid' && !/^[1-9]\d{0,9}$/.test(value)) ||
    (query.locale !== undefined && !LOCALES.includes(query.locale)) ||
    (query.langOnly !== undefined && !['true', 'false'].includes(query.langOnly))) throw failure(400, 'INVALID_QUERY');
  return { field, value: field === 'number' ? value.toUpperCase() : value, locale: query.locale, langOnly: query.langOnly === 'true' };
}
async function readCard(db, input) {
  if (input.field === 'cid') {
    const doc = await db.collection('cards').doc(input.value).get();
    return doc.exists ? doc : null;
  }
  const docs = (await db.collection('cards').where(input.field === 'name' ? 'names' : 'numbers', 'array-contains', input.value).limit(2).get()).docs;
  if (docs.length > 1) throw failure(409, 'AMBIGUOUS_CARD');
  return docs[0] || null;
}
function formatCard(doc, { locale, langOnly }) {
  const raw = doc.data().info || {};
  const info = Object.keys(raw).some(k => /^\d+$/.test(k)) ? toStoredInfo(raw) : raw;
  const locales = {};
  for (const lang of locale ? [locale] : LOCALES) {
    const slot = info[lang];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
    const selected = {};
    for (const field of ['name', 'ciid', 'text', 'text_pen']) if (Object.hasOwn(slot, field)) selected[field] = slot[field];
    if (slot.packs && typeof slot.packs === 'object' && !Array.isArray(slot.packs)) {
      selected.packs = Object.fromEntries(Object.entries(slot.packs).map(([number, values]) => {
        if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw failure(503, 'API_UNAVAILABLE');
        return [number, values];
      }));
    }
    // 언어 필드에 내부 객체가 섞여 있어도 공개하지 않는다.
    if ((selected.name !== undefined && typeof selected.name !== 'string') ||
      ['text', 'text_pen'].some(k => selected[k] !== undefined && typeof selected[k] !== 'string') ||
      (selected.ciid !== undefined && selected.ciid !== null && (!Array.isArray(selected.ciid) || selected.ciid.some(id => !Number.isSafeInteger(id) || id < 1)))) throw failure(503, 'API_UNAVAILABLE');
    locales[lang] = selected;
  }
  if (locale && !Object.hasOwn(locales, locale)) throw failure(404, 'CARD_LOCALE_NOT_FOUND');
  const result = { success: true, cid: doc.id, locales };
  if (!langOnly) {
    result.stats = {};
    for (const field of STATS) if (Object.hasOwn(info, field)) {
      const value = info[field];
      if (value !== null && (field === 'properties' ? !Array.isArray(value) || value.some(v => typeof v !== 'string') : !['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw failure(503, 'API_UNAVAILABLE');
      result.stats[field] = value;
    }
  }
  return result;
}
function cors(res, origin) {
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'X-API-Key');
  res.set('Access-Control-Expose-Headers', 'Retry-After, X-RateLimit-Limit-Minute, X-RateLimit-Remaining-Minute, X-RateLimit-Limit-Day, X-RateLimit-Remaining-Day');
}
function createCardInfoHandler({ db, access, allow = () => true }) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Origin');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      if (!allow(req.ip)) throw Object.assign(failure(429, 'RATE_LIMIT_EXCEEDED'), { retryAfter: 60 });
      const origin = req.headers.origin;
      if (origin !== undefined && !validOrigin(origin)) throw failure(403, 'ORIGIN_NOT_ALLOWED');
      if (req.method === 'OPTIONS') {
        const headers = (req.headers['access-control-request-headers'] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
        if (!origin || req.headers['access-control-request-method'] !== 'GET' || headers.some(h => h !== 'x-api-key') || !await access.allowsPreflight(origin)) throw failure(403, 'ORIGIN_NOT_ALLOWED');
        cors(res, origin);
        res.set('Access-Control-Max-Age', '300');
        return res.status(204).send('');
      }
      if (req.method !== 'GET') { res.set('Allow', 'GET, OPTIONS'); throw failure(405, 'METHOD_NOT_ALLOWED'); }
      const token = req.headers['x-api-key'];
      const key = await access.authenticate(token);
      if (origin !== undefined) {
        if (!key.origins.includes(origin)) throw failure(403, 'ORIGIN_NOT_ALLOWED');
        cors(res, origin);
      }
      const input = parseQuery(req.query);
      const usage = await access.consume(token, origin);
      for (const [header, value] of Object.entries({ 'X-RateLimit-Limit-Minute': usage.minuteLimit,
        'X-RateLimit-Remaining-Minute': usage.minuteRemaining, 'X-RateLimit-Limit-Day': usage.dayLimit,
        'X-RateLimit-Remaining-Day': usage.dayRemaining })) res.set(header, String(value));
      const doc = await readCard(db, input);
      if (!doc) throw failure(404, 'CARD_NOT_FOUND');
      return res.json(formatCard(doc, input));
    } catch (error) {
      const status = [400, 401, 403, 404, 405, 409, 429].includes(error.status) ? error.status : 503;
      if (status === 429) res.set('Retry-After', String(error.retryAfter || 60));
      return res.status(status).json({ success: false, code: status === 503 ? 'API_UNAVAILABLE' : error.code });
    }
  };
}
module.exports = { createCardInfoHandler, parseQuery, readCard, formatCard };
