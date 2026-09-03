const { db } = require('../config/firebase');
const { normalizeText } = require('../utils/common');

const TTL = 60 * 1000;
const documents = new Map();
const queries = new Map();
const pending = new Map();
let revision = 0;
const normalizeNumber = value => String(value || '').trim().toUpperCase();

function rememberCard(cid, data) {
  const card = { cid: String(cid), data, info: data.info || {} };
  documents.set(card.cid, { value: card, expires: Date.now() + TTL });
  if (documents.size > 2000) documents.delete(documents.keys().next().value);
  return card;
}

function invalidateCardQueries(cid) {
  revision++;
  if (cid) documents.delete(String(cid));
  else documents.clear();
  queries.clear();
  pending.clear();
}

async function cachedRead(key, operation) {
  const cached = queries.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const started = revision;
  const promise = operation().then(value => {
    if (started === revision) {
      queries.set(key, { value, expires: Date.now() + TTL });
      if (queries.size > 2000) queries.delete(queries.keys().next().value);
    }
    return value;
  }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}

async function getCardByCid(cid) {
  const id = String(cid || '').trim();
  if (!id || id.includes('/')) return null;
  const cached = documents.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  return cachedRead(`cid:${id}`, async () => {
    const started = revision;
    const snapshot = await db.collection('cards').doc(id).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    return started === revision ? rememberCard(snapshot.id, data) : { cid: snapshot.id, data, info: data.info || {} };
  });
}

async function getCardsByCids(cids) {
  const ids = [...new Set(cids.map(value => String(value).trim()))].filter(id => id && !id.includes('/'));
  const found = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = documents.get(id);
    if (cached && cached.expires > Date.now()) found.set(id, cached.value);
    else missing.push(id);
  }
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100);
    const cards = await cachedRead(`batch:${JSON.stringify(batch)}`, async () => {
      const started = revision;
      const snapshots = await db.getAll(...batch.map(id => db.collection('cards').doc(id)));
      return snapshots.filter(snapshot => snapshot.exists).map(snapshot => {
        const data = snapshot.data();
        return started === revision ? rememberCard(snapshot.id, data)
          : { cid: snapshot.id, data, info: data.info || {} };
      });
    });
    for (const card of cards) found.set(card.cid, card);
  }
  return ids.map(id => found.get(id)).filter(Boolean);
}

async function findCards(field, input) {
  const value = field === 'numbers' ? normalizeNumber(input) : normalizeText(input);
  if (!value) return [];
  return cachedRead(`${field}:${value}`, async () => {
    const started = revision;
    const snapshot = await db.collection('cards').where(field, 'array-contains', value).get();
    return snapshot.docs.map(doc => {
      const data = doc.data();
      return started === revision ? rememberCard(doc.id, data) : { cid: doc.id, data, info: data.info || {} };
    });
  });
}

async function findCard({ cid, name, number } = {}) {
  if (cid) return getCardByCid(cid);
  let cards = number ? await findCards('numbers', number) : await findCards('names', name);
  if (cards.length > 1 && name) cards = cards.filter(card =>
    (card.data.names || []).some(n => normalizeText(n) === normalizeText(name)));
  if (cards.length > 1) {
    const error = new Error('여러 카드가 일치합니다. 이름과 번호를 함께 확인해 주세요.');
    error.code = 'AMBIGUOUS_CARD';
    throw error;
  }
  return cards[0] || null;
}

// 인벤토리의 잘못된 번호를 이름만으로 다른 카드에 연결하지 않습니다.
async function resolveInventoryCid(number, name) {
  const numbered = await findCards('numbers', number);
  const named = normalizeText(name);
  if (numbered.length) {
    const matches = numbered.filter(card => !named ||
      (card.data.names || []).some(n => normalizeText(n) === named));
    return matches.length === 1 ? matches[0].cid : null;
  }
  const matches = await findCards('names', name);
  if (matches.length !== 1) return null;
  // 번호가 없는 과거 항목만 이름으로 확정합니다. 실제 번호 충돌은 미확정입니다.
  if (number && number !== 'NO_NUMBER') return null;
  return matches[0].cid;
}

async function mapLimited(values, fn, concurrency = 5) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index], index);
    }
  }));
  return results;
}

// 구형 탭 전환용 응답입니다. 새 클라이언트는 요청하지 않으며 JSON 인덱스를 읽지 않습니다.
async function getLegacyCidMap() {
  return cachedRead('legacy-cids', async () => {
    const result = Object.create(null);
    let cursor = null;
    while (true) {
      let query = db.collection('cards').orderBy('__name__').select('names').limit(500);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) result[doc.id] = { names: doc.data().names || [] };
      cursor = page.docs[page.docs.length - 1];
    }
    return result;
  });
}

module.exports = { documents, findCard, findCards, getCardByCid, getCardsByCids, resolveInventoryCid, getLegacyCidMap,
  mapLimited, rememberCard, invalidateCardQueries, normalizeNumber };
