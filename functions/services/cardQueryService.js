const { db } = require('../config/firebase');
const { normalizeText } = require('../utils/common');
const { toRuntimeInfo } = require('../utils/cardSchema');
const { isLocal, requestProduction } = require('./publicReadTransport');

async function readProductionCards(body) {
  const result = await requestProduction('getPublicCardData', body);
  if (!Array.isArray(result.cards) || result.cards.length > 100 || result.cards.some(card =>
    !card || typeof card.cid !== 'string' || !/^[1-9]\d{0,9}$/.test(card.cid)
    || !card.data || !Array.isArray(card.data.names) || !Array.isArray(card.data.numbers)
    || !card.data.info || typeof card.data.info !== 'object')) {
    throw new Error('운영 카드 조회 응답이 올바르지 않습니다.');
  }
  return result.cards.map(card => ({ cid: card.cid, data: card.data, info: toRuntimeInfo(card.data.info) }));
}

const TTL = 60 * 1000;
const documents = new Map();
const queries = new Map();
const pending = new Map();
let revision = 0;
const normalizeNumber = value => String(value || '').trim().toUpperCase();

function rememberCard(cid, data) {
  const card = { cid: String(cid), data, info: toRuntimeInfo(data.info) };
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
  if (isLocal()) {
    if (!/^[1-9]\d{0,9}$/.test(id)) return null;
    return (await getCardsByCids([id]))[0] || null;
  }
  const cached = documents.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  return cachedRead(`cid:${id}`, async () => {
    const started = revision;
    const snapshot = await db.collection('cards').doc(id).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    return started === revision ? rememberCard(snapshot.id, data) : { cid: snapshot.id, data, info: toRuntimeInfo(data.info) };
  });
}

async function getCardsByCids(cids) {
  const ids = [...new Set(cids.map(value => String(value).trim()))].filter(id => id && !id.includes('/'));
  if (isLocal()) {
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const card of await readProductionCards({ cids: ids.slice(offset, offset + 100) })) found.set(card.cid, card);
    }
    // 로컬에서 수집한 카드만 로컬 결과를 우선하며 저장 대상은 바꾸지 않는다.
    if (ids.length) {
      const snapshots = await db.getAll(...ids.map(id => db.collection('cards').doc(id)));
      for (const doc of snapshots) if (doc.exists) {
        const data = doc.data(); found.set(doc.id, { cid: doc.id, data, info: toRuntimeInfo(data.info) });
      }
    }
    return ids.map(id => found.get(id)).filter(Boolean);
  }
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
          : { cid: snapshot.id, data, info: toRuntimeInfo(data.info) };
      });
    });
    for (const card of cards) found.set(card.cid, card);
  }
  return ids.map(id => found.get(id)).filter(Boolean);
}

async function findCards(field, input) {
  const value = field === 'numbers' ? normalizeNumber(input) : normalizeText(input);
  if (!value) return [];
  if (isLocal()) {
    const remote = await readProductionCards({ field, value });
    const found = new Map(remote.map(card => [card.cid, card]));
    const snapshot = await db.collection('cards').where(field, 'array-contains', value).get();
    for (const doc of snapshot.docs) {
      const data = doc.data(); found.set(doc.id, { cid: doc.id, data, info: toRuntimeInfo(data.info) });
    }
    return [...found.values()];
  }
  return cachedRead(`${field}:${value}`, async () => {
    const started = revision;
    const snapshot = await db.collection('cards').where(field, 'array-contains', value).get();
    return snapshot.docs.map(doc => {
      const data = doc.data();
      return started === revision ? rememberCard(doc.id, data) : { cid: doc.id, data, info: toRuntimeInfo(data.info) };
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
  if (isLocal()) throw new Error('로컬에서는 공개 카드 목록 API를 사용하세요.');
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
