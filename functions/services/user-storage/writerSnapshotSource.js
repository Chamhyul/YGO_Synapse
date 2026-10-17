'use strict';
const { decodeKey } = require('./codec');
const { createStorageAccess } = require('./storageAccess');
const { fingerprint } = require('../userMigrationRehearsal');
const C = require('../membershipCsvWriterContract');
const fail = () => Object.assign(new Error('원본 수집 위치와 자료를 확인해 주세요.'), { code: 'WRITER_SNAPSHOT_INVALID' });

// 조회 위치에는 고정된 source 번호와 마지막 문서 ID/페이지 토큰만 둔다.
// 조회 경로·프로젝트·버킷을 저장된 cursor로 선택하지 않는다.
function createWriterSnapshotSource({ db, database, bucket, backend, adapters, timeoutMs, onAmbiguousWrite, audit = async () => {} }) {
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite }), sources = [];
  const fs = (path, keys) => sources.push({ type: 'fs', path, keys });
  const rt = (path, keys) => sources.push({ type: 'rt', path, keys });
  const fixed = keys => sources.push({ type: 'fixed', keys });
  if (!['legacy', 'rtdb'].includes(backend)) throw fail();
  if (backend === 'legacy') {
    fs('users', doc => [`fs/users/${doc.id}`]);
    fs('userProfileWriterMetadata', doc => [`fs/users/${decodeKey(doc.id)}`]);
    if (adapters.inventory) {
      fs('inventoryWriterHeads', doc => [`inventory/${doc.id}`]);
      fs('inventoryWriterMetadata', doc => [`inventory/${decodeKey(doc.id)}`]);
      sources.push({ type: 'files' });
    }
    if (adapters.membership) {
      for (const provider of ['discord', 'youtube']) fs(`${provider}_membership_verifications`, doc => [`verification/${provider}/${doc.id}`]);
      fs('membershipWriterMetadata', doc => { const key = decodeKey(doc.id); if (!/^verification\/(discord|youtube)\//.test(key)) throw Object.assign(fail(), { code: 'MEMBERSHIP_WRITER_INVALID_KEY' }); return [key]; });
    }
    if (adapters.session) for (const path of ['AdminWebSessions', 'adminSessionWriterMetadata']) fs(path, doc => [`session/${doc.id}`]);
    if (adapters.api) {
      fs('cardApiConfig', doc => { if (doc.id !== 'cors') throw Object.assign(fail(), { code: 'API_WRITER_MIGRATION_REQUIRED' }); return []; });
      for (const path of ['cardApiKeys', 'cardApiUsage', 'apiAccessWriterMetadata']) fs(path, doc => [`apiKey/${doc.id}`]);
      fixed(async () => { const doc = await access.guarded(db.collection('cardApiConfig').doc('cors').get(), false), value = doc.exists ? doc.data() : { keyOrigins: {} };
        if (!value || Object.keys(value).join(',') !== 'keyOrigins' || !value.keyOrigins || typeof value.keyOrigins !== 'object' || Array.isArray(value.keyOrigins)) throw Object.assign(fail(), { code: 'API_WRITER_MIGRATION_REQUIRED' });
        return Object.keys(value.keyOrigins).map(id => `apiKey/${id}`); });
    }
    if (adapters.csv) {
      fixed(async () => { const old = await adapters.csv.read('csv/legacyUsers'); return ['csv/control', 'csv/legacyUsers', ...(old.exists && old.value.length ? [`csv/candidate/${fingerprint(old.value).slice(0, 32)}`] : [])]; });
      fs('membershipCsvWriterRecords', doc => { const key = decodeKey(doc.id); C.checkCsvKey(key); return [key]; });
      fs('membership_csv_imports', async doc => [`csv/operation/${doc.id}`, ...(!(await access.guarded(doc.ref.collection('members').limit(1).get(), false)).empty ? [`csv/candidate/${doc.id}`] : [])]);
    }
  } else {
    rt('users', child => child.val().profile === undefined ? [] : [`fs/users/${decodeKey(child.key)}`]);
    if (adapters.inventory) rt('inventories', child => [`inventory/${decodeKey(child.key)}`]);
    if (adapters.membership) rt('users', child => { const value = child.val(); return [...new Set([...Object.keys(value.verification || {}), ...Object.keys(value.verificationWriterMetadata || {})])].map(provider => `verification/${provider}/${decodeKey(child.key)}`); });
    if (adapters.session) rt('adminSessions', child => [`session/${decodeKey(child.key)}`]);
    if (adapters.api) rt('apiAccess/keys', child => [`apiKey/${decodeKey(child.key)}`]);
    if (adapters.csv) for (const [kind, path] of [['control', 'control'], ['candidate', 'candidates'], ['operation', 'operations'], ['legacyUsers', 'legacyUsers']]) rt(`membershipCsv/${path}`, child => {
      const id = decodeKey(child.key); if (['control', 'legacyUsers'].includes(kind) && id !== 'current') throw C.fail('CSV_WRITER_INVALID_KEY');
      return [kind === 'control' || kind === 'legacyUsers' ? `csv/${kind}` : `csv/${kind}/${id}`];
    });
  }
  function selected(key) {
    const kind = key.startsWith('fs/users/') ? 'profile' : key.startsWith('inventory/') ? 'inventory'
      : key.startsWith('verification/') ? 'membership' : key.startsWith('session/') ? 'session' : key.startsWith('apiKey/') ? 'api' : key.startsWith('csv/') ? 'csv' : undefined;
    if (!adapters[kind]) throw fail(); return adapters[kind];
  }
  async function page(cursor = null) {
    if (cursor !== null && (!cursor || Object.keys(cursor).sort().join(',') !== 'after,source'
        || !Number.isSafeInteger(cursor.source) || cursor.source < 0 || cursor.source >= sources.length
        || cursor.after !== null && (typeof cursor.after !== 'string' || !cursor.after || Buffer.byteLength(cursor.after) > 8192))) throw fail();
    await audit(); const index = cursor?.source ?? 0, after = cursor?.after ?? null, source = sources[index];
    let keys = [], more = false, last = null;
    if (source.type === 'fs') {
      let query = db.collection(source.path).orderBy('__name__').limit(25).select(); if (after !== null) query = query.startAfter(after);
      const docs = (await access.guarded(query.get(), false)).docs;
      for (const doc of docs) keys.push(...await source.keys(doc));
      more = docs.length === 25; last = docs.at(-1)?.id ?? null;
    } else if (source.type === 'rt') {
      let query = database.ref(source.path).orderByKey().limitToFirst(25); if (after !== null) query = query.startAfter(after);
      const snapshot = await access.guarded(query.get(), false); let count = 0;
      snapshot.forEach(child => { count++; last = child.key; keys.push(...source.keys(child)); }); more = count === 25;
    } else if (source.type === 'files') {
      const [files, next] = await access.guarded(bucket.getFiles({ prefix: 'users/', autoPaginate: false, maxResults: 25, ...(after ? { pageToken: after } : {}) }), false);
      for (const file of files) { const match = /^users\/([^/]+)\/inventory\.json$/.exec(file.name); if (match) keys.push(`inventory/${match[1]}`); }
      more = !!next?.pageToken; last = next?.pageToken ?? null;
    } else {
      // CORS의 단일 문서도 키가 많으면 수집/읽기를 25개씩 나눈다.
      const all = (await source.keys()).sort(), start = after === null ? 0 : Number(after);
      if (after !== null && !/^[1-9]\d*$/.test(after)) throw fail();
      if (!Number.isSafeInteger(start) || start < 0 || start > all.length) throw fail();
      keys = all.slice(start, start + 25); more = start + 25 < all.length; last = String(start + 25);
    }
    const uniqueKeys = [...new Set(keys)];
    async function* entries() {
      for (const key of uniqueKeys) {
        const adapter = selected(key), entry = await (adapter.capture ? adapter.capture(key) : adapter.read(key));
        if (key.startsWith('verification/') && entry.exists && entry.value.profileGeneration !== 0) throw Object.assign(fail(), { code: 'MEMBERSHIP_WRITER_GENERATION_MIGRATION_REQUIRED' });
        if (!(backend === 'legacy' && key.startsWith('csv/') && !entry.exists && entry.token === '0')) yield entry;
      }
    }
    const done = !more && index + 1 === sources.length;
    return { entries: entries(), size: uniqueKeys.length, cursor: done ? null : { source: more ? index : index + 1, after: more ? last : null }, done };
  }
  return { page, layout: fingerprint({ version: 1, backend, sources: sources.map(source => [source.type, source.path ?? null]) }) };
}
module.exports = { createWriterSnapshotSource };
