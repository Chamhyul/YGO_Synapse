'use strict';
const { createRecordStore, decodeRecord } = require('./recordStore');
const { encodeKey, decodeKey, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const { createStorageAccess } = require('./storageAccess');
const { packEncoded, unpackChecked, analyze, decodeBody } = require('./writerHistoryPayload');
const { createSummaryCodec, validateSummary } = require('./writerHistorySummary');
const fail = () => Object.assign(new Error('전환 이력의 보관 증거를 확인하지 못했습니다.'), { code: 'WRITER_HISTORY_CONFLICT' });
const { AsyncLocalStorage } = require('node:async_hooks');
const kinds = new Set(['operations', 'external']);
function createWriterHistoryStore({ database, runId, timeoutMs = 10000, onAmbiguousWrite } = {}) {
  if (!/^[a-f0-9]{32}$/.test(runId || '')) throw fail();
  const batches = new AsyncLocalStorage();
  // 보관 배치 안에서만 동일 불변 본문의 서버 확정 작업을 공유한다. 배치 간 캐시는 없다.
  const withSession = action => batches.getStore() ? action() : batches.run(new Map(), action);
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const path = kind => { if (!kinds.has(kind)) throw fail(); return `profileWriterHistory/${encodeKey(runId)}/${kind}`; };
  const stores = Object.fromEntries([...kinds].map(kind => [kind, createRecordStore({ database, path: path(kind), timeoutMs, onAmbiguousWrite })]));
  const bodies = createRecordStore({ database, path: `profileWriterHistory/${encodeKey(runId)}/bodies`, timeoutMs, onAmbiguousWrite });
  const summaryPath = kind => { path(kind); return `profileWriterHistory/${encodeKey(runId)}/summaries/${kind}`; };
  const summaryCodecs = Object.fromEntries([...kinds].map(kind => [kind, createSummaryCodec({ path: summaryPath(kind), kind })]));
  const summaries = Object.fromEntries([...kinds].map(kind => [kind, createRecordStore({ database, path: summaryPath(kind), timeoutMs, onAmbiguousWrite, payloadCodec: summaryCodecs[kind] })]));
  const checkId = id => { if (!/^[a-f0-9]{32}$/.test(id || '')) throw fail(); };
  function checkValue(value, kind, id) {
    if (value?.id !== id || (kind === 'operations' ? !['completed', 'cancelled'].includes(value.status)
      : !['completed', 'recovered'].includes(value.status))) throw fail();
  }
  async function parse(record, kind, id) {
    if (!record.exists) { if (record.revision !== 0) throw fail(); return undefined; }
    const envelope = record.value;
    if (![1, 2].includes(envelope?.format) || envelope.kind !== kind || envelope.value?.id !== id
        || !/^[a-f0-9]{64}$/.test(envelope.digest)
        || Object.keys(envelope).length !== (envelope.format === 1 ? 4 : 5)) throw fail();
    const parsed = envelope.format === 1 ? { value: envelope.value, stats: analyze(envelope.value) } : await unpackChecked(envelope, async digest => {
      const record = await bodies.read(digest); if (!record.exists) throw fail(); return record.value;
    });
    if (envelope.digest !== parsed.stats.digest) throw fail();
    checkValue(parsed.value, kind, id); return parsed;
  }
  async function immutable(store, id, value, verify = saved => fingerprint(saved) === fingerprint(value)) {
    let saved;
    try { saved = await store.createIfAbsent(id, value); }
    catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; saved = await store.read(id); }
    // 성공 CAS의 서버 확정 snapshot을 대조한다. 경합에서는 실제 저장된 원문을 다시 읽는다.
    if (!saved.exists || !verify(saved.value)) throw fail();
  }
  function summary(kind, value, stats) {
    const result = { id: value.id, kind, status: value.status, digest: stats.digest, bytes: stats.bytes };
    if (['legacy', 'rtdb'].includes(value.backend)) result.backend = value.backend;
    for (const key of ['epoch', 'capturedSequence']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
    if (/^[a-f0-9]{32}$/.test(value.recoveryId || '')) result.recoveryId = value.recoveryId;
    return result;
  }
  function parseSummary(record, kind, id) {
    if (!record.exists) throw fail(); return validateSummary(record.value, kind, id);
  }
  async function putSummary(kind, value, stats) {
    const s = summary(kind, value, stats), e = { format: 1, kind, value: s, digest: fingerprint(s) };
    await immutable(summaries[kind], value.id, e, saved => {
      parseSummary({ exists: true, value: saved }, kind, value.id); return fingerprint(saved) === fingerprint(e);
    });
  }
  async function readInfo(kind, id) { checkId(id); path(kind); return parse(await stores[kind].read(id), kind, id); }
  async function get(kind, id) { return (await readInfo(kind, id))?.value; }
  async function put(kind, id, value) {
    checkId(id); path(kind);
    const stats = analyze(value); checkValue(value, kind, id);
    // 승인 유실·동시 보관 뒤에는 같은 불변 원문만 확인한다. 보관 주소를 덮어쓰거나 삭제하지 않는다.
    const current = await readInfo(kind, id);
    if (current) { if (current.stats.digest !== stats.digest) throw fail(); await putSummary(kind, current.value, current.stats); return; }
    // 입력은 첫 await 전에 인코딩한 소유 자료로 고정하고 이후 호출자 객체를 다시 읽지 않는다.
    const packed = packEncoded(stats.encoded);
    for (const [digest, body] of packed.bodies) {
      const batch = batches.getStore(), cached = batch?.get(digest);
      if (cached && cached.encoded !== body.encoded) throw fail();
      let confirmed = cached?.confirmed;
      if (!confirmed) {
        confirmed = immutable(bodies, digest, body, saved => {
          decodeBody(saved, digest); return saved.encoded === body.encoded;
        });
        batch?.set(digest, { encoded: body.encoded, confirmed });
      }
      await confirmed;
    }
    const savedEnvelope = { format: 2, kind, value: packed.value, refs: packed.refs, digest: stats.digest };
    // 본문 서버 승인 뒤에만 공개한다. 공개 후 본문은 실제 DB에서 재조회하여 전체 원문을 대조한다.
    let record;
    try { record = await stores[kind].createIfAbsent(id, savedEnvelope); }
    catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; record = await stores[kind].read(id); }
    const saved = await parse(record, kind, id); if (!saved || saved.stats.digest !== stats.digest) throw fail();
    await putSummary(kind, saved.value, saved.stats);
  }
  async function recordsPage(kind, { cursor, limit = 32 } = {}, metadataOnly = false, withStats = false) {
    const base = metadataOnly ? summaryPath(kind) : path(kind); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw fail();
    if (cursor !== undefined) checkId(cursor);
    let query = database.ref(base).orderByKey();
    if (cursor !== undefined) query = query.startAt(encodeKey(cursor));
    const snapshot = await access.guarded(query.limitToFirst(limit + (cursor === undefined ? 1 : 2)).get(), false), items = [];
    const records = []; snapshot.forEach(child => {
      const id = decodeKey(child.key); checkId(id); if (id === cursor) return;
      records.push({ id, record: decodeRecord(child.val(), { path: `${base}/${child.key}`, payloadCodec: metadataOnly ? summaryCodecs[kind] : { decode: decodeValue } }) });
    });
    // lookahead는 다음 페이지의 존재만 판단한다. 불필요한 상세 본문을 복원하지 않는다.
    for (const { id, record } of records.slice(0, limit)) {
      const parsed = metadataOnly ? { value: parseSummary(record, kind, id) } : await parse(record, kind, id);
      if (!parsed) throw fail(); items.push({ id, value: parsed.value, ...(withStats ? { stats: parsed.stats } : {}) });
    }
    return { items, cursor: records.length > limit ? items[limit - 1].id : null };
  }
  // 기존 page의 원문 반환 계약은 유지한다. 요약 전용 경로는 상세 경로를 읽지 않는다.
  const page = (kind, options) => recordsPage(kind, options);
  const summaryPage = async (kind, options) => ({ ...await recordsPage(kind, options, true), coverage: 'indexed' });
  // 구형 원문은 덮어쓰지 않는다. 명시적인 제한 배치 준비가 끝난 범위만 요약 목록에 포함된다.
  async function indexPage(kind, options) {
    const batch = await recordsPage(kind, options, false, true);
    for (const item of batch.items) await putSummary(kind, item.value, item.stats);
    return { indexed: batch.items.length, cursor: batch.cursor };
  }
  return { get, put, page, summaryPage, indexPage, withSession };
}
module.exports = { createWriterHistoryStore };
