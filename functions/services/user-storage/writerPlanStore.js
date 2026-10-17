'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { createRecordStore, decodeRecord } = require('./recordStore');
const { createStorageAccess } = require('./storageAccess');
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const { sortReferences } = require('./writerReferenceSort');
const fail = () => Object.assign(new Error('분할 복사 계획의 원문과 진행 상태를 대조해 주세요.'), { code: 'WRITER_PLAN_CONFLICT' });
const hash = value => createHash('sha256').update(value).digest('hex');
const keyId = key => hash(key).slice(0, 32), random = () => randomBytes(16).toString('hex');
const canonical = value => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function digestEntries(entries) { const h = createHash('sha256').update('writer-plan-v1\n'); for (const entry of entries) h.update(fingerprint(entry) + '\n'); return h.digest('hex'); }
function createWriterPlanStore({ database, runId, timeoutMs = 10000, onAmbiguousWrite, chunkBytes = 128 * 1024, pageSize = 32, sortOptions = {} } = {}) {
  const idCheck = id => { if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw fail(); };
  idCheck(runId); if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 128 * 1024
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 32) throw fail();
  const base = `profileWriterPlans/${encodeKey(runId)}`, access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const cleanup = require('./writerPlanCleanupStore').createPlanCleanupStore({ database, runId, timeoutMs, onAmbiguousWrite });
  const stores = new Map();
  const store = path => { if (!stores.has(path)) stores.set(path, createRecordStore({ database, path: base + '/' + path, maxAttempts: 10, timeoutMs, onAmbiguousWrite })); return stores.get(path); };
  async function immutable(path, id, value) {
    idCheck(id); const target = store(path), before = await target.read(id);
    if (!before.exists && before.revision) throw fail();
    if (before.exists) { if (fingerprint(before.value) !== fingerprint(value)) throw fail(); return; }
    try { await target.compareAndSet(id, 0, value); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
    const saved = await target.read(id); if (!saved.exists || fingerprint(saved.value) !== fingerprint(value)) throw fail();
  }
  function checkRef(ref) {
    idCheck(ref?.id); if (ref.format !== 1 || !Number.isSafeInteger(ref.count) || ref.count < 0
      || !Number.isSafeInteger(ref.pages) || ref.pages < 0 || ref.pages !== Math.ceil(ref.count / pageSize)
      || !/^[a-f0-9]{64}$/.test(ref.digest || '')) throw fail(); return ref;
  }
  async function writeValue(scope, id, entry) {
    idCheck(scope); idCheck(id);
    await cleanup.assertAlive(scope);
    const bytes = Buffer.from(JSON.stringify(canonical(encodeValue(entry))));
    if (bytes.length > 32 * 1024 * 1024) throw fail();
    const ref = { id, digest: hash(bytes), bytes: bytes.length, chunks: Math.ceil(bytes.length / chunkBytes) };
    for (let i = 0; i < ref.chunks; i++) await immutable(`chunks/${scope}`, keyId(id + ':' + i), { data: bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString('base64') });
    await immutable(`values/${scope}`, id, ref); await cleanup.assertAlive(scope); return ref;
  }
  async function readValue(scope, ref) {
    idCheck(scope); idCheck(ref?.id);
    await cleanup.assertAlive(scope);
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 32 * 1024 * 1024
      || ref.chunks !== Math.ceil(ref.bytes / chunkBytes) || !/^[a-f0-9]{64}$/.test(ref.digest || '')) throw fail();
    const meta = await store(`values/${scope}`).read(ref.id); if (!meta.exists || fingerprint(meta.value) !== fingerprint(ref)) throw fail();
    const chunks = [];
    for (let i = 0; i < ref.chunks; i++) {
      const record = await store(`chunks/${scope}`).read(keyId(ref.id + ':' + i));
      if (!record.exists || typeof record.value?.data !== 'string') throw fail();
      const chunk = Buffer.from(record.value.data, 'base64'); if (chunk.toString('base64') !== record.value.data || chunk.length > chunkBytes) throw fail(); chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks); if (bytes.length !== ref.bytes || hash(bytes) !== ref.digest) throw fail();
    const value = decodeValue(JSON.parse(bytes.toString('utf8'))); await cleanup.assertAlive(scope); return value;
  }
  async function save(entries) {
    const id = random(), h = createHash('sha256').update('writer-plan-v1\n'); let count = 0, pages = 0, previous, group = [];
    for await (const entry of entries) {
      if (typeof entry?.key !== 'string' || previous !== undefined && previous.localeCompare(entry.key) >= 0) throw fail();
      previous = entry.key; const value = await writeValue(id, keyId(entry.key), entry);
      const header = { key: entry.key, value }; await immutable(`heads/${id}`, keyId(entry.key), header);
      group.push(header); h.update(fingerprint(entry) + '\n'); count++;
      if (group.length === pageSize) { await immutable(`pages/${id}`, pages.toString(16).padStart(32, '0'), group); pages++; group = []; }
    }
    if (group.length) { await immutable(`pages/${id}`, pages.toString(16).padStart(32, '0'), group); pages++; }
    const ref = { format: 1, id, count, pages, digest: h.digest('hex') }; await cleanup.assertAlive(id); await immutable('manifests', id, ref); await verify(ref); return ref;
  }
  async function manifest(ref) {
    checkRef(ref); await cleanup.assertAlive(ref.id); const record = await store('manifests').read(ref.id);
    if (!record.exists || fingerprint(record.value) !== fingerprint(ref)) throw fail();
    await cleanup.assertAlive(ref.id);
  }
  async function* headers(ref) {
    await manifest(ref); let count = 0, previous;
    for (let page = 0; page < ref.pages; page++) {
      const record = await store(`pages/${ref.id}`).read(page.toString(16).padStart(32, '0'));
      if (!record.exists || !Array.isArray(record.value) || record.value.length !== Math.min(pageSize, ref.count - count)) throw fail();
      for (const header of record.value) {
        if (typeof header?.key !== 'string' || previous !== undefined && previous.localeCompare(header.key) >= 0) throw fail();
        const index = await store(`heads/${ref.id}`).read(keyId(header.key));
        if (!index.exists || fingerprint(index.value) !== fingerprint(header)) throw fail();
        previous = header.key; yield { ...header, index: count++ };
      }
    }
    if (count !== ref.count) throw fail();
  }
  async function* scan(ref, { start = 0 } = {}) {
    if (!Number.isSafeInteger(start) || start < 0 || start > ref.count) throw fail();
    const h = createHash('sha256').update('writer-plan-v1\n');
    for await (const header of headers(ref)) {
      const entry = await readValue(ref.id, header.value); if (entry.key !== header.key) throw fail();
      h.update(fingerprint(entry) + '\n'); if (header.index >= start) yield { index: header.index, entry };
    }
    if (h.digest('hex') !== ref.digest) throw fail(); await cleanup.assertAlive(ref.id);
  }
  async function verify(ref) { for await (const _ of scan(ref)) {} return ref; }
  async function entry(ref, key) {
    await manifest(ref); const header = await store(`heads/${ref.id}`).read(keyId(key));
    if (!header.exists) { if (header.revision) throw fail(); return { key, exists: false, token: '0' }; }
    if (header.value.key !== key) throw fail(); const value = await readValue(ref.id, header.value.value); if (value.key !== key) throw fail(); return value;
  }
  async function expected(transferId, ref, key) {
    idCheck(transferId); const head = await store(`expected/${transferId}`).read(keyId(key));
    if (!head.exists) { if (head.revision) throw fail(); return { entry: await entry(ref, key) }; }
    if (head.value?.key !== key) throw fail(); const value = await readValue(transferId, head.value.value); if (value.key !== key) throw fail();
    return { entry: value, marker: head.value.marker };
  }
  async function checkpoint(transferId, ref, marker, saved, before) {
    idCheck(transferId); idCheck(marker); const target = store(`expected/${transferId}`), id = keyId(saved.key), observed = await target.read(id);
    const current = await expected(transferId, ref, saved.key);
    if (current.marker === marker) { if (fingerprint(current.entry) !== fingerprint(saved)) throw fail(); return; }
    if (fingerprint(current.entry) !== fingerprint(before)) throw fail();
    const value = await writeValue(transferId, marker, saved);
    try { await target.compareAndSet(id, observed.revision, { key: saved.key, marker, value }); }
    catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
    const actual = await expected(transferId, ref, saved.key);
    if (actual.marker !== marker || fingerprint(actual.entry) !== fingerprint(saved)) throw fail();
  }
  async function* overlayHeaders(transferId) {
    let cursor; const path = `expected/${transferId}`;
    while (true) {
      let query = database.ref(base + '/' + path).orderByKey(); if (cursor) query = query.startAt(cursor);
      const snapshot = await access.guarded(query.limitToFirst(pageSize + (cursor ? 1 : 0)).get(), false), values = [];
      snapshot.forEach(child => { if (child.key !== cursor) values.push({ cursor: child.key, value: decodeRecord(child.val(), { path: base + '/' + path + '/' + child.key, payloadCodec: { decode: decodeValue } }) }); });
      for (const item of values) { if (!item.value.exists || encodeKey(keyId(item.value.value?.key)) !== item.cursor) throw fail(); yield item.value.value; }
      if (values.length < pageSize) break; cursor = values.at(-1).cursor;
    }
  }
  async function sealExpected(transferId, ref) {
    async function* references() {
      for await (const header of headers(ref)) yield { key: header.key, scope: ref.id, value: header.value, priority: 0 };
      for await (const head of overlayHeaders(transferId)) yield { key: head.key, scope: transferId, value: head.value, priority: 1 };
    }
    async function* values() {
      let chosen;
      async function load(head) { const value = await readValue(head.scope, head.value); if (value.key !== head.key) throw fail(); return value; }
      for await (const head of sortReferences(references(), sortOptions)) {
        if (chosen && chosen.key !== head.key) yield await load(chosen);
        else if (chosen && chosen.priority === head.priority && fingerprint(chosen) !== fingerprint(head)) throw fail();
        chosen = head;
      }
      if (chosen) yield await load(chosen);
    }
    return save(values());
  }
  async function collect(id, context, source, { checkEntries = value => value, guard = async () => {}, onCheckpoint = async () => {} } = {}) {
    idCheck(id);
    await cleanup.assertAlive(id);
    if (typeof source !== 'function' || !context || typeof checkEntries !== 'function') throw fail();
    const seed = fingerprint({ format: 1, context }), progressStore = store('collections');
    const initial = { format: 1, context, sequence: 0, cursor: null, done: false, digest: seed };
    const cursorCheck = value => { if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value)
      || Buffer.byteLength(JSON.stringify(value)) > 16384)) throw fail(); };
    function checkProgress(value) {
      if (!value || Object.keys(value).sort().join(',') !== 'context,cursor,digest,done,format,sequence' || value.format !== 1
          || fingerprint(value.context) !== fingerprint(context) || !Number.isSafeInteger(value.sequence) || value.sequence < 0
          || typeof value.done !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.digest || '')) throw fail();
      cursorCheck(value.cursor); if (value.done && value.cursor !== null || !value.sequence && fingerprint(value) !== fingerprint(initial)) throw fail();
      return value;
    }
    let progress = await progressStore.read(id);
    if (!progress.exists) {
      if (progress.revision) throw fail();
      try { await progressStore.compareAndSet(id, 0, initial); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
      progress = await progressStore.read(id);
    }
    // 저장된 페이지 체인으로 위치를 대조한다. 위치만 믿고 원본을 건너뛰지 않는다.
    let verified = initial;
    async function checkPage(page, before) {
      if (!page || Object.keys(page).sort().join(',') !== 'cursor,done,entries,previous' || page.previous !== before.digest
          || typeof page.done !== 'boolean' || !Array.isArray(page.entries) || page.entries.length > 100
          || page.done && page.cursor !== null || !page.done && fingerprint(page.cursor) === fingerprint(before.cursor)) throw fail();
      cursorCheck(page.cursor);
      for (const header of page.entries) {
        if (typeof header?.key !== 'string' || Object.keys(header).sort().join(',') !== 'key,value') throw fail();
        const index = await store(`collectionHeads/${id}`).read(keyId(header.key));
        if (!index.exists || fingerprint(index.value) !== fingerprint(header)) throw fail();
      }
      return { ...initial, sequence: before.sequence + 1, cursor: page.cursor, done: page.done, digest: fingerprint(page) };
    }
    checkProgress(progress.value);
    for (let n = 0; n < progress.value.sequence; n++) {
      const page = await store(`collectionPages/${id}`).read(n.toString(16).padStart(32, '0'));
      if (!page.exists || verified.done) throw fail(); verified = await checkPage(page.value, verified);
    }
    if (fingerprint(verified) !== fingerprint(progress.value)) throw fail();
    while (!progress.value.done) {
      await guard(); const before = checkProgress(progress.value), pageId = before.sequence.toString(16).padStart(32, '0');
      let page = await store(`collectionPages/${id}`).read(pageId);
      if (!page.exists) {
        if (page.revision) throw fail();
        const next = await source(before.cursor);
        if (!next || (!Array.isArray(next.entries) && typeof next.entries?.[Symbol.asyncIterator] !== 'function')
            || next.entries.length > 100 || next.size > 100 || typeof next.done !== 'boolean') throw fail();
        cursorCheck(next.cursor); const headers = [], keys = new Set();
        for await (const raw of next.entries) {
          const [value] = checkEntries([raw]);
          if (typeof value?.key !== 'string' || keys.has(value.key) || keys.size >= 100) throw fail(); keys.add(value.key);
          const headId = keyId(value.key); let header = await store(`collectionHeads/${id}`).read(headId);
          if (!header.exists) {
            if (header.revision) throw fail();
            const valueRef = await writeValue(id, keyId(fingerprint(value)), value), proposed = { key: value.key, value: valueRef };
            try { await store(`collectionHeads/${id}`).compareAndSet(headId, 0, proposed); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
            header = await store(`collectionHeads/${id}`).read(headId);
          }
          if (!header.exists || header.value.key !== value.key) throw fail(); headers.push(header.value);
        }
        const proposed = { previous: before.digest, cursor: next.cursor, done: next.done, entries: headers };
        await guard();
        try { await store(`collectionPages/${id}`).compareAndSet(pageId, 0, proposed); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
        page = await store(`collectionPages/${id}`).read(pageId);
        await onCheckpoint('sourcePageSaved', id);
      }
      if (!page.exists) throw fail(); const next = await checkPage(page.value, before);
      await guard();
      try { await progressStore.compareAndSet(id, progress.revision, next); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
      progress = await progressStore.read(id); checkProgress(progress.value);
      // 다른 SDK가 앞서 진행해도 확정된 페이지를 한 장씩 확인한다.
      if (progress.value.sequence < next.sequence || progress.value.sequence === next.sequence && fingerprint(progress.value) !== fingerprint(next)) throw fail();
      if (progress.value.sequence > next.sequence) return collect(id, context, source, { checkEntries, guard, onCheckpoint });
      await onCheckpoint('sourcePageCheckpointed', id);
    }
    await guard();
    const h = createHash('sha256').update('writer-plan-v1\n'); let count = 0, pages = 0, group = [];
    async function* collected() {
      let before = initial;
      for (let n = 0; n < progress.value.sequence; n++) {
        const page = await store(`collectionPages/${id}`).read(n.toString(16).padStart(32, '0'));
        if (!page.exists || before.done) throw fail(); before = await checkPage(page.value, before);
        yield* page.value.entries;
      }
      if (fingerprint(before) !== fingerprint(progress.value)) throw fail();
    }
    // 정렬 묶음/병합 독자 수를 제한하고 본문은 한 항목씩 확인한다.
    let previous;
    for await (const header of sortReferences(collected(), sortOptions)) {
      const key = header.key;
      if (previous?.key === key) { if (fingerprint(previous) !== fingerprint(header)) throw fail(); continue; }
      previous = header;
      const value = await readValue(id, header.value);
      await immutable(`heads/${id}`, keyId(key), header);
      if (value.key !== key) throw fail(); checkEntries([value]); h.update(fingerprint(value) + '\n'); count++; group.push(header);
      if (group.length === pageSize) { await immutable(`pages/${id}`, pages.toString(16).padStart(32, '0'), group); pages++; group = []; }
    }
    if (group.length) { await immutable(`pages/${id}`, pages.toString(16).padStart(32, '0'), group); pages++; }
    const ref = { format: 1, id, count, pages, digest: h.digest('hex') };
    await guard(); await cleanup.assertAlive(id); await immutable('manifests', id, ref); await verify(ref); return ref;
  }
  return { save, scan, entry, expected, checkpoint, sealExpected, verify, collect, cleanup, digest: digestEntries };
}
module.exports = { createWriterPlanStore, digestEntries };
